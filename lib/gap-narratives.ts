// lib/gap-narratives.ts

/**
 * Day22 후속 작업지시서(Day22_작업지시서_후속_문구생성및화면구현.md §1) —
 * 간극 화면의 why-box(왜 이런 판정인지) / counter-box(반대 증거와 제외된
 * 사례) 문구를 특징 1개당 1콜로 생성한다.
 *
 * ⚠️ "선택"·"골랐다" 같은 AI 내부 인과 언어, "확신 못해서"·"인과관계가
 * 불분명해서" 같은 속마음 언어를 절대 쓰면 안 된다 — 이 화면 전체가
 * "AI가 실제로 왜 골랐는지는 검증 불가능하다, 텍스트 구조만 본다"는
 * 원칙(매니페스토 §4) 위에 서 있어서, 문구 자체가 이 원칙을 어기면
 * 판정 로직이 아무리 정확해도 소용없다.
 *
 * 생성(Haiku) → 검수(Sonnet) 분리, brand-one-liner.ts의
 * writeOneLiner/reviewOneLiner와 같은 "생성 1회 + 실패 시 재시도 1회,
 * 그래도 실패하면 포기" 패턴을 그대로 재사용한다(작업지시서 §1-5).
 */

import { ANTHROPIC_API_URL, ANTHROPIC_MODEL, ANTHROPIC_MODEL_SONNET, ANTHROPIC_VERSION } from './llm-config';
import { logLlmCallSuccess, logLlmCallFailure, startUsageRun, getUsageRunSummary, type LlmRunKind } from './llm-usage';
import { retryWithBackoff, isRetryableLLMError } from './retry';
import { MIN_RUNS_FOR_JUDGMENT } from './badge-thresholds';
import { MAX_LLM_CALLS_PER_RUN } from './llm-config';
import {
  fetchKnownBrands,
  fetchPlacementMentionsForRoleJudgment,
  fetchMentionFeatureRolesForPlacement,
  saveGapFeatureNarrative,
  type MentionFeatureRoleRow,
  type GapFeatureNarrativeCounterCase,
} from './supabase';
import { getBrandSegmentText, fetchGapFeatureUniverse } from './mention-feature-roles';
import { buildFeatureGapStats } from './gap';

const MAX_SNIPPETS_PER_ROLE = 3;

interface Snippet {
  mentionId: string;
  text: string;
}

interface FeatureSnippets {
  reasonStated: Snippet[];
  coMentioned: Snippet[];
}

interface NarrativeDraft {
  whyBoxSentences: string[];
  counterBoxCases: { snippetIndex: number; explanation: string }[];
}

export interface FeatureNarrativeSaveResult {
  featureText: string;
  saved: boolean;
  reason?: string; // 저장 실패(검수 탈락 등) 사유
  generateCalls: number;
  reviewCalls: number;
}

function buildUsageLogCtx(site: string, model: string, brandName: string, brandId: string, runKind: LlmRunKind) {
  return { site, model, kind: 'placementRole' as const, runKind, brandName, brandId, queryId: null, engine: null };
}

/** feature_text 일치로 이 특징에 해당하는 mention들만 추려서 구간 텍스트를 붙인다. */
function buildFeatureSnippets(
  featureText: string,
  roleRows: MentionFeatureRoleRow[],
  segmentByMention: Map<string, string>
): FeatureSnippets {
  const reasonStated: Snippet[] = [];
  const coMentioned: Snippet[] = [];
  for (const row of roleRows) {
    if (row.featureText !== featureText) continue;
    const text = segmentByMention.get(row.mentionId);
    if (!text) continue;
    const list = row.role === 'reason_stated' ? reasonStated : coMentioned;
    if (list.length < MAX_SNIPPETS_PER_ROLE) list.push({ mentionId: row.mentionId, text });
  }
  return { reasonStated, coMentioned };
}

