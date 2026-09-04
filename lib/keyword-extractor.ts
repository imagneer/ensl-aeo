// lib/keyword-extractor.ts

/**
 * 노출 키워드 추출 (Day 12) — LLM 기반
 * ═══════════════════════════════════════════════════════
 *
 * PRD 기능A 표의 "노출 키워드" 항목(AI가 브랜드를 설명할 때 쓴 표현,
 * 예: "서울대, 협진, 365, 디지털")을 뽑아서 aggregated_metrics.top_keywords에
 * 채우는 게 목적이다. 지금까지 만든 노출률·순위·경쟁사 데이터는 전부
 * "얼마나 나왔나"였는데, 이건 유일하게 "AI가 브랜드를 뭐라고 설명하나"를 본다.
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (2026-08-18 루아 확인, Day 12)
 * ─────────────────────────────────────────────────────────
 *  A. 저장 단위는 기간(aggregated_metrics, daily 레벨)이지 관측치(mentions)가
 *     아니다. LLM 호출도 (쿼리, 엔진, daily 기간) 조합당 1번만 한다 — 그 기간에
 *     모인 문단들을 전부 한 번의 요청에 넣어서 보낸다.
 *     ⚠️ 그 대가: "어느 배치(아침/점심/저녁)에서 표현이 갈렸나" 같은 하루 안의
 *     세부 변화는 못 본다. PRD가 요구하는 건 "타임라인(언제 등장/소멸했는지)"뿐이라
 *     daily 단위로 충분하다고 판단했다. batch 레벨은 계산하지 않는다.
 *
 *  B. LLM에게는 브랜드 이름이 있는 **문단만** 잘라서 준다. 답변 전체를 통째로
 *     주지 않는다. 경쟁사 얘기가 섞이면 헷갈릴 수 있고, 맥락이 넓을수록
 *     LLM이 지어낼(환각) 여지도 커지기 때문이다. 문단 나누는 기준은
 *     citation-linker.ts와 동일한 로직을 그대로 재사용한다 — getParagraphText().
 *
 *  C. LLM은 문단에서 표현을 "그대로" 뽑아야 한다(추출적, extractive). LLM이
 *     자기 말로 바꿔 쓰지(paraphrase) 않는다 — 그래야 나중에 문자열로 세는
 *     빈도 카운트가 의미를 가진다.
 *
 *  D. "top N개를 뽑는 것"은 LLM에게 맡기지 않는다. LLM은 문단마다 표현이
 *     있는지/뭔지만 판단하고, 빈도를 세서 상위 N개를 정하는 건 코드가 한다
 *     (결정적 계산, 재현 가능).
 *
 *  E. top N = 5. 5개 미만이면 있는 만큼만 돌려준다.
 *
 *  F. null과 빈 배열([])의 뜻이 다르다: null = 그 기간에 브랜드가 아예 언급
 *     안 됨(계산 불가), [] = 언급은 됐는데 설명 표현이 하나도 없었음.
 *
 * ⚠️ 아직 실측(live API) 검증 전이다. 순수 로직(문단 추출·빈도 계산)만
 *    합성 데이터로 확인했고, LLM 호출부는 실제 API로 안 돌려봤다.
 */

import { computeBrandSegments, getSegmentText } from './citation-linker';

import { ANTHROPIC_API_URL, ANTHROPIC_MODEL, ANTHROPIC_VERSION } from './llm-config';
import { logLlmCallSuccess, logLlmCallFailure, type LlmCallKind, type LlmRunKind } from './llm-usage';

// ── 입력 타입 ──

/**
 * "브랜드가 언급된 문단" 1건. 어느 관측(snapshot)에서 나온 문단인지
 * snapshotId로 표시해둔다 — 저장은 안 하지만, 나중에 "이 표현이 어느 관측에서
 * 나왔는지" 로그로 추적하거나 디버깅할 때 필요하다.
 */
export interface BrandParagraph {
    snapshotId: string;
    paragraphText: string;
}

export function buildBrandParagraphs(
  snapshots: {
    snapshotId: string;
    rawText: string;
    targetBrandName: string;
    allMentions: { brandName: string; position: number }[];
  }[]
): BrandParagraph[] {
  const result: BrandParagraph[] = [];

  for (const s of snapshots) {
    const segments = computeBrandSegments(s.rawText, s.allMentions);
    const segment = segments.find((seg) => seg.anchorBrandName === s.targetBrandName);
    if (!segment) continue; // 타겟 브랜드가 이 답변에 없으면 건너뜀

    const paragraphText = getSegmentText(s.rawText, segment);
    result.push({ snapshotId: s.snapshotId, paragraphText });
  }

  return result;
}

