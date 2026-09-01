// lib/brand-expression-extractor.ts

/**
 * 브랜드 한 줄 로직 4-1단계 — 인지 질문 응답에서 표현 추출 (2026-09-01)
 * ═══════════════════════════════════════════════════════
 *
 * 원안(브랜드 한 줄 생성 로직 v1.0) 2번의 "특징 표현 추출"을 구현한다.
 * lib/keyword-extractor.ts와 문단 자르는 방식(citation-linker 재사용)은
 * 동일하지만, 그쪽은 표현 문자열만 뽑는 반면 여기는 각 표현에 문장·감정·
 * 브랜드 사실 충돌 여부까지 같이 뽑는다 — brand_expressions 테이블 스펙이
 * 더 풍부해서다.
 *
 * ⚠️ "유도된 표현인지"(is_induced)는 LLM에게 안 맡긴다. 작업지시서
 * v1.1 ③이 "질문 문장의 명사 단위 완전 일치"로 좁게 정의했는데, 이건
 * 의미 판단이 아니라 문자열 비교라서 코드로 결정적으로(재현 가능하게)
 * 계산하는 쪽이 keyword-extractor.ts의 "top N을 LLM에 안 맡긴다" 원칙과
 * 같은 이유로 더 낫다. 아래 isInducedExpression()이 그 역할.
 *
 * ⚠️ 아직 실측(live API) 검증 전이다 — keyword-extractor.ts와 같은 상태.
 */

import { buildBrandParagraphs, type BrandParagraph } from './keyword-extractor';
import { ANTHROPIC_API_URL, ANTHROPIC_MODEL, ANTHROPIC_VERSION } from './llm-config';

export { buildBrandParagraphs, type BrandParagraph };

// ── 유도 판정 (코드, LLM 아님) ──

/**
 * 질문 문장에 이미 있는 표현을 AI가 그대로 반복했으면 유도된 표현으로 본다.
 * v1은 좁게: 공백을 무시한 완전 부분 문자열 일치만 유도로 잡는다.
 * ("임플란트"↔"임플란트 시술"처럼 표현이 다르면 이번 버전에서는 유도로 안 잡음
 *  — 작업지시서 v1.1 ③, 실데이터 보고 필요시 넓힐 예정)
 */
export function isInducedExpression(expression: string, queryText: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, '');
  const normExpr = normalize(expression);
  if (!normExpr) return false;
  return normalize(queryText).includes(normExpr);
}

function parseSentiment(value: unknown): '긍정' | '중립' | '부정' | null {
  if (value === '긍정' || value === '중립' || value === '부정') return value;
  return null;
}

// ── LLM 호출 결과 타입 ──

export interface ExtractedExpressionItem {
  expression: string;        // AI가 사용한 원래 표현 (원문 그대로)
  sourceSentence: string;    // 표현이 포함된 실제 문장 (원문 그대로)
  sentiment: '긍정' | '중립' | '부정' | null;
  conflictsWithBrandFacts: boolean;
}

export interface ParagraphExpressions {
  snapshotId: string;
  items: ExtractedExpressionItem[];
}

function buildExtractionPrompt(
  brandName: string,
  paragraphs: BrandParagraph[],
  brandFacts: string | null
): string {
  const numberedParagraphs = paragraphs
    .map((p, i) => `[문단 ${i}]\n${p.paragraphText}`)
    .join('\n\n');

  const brandFactsBlock = brandFacts
    ? `\n\n브랜드가 제공한 사실 정보(충돌 여부 판단에만 사용):\n${brandFacts}`
    : '';

  return `아래는 AI 답변 엔진이 "${brandName}"에 대해 언급한 문단들이다. 문단은 여러 개고, 각 문단은 [문단 N] 형식으로 번호가 붙어 있다.

각 문단에서, "${brandName}"을(를) 설명하거나 특징짓는 데 쓰인 표현을 찾아서 각각에 대해 아래 정보를 보고하라.

1. expression: 원문에 실제로 쓰인 표현을 "그대로" 뽑아라(짧은 어구, 문장 전체 아님). 네가 다른 말로 바꿔 쓰지 마라.
2. source_sentence: 그 표현이 포함된 문장 전체를 원문 그대로 인용하라.
3. sentiment: 그 표현이 "${brandName}"을 긍정적으로 묘사하면 '긍정', 그냥 사실 서술이면 '중립', 부정적으로 묘사하면 '부정'.
4. conflicts_with_brand_facts: 아래 "브랜드가 제공한 사실 정보"와 이 표현이 명백히 모순되면 true, 아니면(또는 사실 정보가 없으면) false.

규칙:
- 그 문단이 "${brandName}"이 아니라 다른 병원·브랜드를 설명하는 내용이면, "${brandName}"과 무관한 표현은 절대 포함하지 마라.
- 문단이 이름만 나열하고 아무 설명이 없으면 그 문단은 빈 배열로 남겨라.
- 확실하지 않으면 포함하지 마라. 없는 내용을 만들어내지 마라.${brandFactsBlock}

문단:
${numberedParagraphs}`;
}