function buildGenerationPrompt(
  brandName: string,
  featureName: string,
  reasonStatedCount: number,
  coMentionedCount: number,
  snippets: FeatureSnippets
): string {
  const reasonList =
    snippets.reasonStated.length > 0
      ? snippets.reasonStated.map((s, i) => `[근거 연결 사례 ${i}]\n${s.text}`).join('\n\n')
      : '(근거 연결 사례 없음)';
  const coMentionList = snippets.coMentioned
    .map((s, i) => `[동시 언급 사례 ${i}]\n${s.text}`)
    .join('\n\n');

  return `"${brandName}"의 특징 "${featureName}"에 대한 자리질문(추천형 질문) 답변 판정 결과다.

- 근거로 명시됨(reason_stated): ${reasonStatedCount}건
- 그냥 함께 언급됨(co_mentioned): ${coMentionedCount}건

${reasonList}

${coMentionList || '(동시 언급 사례 없음)'}

이 데이터를 바탕으로 두 가지를 작성해라.

**1) why-box 문장 (1~2개)**
- ${
    reasonStatedCount > 0
      ? '근거 연결 사례가 실제로 있으니, 이걸 근거로 "답변 문장에서 인과 연결 표현으로 묶여 있다"는 취지로 작성해라.'
      : '근거 연결 사례가 0건이니, "함께 언급되긴 하지만 답변 문장에서 인과 연결 표현으로 묶인 적은 없다"는 취지로 작성해라.'
  }
- **절대 금지**: "선택", "골랐다", "선호한다" 같은 AI 내부 인과 언어. 판정 대상은 텍스트 구조지 AI의 속마음이 아니다.
- 확신 있는 단정이 아니라 "지금까지 관측된 사실"로 서술해라.

**2) counter-box 사례 (0~${snippets.coMentioned.length}개, 최대 3개)**
- 위 "동시 언급 사례" 중에서, 사람이 보기엔 그럴듯하지만 근거 연결 표현이 없어서 근거로 인정 안 된 것을 골라 설명해라.
- 각 설명은 **반드시 "답변 문장에 근거 연결 표현이 없어서 근거로 보지 않았다"는 취지**로 써라.
- **절대 금지**: "확신 못해서", "인과관계가 불분명해서", "AI가 의도한 게 아니라서" 같은 표현. 판정 기준은 텍스트 구조(연결 표현 유무)지 확신의 정도나 AI의 의도가 아니다.
- 동시 언급 사례가 없으면 빈 배열로 둬라.`;
}

async function generateFeatureNarrative(
  brandName: string,
  brandId: string,
  featureName: string,
  reasonStatedCount: number,
  coMentionedCount: number,
  snippets: FeatureSnippets,
  runKind: LlmRunKind
): Promise<NarrativeDraft> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

  const logCtx = buildUsageLogCtx('gap-narratives:generate', ANTHROPIC_MODEL, brandName, brandId, runKind);
  const prompt = buildGenerationPrompt(brandName, featureName, reasonStatedCount, coMentionedCount, snippets);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      tools: [
        {
          name: 'report_narrative_draft',
          description: 'why-box 문장과 counter-box 사례 설명을 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              why_box_sentences: { type: 'array', items: { type: 'string' } },
              counter_box_cases: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    snippet_index: { type: 'integer', description: '동시 언급 사례의 [N] 값' },
                    explanation: { type: 'string' },
                  },
                  required: ['snippet_index', 'explanation'],
                },
              },
            },
            required: ['why_box_sentences', 'counter_box_cases'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_narrative_draft' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logLlmCallFailure(logCtx, response.status, errorBody);
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (data.usage) logLlmCallSuccess(logCtx, data.usage);

  const toolUse = data.content?.find((c: { type: string }) => c.type === 'tool_use');
  const input = toolUse?.input as
    | { why_box_sentences?: unknown; counter_box_cases?: unknown }
    | undefined;

  const whyBoxSentences = Array.isArray(input?.why_box_sentences)
    ? input!.why_box_sentences.filter((s): s is string => typeof s === 'string')
    : [];
  const rawCases = Array.isArray(input?.counter_box_cases) ? input!.counter_box_cases : [];
  const counterBoxCases = (rawCases as { snippet_index: number; explanation: string }[])
    .filter((c) => snippets.coMentioned[c.snippet_index] !== undefined)
    .map((c) => ({ snippetIndex: c.snippet_index, explanation: c.explanation }));

  return { whyBoxSentences, counterBoxCases };
}

interface ReviewResult {
  passed: boolean;
  reason: string;
}