// ── LLM 호출 결과 타입 ──

/** LLM이 문단 하나에서 뽑아낸 표현들 */
export interface ParagraphKeywords {
    snapshotId: string;
    /** 이 문단에서 브랜드를 설명한 표현들. 원문에서 그대로 뽑은 것 - 없으면 빈 배열 */
    expressions: string[];
}

//const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * 왜 수집용 어댑터(claude-haiku-4-5-20251001)와 같은 모델을 쓰는가:
 * 이 호출은 웹검색이 필요 없는 순수 텍스트 분석이라 더 저렴한 모델도 고려할
 * 수 있지만, 이미 검증된 모델을 재사용하는 게 "새 모델의 미검증 특성"이라는
 * 변수를 하나 줄여준다. 비용 문제가 실측으로 확인되면 그때 재검토.
 */
//const MODEL = 'claude-haiku-4-5-20251001';
//const ANTHROPIC_VERSION = '2023-06-01';

/**
 * LLM에게 보낼 프롬프트를 만든다. 순수 함수라 API 호출 없이도 텍스트만
 * 눈으로 확인해볼 수 있다 (console.log(buildExtractionPrompt(...)) 해보면 됨).
 *
 * 문단마다 번호를 매겨서 프롬프트에 넣는다. LLM 응답도 이 번호(index)로
 * 돌아오게 강제하고, 우리 쪽에서 index → paragraphs[index].snapshotId로
 * 다시 짝짓는다. (LLM에게 snapshotId 문자열을 그대로 돌려달라고 하는 것보다
 * 정수 index가 오타·변형 위험이 없어서 더 안전하다)
 */
function buildExtractionPrompt(brandName: string, paragraphs: BrandParagraph[]): string {
    const numberedParagraphs = paragraphs
    .map((p, i) => `[문단 ${i}]\n${p.paragraphText}`)
    .join('\n\n'); 

    return `아래는 AI 답변 엔진이 "${brandName}"에 대해 언급한 문단들이다. 문단은 여러 개고, 각 문단은 [문단 N] 형식으로 번호가 붙어 있다.

각 문단에서, "${brandName}"을(를) 설명하거나 특징짓는 데 쓰인 표현만 뽑아라. 규칙:
1. 원문에 실제로 쓰인 표현을 "그대로" 뽑아라. 네가 다른 말로 바꿔 쓰지 마라.
2. 표현은 짧은 어구(단어 몇 개 정도)로 뽑아라. 문장 전체를 통째로 뽑지 마라.
3. 그 문단이 "${brandName}"이 아니라 다른 병원·브랜드를 설명하는 내용이면, "${brandName}"과 무관한 표현은 절대 포함하지 마라.
4. 문단이 이름만 나열하고 아무 설명이 없으면(예: 목록에 이름만 있는 경우), 그 문단은 빈 배열로 남겨라.
5. 확실하지 않으면 포함하지 마라. 없는 내용을 만들어내지 마라.

문단:
${numberedParagraphs}`;
}
/**
 * 문단들을 한 번에 LLM에 보내서, 문단별로 "브랜드를 설명한 표현"을 구조화된
 * 형태로 받는다. 호출은 이 함수 1번 = API 요청 1번 (규칙 A).
 *
 * ⚠️ 미검증(실측 전): 프롬프트가 의도대로 동작하는지, 특히 "표현이 없으면
 * 빈 배열"을 LLM이 실제로 잘 지키는지(억지로 뭔가 만들어내지 않는지)는
 * 아직 실제 응답으로 확인 못했다. 첫 실행 결과를 반드시 눈으로 검산할 것.
 *
 * @param brandName 문단 안에서 설명 대상이 되는 브랜드의 정식 명칭
 * @param paragraphs buildBrandParagraphs()가 만든 문단 목록 (1개 이상이어야 함)
 * @param usageContext 호출 1건 usage 로깅용 맥락(lib/llm-usage.ts, 2026-09-04
 *   예산 사고 후속 안전장치). 생략하면 kind='target', runKind='manual'로 남는다 —
 *   app/api/test-keyword-extraction처럼 집계 실행 밖에서 단발로 부르는 곳용.
 */