/**
 * 문단들을 한 번에 LLM에 보내서, 문단별로 "브랜드를 설명한 표현 + 문장 +
 * 감정 + 사실 충돌 여부"를 구조화된 형태로 받는다. 호출은 이 함수 1번 =
 * API 요청 1번(keyword-extractor.ts 규칙 A와 동일 — 기간 단위로 한 번).
 */
export async function extractBrandExpressionsDetailed(
  brandName: string,
  paragraphs: BrandParagraph[],
  brandFacts: string | null
): Promise<ParagraphExpressions[]> {
  if (paragraphs.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const prompt = buildExtractionPrompt(brandName, paragraphs, brandFacts);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      tools: [
        {
          name: 'report_brand_expressions_detailed',
          description:
            '각 문단에서 브랜드를 설명한 표현을 문단 번호(index)와 함께, 문장·감정·사실충돌 여부까지 같이 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', description: '[문단 N]의 N 값' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          expression: { type: 'string' },
                          source_sentence: { type: 'string' },
                          sentiment: { type: 'string', enum: ['긍정', '중립', '부정'] },
                          conflicts_with_brand_facts: { type: 'boolean' },
                        },
                        required: ['expression', 'source_sentence', 'sentiment', 'conflicts_with_brand_facts'],
                      },
                      description: '이 문단에서 뽑은 표현들. 없으면 빈 배열.',
                    },
                  },
                  required: ['index', 'items'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_brand_expressions_detailed' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const blocks: { type: string; input?: unknown }[] = data.content ?? [];

  const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
  if (!toolUseBlock || typeof toolUseBlock.input !== 'object' || toolUseBlock.input === null) {
    throw new Error('LLM 응답에서 report_brand_expressions_detailed 도구 호출을 찾지 못했습니다.');
  }

  const rawResults = (toolUseBlock.input as { results?: unknown }).results;
  if (!Array.isArray(rawResults)) {
    throw new Error('LLM 응답의 results 필드가 배열이 아닙니다.');
  }

  const output: ParagraphExpressions[] = [];

  for (const item of rawResults) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { index?: unknown }).index !== 'number'
    ) {
      continue;
    }

    const index = (item as { index: number }).index;
    const paragraph = paragraphs[index];
    if (!paragraph) continue;

    const rawItems = (item as { items?: unknown }).items;
    const items: ExtractedExpressionItem[] = Array.isArray(rawItems)
      ? rawItems
          .filter(
            (it): it is Record<string, unknown> =>
              typeof it === 'object' &&
              it !== null &&
              typeof (it as Record<string, unknown>).expression === 'string' &&
              typeof (it as Record<string, unknown>).source_sentence === 'string'
          )
          .map(
            (it): ExtractedExpressionItem => ({
              expression: (it.expression as string).trim(),
              sourceSentence: (it.source_sentence as string).trim(),
              sentiment: parseSentiment(it.sentiment),
              conflictsWithBrandFacts: it.conflicts_with_brand_facts === true,
            })
          )
          .filter((it) => it.expression.length > 0)
      : [];

    output.push({ snapshotId: paragraph.snapshotId, items });
  }

  return output;
}

/**
 * 같은 문단(=같은 snapshot) 안에서 완전히 같은 표현 문자열이 여러 번
 * 나오면 하나로 센다(원안 2번 "같은 답변에서 같은 특징이 여러 번 나와도
 * 한 번으로 센다"). LLM이 중복을 안 돌려주는 게 이상적이지만, 방어적으로
 * 여기서도 한 번 더 걸러준다.
 */
export function dedupeExpressionsWithinSnapshot(
  items: ExtractedExpressionItem[]
): ExtractedExpressionItem[] {
  const seen = new Set<string>();
  const result: ExtractedExpressionItem[] = [];
  for (const item of items) {
    const key = item.expression.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