function buildReviewPrompt(featureName: string, draft: NarrativeDraft, snippets: FeatureSnippets): string {
  const counterText = draft.counterBoxCases
    .map((c) => `- [사례 ${c.snippetIndex}] ${c.explanation}`)
    .join('\n');

  return `아래는 "${featureName}" 특징에 대해 생성된 화면 문구 초안이다. 매니페스토 위반 여부를 검수해라.

why-box 문장:
${draft.whyBoxSentences.map((s) => `- ${s}`).join('\n')}

counter-box 설명:
${counterText || '(없음)'}

**탈락 기준(하나라도 걸리면 불합격)**:
1. why-box나 counter-box 설명에 "선택", "골랐다", "선호한다" 같은 AI 내부 인과 언어가 있는가?
2. counter-box 설명에 "확신 못해서", "인과관계가 불분명해서", "AI가 의도한 게 아니라서" 같은 속마음 언어가 있는가? (반드시 "답변 문장에 근거 연결 표현이 없어서"류로만 서술해야 한다)
3. 근거 없이 단정적으로 확신하는 표현이 있는가? (예: "확실히", "무조건")

문제 없으면 passed=true, 문제 있으면 passed=false와 구체적 이유를 보고해라.`;
}

async function reviewFeatureNarrative(
  brandName: string,
  brandId: string,
  featureName: string,
  draft: NarrativeDraft,
  snippets: FeatureSnippets,
  runKind: LlmRunKind
): Promise<ReviewResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

  const logCtx = buildUsageLogCtx('gap-narratives:review', ANTHROPIC_MODEL_SONNET, brandName, brandId, runKind);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL_SONNET,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildReviewPrompt(featureName, draft, snippets) }],
      tools: [
        {
          name: 'report_review_result',
          description: '검수 결과를 보고한다.',
          input_schema: {
            type: 'object',
            properties: { passed: { type: 'boolean' }, reason: { type: 'string' } },
            required: ['passed'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_review_result' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logLlmCallFailure(logCtx, response.status, errorBody);
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (data.usage) logLlmCallSuccess(logCtx, data.usage);

  const toolUse = data.content?.find((c: { type: string }) => c.type === 'tool_use');
  const input = toolUse?.input as { passed?: unknown; reason?: unknown } | undefined;

  if (!input || typeof input.passed !== 'boolean') {
    throw new Error('LLM 응답에서 report_review_result 도구 호출을 찾지 못했습니다.');
  }

  return { passed: input.passed, reason: typeof input.reason === 'string' ? input.reason : '' };
}

/**
 * 특징 하나를 끝까지 처리한다 — 생성 → 검수 → 실패 시 1회 재시도 →
 * 그래도 실패하면 저장하지 않고 포기(작업지시서 §1-5, "억지로 밀어붙이지
 * 않음"). 화면은 저장된 행이 없으면 "판단할 데이터가 부족함"과 같은
 * 방식으로 게이팅한다.
 */
async function processFeatureNarrative(
  brandName: string,
  brandId: string,
  diagnosisId: string,
  featureName: string,
  reasonStatedCount: number,
  coMentionedCount: number,
  snippets: FeatureSnippets,
  runKind: LlmRunKind
): Promise<FeatureNarrativeSaveResult> {
  let lastReason = '';
  let generateCalls = 0;
  let reviewCalls = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const draft = await retryWithBackoff(
      () => generateFeatureNarrative(brandName, brandId, featureName, reasonStatedCount, coMentionedCount, snippets, runKind),
      3,
      isRetryableLLMError
    );
    generateCalls += 1;

    if (draft.whyBoxSentences.length === 0) {
      lastReason = '생성 결과에 why-box 문장이 없음';
      continue;
    }

    const review = await retryWithBackoff(
      () => reviewFeatureNarrative(brandName, brandId, featureName, draft, snippets, runKind),
      3,
      isRetryableLLMError
    );
    reviewCalls += 1;

    if (review.passed) {
      const counterBoxCases: GapFeatureNarrativeCounterCase[] = draft.counterBoxCases.map((c) => ({
        mentionId: snippets.coMentioned[c.snippetIndex].mentionId,
        explanation: c.explanation,
      }));

      const id = await saveGapFeatureNarrative({
        diagnosisId,
        brandId,
        featureText: featureName,
        whyBoxSentences: draft.whyBoxSentences,
        counterBoxCases,
        generatedBy: ANTHROPIC_MODEL,
        reviewedBy: ANTHROPIC_MODEL_SONNET,
      });

      return {
        featureText: featureName,
        saved: id !== null,
        reason: id ? undefined : 'DB 저장 실패',
        generateCalls,
        reviewCalls,
      };
    }

    lastReason = review.reason || '검수 탈락(사유 미상)';
    console.error(`gap 문구 검수 실패 (feature="${featureName}", attempt=${attempt}): ${lastReason}`);
  }

  return { featureText: featureName, saved: false, reason: lastReason, generateCalls, reviewCalls };
}

export interface GapNarrativeRunSummary {
  totalFeatures: number;
  qualifiedFeatures: number; // 관측 10회 이상
  generatedCalls: number;
  reviewCalls: number;
  savedCount: number;
  results: FeatureNarrativeSaveResult[];
  stoppedByLlmCallCap: boolean;
}

/**
 * §1-2 기준(전역 분모 아니라 "이 특징의 reason_stated+co_mentioned 합계")으로
 * 10회 이상인, 화면에 실제로 노출되는(pill≠null) 특징만 대상으로 문구를
 * 생성한다.
 */
export async function runGapNarrativeGeneration(
  brandId: string,
  brandName: string,
  diagnosisId: string,
  periodStart: string,
  periodEnd: string,
  runKind: LlmRunKind
): Promise<GapNarrativeRunSummary> {
  startUsageRun();

  const knownBrands = await fetchKnownBrands();
  const ourBrand = knownBrands.find((b) => b.brandId === brandId);
  if (!ourBrand) throw new Error(`brandId ${brandId}를 brands 목록에서 못 찾음`);

  const candidates = await fetchGapFeatureUniverse(brandId, diagnosisId);
  const roleRows = await fetchMentionFeatureRolesForPlacement(brandId, periodStart, periodEnd);
  // 전역 분모(placementTotalValidRuns)는 pill 분류 자체엔 필요하지만, 이
  // 함수의 "관측 10회" 게이팅은 특징별 reason+co 합계 기준이라 0으로 둬도
  // pill 계산 결과(placementBadge 등)에 문구 생성 대상 선정 자체엔 영향 없다.
  const stats = buildFeatureGapStats(candidates, roleRows, 0);

  const targets = stats.filter((s) => {
    if (s.pill === null) return false;
    const totalObserved = s.placementReasonStatedCount + s.placementCoMentionedCount;
    return totalObserved >= MIN_RUNS_FOR_JUDGMENT;
  });

  const allMentions = await fetchPlacementMentionsForRoleJudgment(brandId, periodStart, periodEnd);
  const segmentByMention = new Map<string, string>();
  for (const m of allMentions) {
    const text = getBrandSegmentText(m.rawResponse, knownBrands, ourBrand.name);
    if (text) segmentByMention.set(m.mentionId, text);
  }

  const summary: GapNarrativeRunSummary = {
    totalFeatures: stats.length,
    qualifiedFeatures: targets.length,
    generatedCalls: 0,
    reviewCalls: 0,
    savedCount: 0,
    results: [],
    stoppedByLlmCallCap: false,
  };

  for (const target of targets) {
    if (getUsageRunSummary().llmCalls >= MAX_LLM_CALLS_PER_RUN - 3) {
      summary.stoppedByLlmCallCap = true;
      console.warn(`⚠️ gap-narratives 생성이 MAX_LLM_CALLS_PER_RUN(${MAX_LLM_CALLS_PER_RUN})에 걸려 중단됨`);
      break;
    }

    const snippets = buildFeatureSnippets(target.featureName, roleRows, segmentByMention);

    const result = await processFeatureNarrative(
      brandName,
      brandId,
      diagnosisId,
      target.featureName,
      target.placementReasonStatedCount,
      target.placementCoMentionedCount,
      snippets,
      runKind
    );

    summary.generatedCalls += result.generateCalls;
    summary.reviewCalls += result.reviewCalls;
    if (result.saved) summary.savedCount += 1;
    summary.results.push(result);
  }

  return summary;
}