export async function extractExpressionsFromParagraphs(
  brandName: string,
  paragraphs: BrandParagraph[],
  usageContext?: {
    kind?: LlmCallKind;
    runKind?: LlmRunKind;
    brandId?: string | null;
    queryId?: string | null;
    engine?: string | null;
  }
): Promise<ParagraphKeywords[]> {
  if (paragraphs.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const logCtx = {
    site: 'keyword-extractor',
    model: ANTHROPIC_MODEL,
    kind: usageContext?.kind ?? ('target' as LlmCallKind),
    runKind: usageContext?.runKind ?? ('manual' as LlmRunKind),
    brandName,
    brandId: usageContext?.brandId ?? null,
    queryId: usageContext?.queryId ?? null,
    engine: usageContext?.engine ?? null,
  };

  const prompt = buildExtractionPrompt(brandName, paragraphs);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
      // 수집용 어댑터가 web_search를 tool_choice로 강제하는 것과 같은 이유로,
      // 여기서도 구조화된 JSON 출력을 "선택"이 아니라 "강제"한다.
      tools: [
        {
          name: 'report_brand_expressions',
          description:
            '각 문단에서 브랜드를 설명한 표현을 문단 번호(index)와 함께 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: {
                      type: 'integer',
                      description: '[문단 N]의 N 값',
                    },
                    expressions: {
                      type: 'array',
                      items: { type: 'string' },
                      description: '이 문단에서 뽑은 표현들. 없으면 빈 배열.',
                    },
                  },
                  required: ['index', 'expressions'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_brand_expressions' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logLlmCallFailure(logCtx, response.status, errorBody);
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (data.usage) logLlmCallSuccess(logCtx, data.usage);

// 응답 파싱은 다음 조각(3/3)에서 이어감 — 일단 여기까지만.
//  console.log('API 원본 응답(임시):', JSON.stringify(data, null, 2));
// return [];
//}
  const blocks: { type: string; input?: unknown }[] = data.content ?? [];

  const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
  if (!toolUseBlock || typeof toolUseBlock.input !== 'object' || toolUseBlock.input === null) {
    // tool_choice로 강제했으므로 정상 응답이면 항상 있어야 한다.
    // 없으면 API 쪽 이상 응답이라는 뜻 — 조용히 빈 배열을 돌려주지 않고 실패시킨다
    // (CLAUDE.md "실패를 조용히 삼키지 않는다" 원칙).
    throw new Error('LLM 응답에서 report_brand_expressions 도구 호출을 찾지 못했습니다.');
  }

  const rawResults = (toolUseBlock.input as { results?: unknown }).results;
  if (!Array.isArray(rawResults)) {
    throw new Error('LLM 응답의 results 필드가 배열이 아닙니다.');
  }

  const output: ParagraphKeywords[] = [];

  for (const item of rawResults) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { index?: unknown }).index !== 'number'
    ) {
      continue; // 형식이 어긋난 항목은 건너뜀 (전체를 실패시키진 않는다 — 부분 성공도 의미 있음)
    }

    const index = (item as { index: number }).index;
    const paragraph = paragraphs[index];
    if (!paragraph) continue; // LLM이 존재하지 않는 index를 줬을 경우 방어

    const expressionsRaw = (item as { expressions?: unknown }).expressions;
    const expressions = Array.isArray(expressionsRaw)
      ? expressionsRaw.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
      : [];

    output.push({ snapshotId: paragraph.snapshotId, expressions });
  }

  return output;
}
// ── 빈도 집계 (LLM을 다시 부르지 않는다 — 규칙 D) ──

export interface TopKeyword {
  keyword: string;
  count: number;
}

export function countTopKeywords(results: ParagraphKeywords[], topN: number): TopKeyword[] {
  const countByKeyword = new Map<string, number>();
  const firstSeenOrder: string[] = [];

  for (const r of results) {
    for (const raw of r.expressions) {
      const keyword = raw.trim();
      if (keyword.length === 0) continue;

      if (!countByKeyword.has(keyword)) {
        countByKeyword.set(keyword, 0);
        firstSeenOrder.push(keyword);
      }
      countByKeyword.set(keyword, countByKeyword.get(keyword)! + 1);
    }
  }

  const sorted = firstSeenOrder
    .map((keyword) => ({ keyword, count: countByKeyword.get(keyword)! }))
    .sort((a, b) => b.count - a.count);

  return sorted.slice(0, topN);
}