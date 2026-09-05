// lib/mention-feature-roles.ts

/**
 * Day22 "인지와 위치의 간극" 화면 — 자리질문 답변에서 알려진 특징이
 * 추천 근거로 연결됐는지(reason_stated) 아니면 그냥 같이 나왔을 뿐인지
 * (co_mentioned) 판정한다.
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (작업지시서 Day22_작업지시서_간극화면.md §1-2, 2026-09-04 확정)
 * ─────────────────────────────────────────────────────────
 *  - reason_stated: 브랜드명과 특징이 같은 문장 또는 바로 이어지는 문장
 *    안에서 "~해서"/"~때문에"/"~를 갖춰"/"~에 적합"/"~라서" 같은
 *    인과·근거 연결 표현으로 묶여 있을 때
 *  - co_mentioned: 같은 답변 안에 있지만 위 연결 표현 없이 나열되거나
 *    분리돼 있을 때
 *  - 애매하면 무조건 co_mentioned로 낮춘다 — "AI 내부에서 왜 골랐는지"는
 *    검증 불가능한 주장이라 항상 금지, 텍스트 구조로 판정 가능한 것만 인정
 *    (매니페스토 §4 2026-09-04 수정)
 *
 * ⚠️ 판정(judge)과 검수(review)를 별도 모델로 분리한다(작업지시서 §1-3,
 *    "자기 판정을 자기가 승인하지 않게"). Haiku가 판정, Sonnet이 검수 —
 *    브랜드 한 줄 합성(lib/brand-one-liner.ts)이 이미 "최종 노출 문장은
 *    강한 모델이 마지막에 손댄다"는 원칙을 쓰고 있어서 일관성 있고,
 *    mention 수(특징 수보다 훨씬 많음)가 비용을 좌우하니 저렴한 모델로
 *    1차 판정하는 게 유리하다(2026-09-05 루아 확인).
 *
 * ⚠️ 검수는 mention당 1콜, 그 mention에서 판정된 특징 전부(reason_stated +
 *    co_mentioned 다)를 재확인한다 — reason_stated만 검수하면
 *    co_mentioned가 영원히 reviewed=false로 남아 §3-4 counter-box("반대
 *    증거와 제외된 사례")가 항상 비게 되는 문제를 2026-09-05에 발견해서
 *    이렇게 확정함(원래는 비용 절감 위해 reason_stated만 검수하려 했었음).
 *    검수는 judge의 판정 결과를 보여주지 않고 같은 특징 후보만 다시
 *    독립적으로 판정하게 한다 — judge 의견에 끌려가지 않게.
 *
 * ⚠️ 세그먼트 오염 위험 — lib/citation-linker.ts의 알려진 부채(문단 경계
 *    안에 다른 브랜드 설명이나 출처 목록이 섞이는 문제)를 이 판정도 그대로
 *    물려받는다(buildBrandParagraphs와 동일한 computeBrandSegments 재사용).
 *    keyword-extractor.ts 프롬프트 규칙 3번과 같은 완화 지시를 아래
 *    프롬프트에도 넣었다 — 구조적 해결은 아니고 완화일 뿐.
 */

import {
  ANTHROPIC_API_URL,
  ANTHROPIC_MODEL,
  ANTHROPIC_MODEL_SONNET,
  ANTHROPIC_VERSION,
  MAX_LLM_CALLS_PER_RUN,
} from './llm-config';
import { logLlmCallSuccess, logLlmCallFailure, startUsageRun, getUsageRunSummary, type LlmRunKind } from './llm-usage';
import { retryWithBackoff, isRetryableLLMError } from './retry';
import { parseBrandMentions, type KnownBrand } from './parser';
import { computeBrandSegments, getSegmentText } from './citation-linker';
import {
  fetchKnownBrands,
  fetchPlacementMentionsForRoleJudgment,
  saveMentionFeatureRoles,
  fetchBrandFeatureCandidatesForDiagnosis,
  fetchLatestBrandOneLiner,
  fetchAlreadyJudgedMentionIds,
  supabaseAdmin,
  type PlacementMentionForRoleJudgment,
  type StoredBrandFeatureCandidate,
  type MentionFeatureRoleToSave,
} from './supabase';

export type MentionFeatureRole = 'reason_stated' | 'co_mentioned';

export interface FeatureForJudgment {
  id: string;
  name: string;
}

export interface RoleJudgmentResult {
  featureId: string;
  role: MentionFeatureRole;
}

const JUDGE_RULES_TEXT = (brandName: string) => `판정 기준 (반드시 이 기준만 쓸 것 — "${brandName}"이 왜 그 특징으로 추천됐는지 AI 속마음을 추측하는 게 아니라, 답변 문장의 텍스트 구조만 본다):
- reason_stated: "${brandName}"과 그 특징이 같은 문장 또는 바로 이어지는 문장 안에서 "~해서", "~때문에", "~를 갖춰", "~에 적합", "~라서", "~있어(서)" 같은 **인과(원인→결과) 연결 표현**으로 묶여 있을 때만. 문장을 "왜냐하면" 뒤에 넣어도 말이 되는지 스스로 확인해라 — 말이 안 되면 co_mentioned다.
- co_mentioned: 같은 텍스트 안에 특징이 나오지만 위 인과 연결 표현 없이 나열되거나 다른 문장에 떨어져 있을 때

**절대 reason_stated로 인정하면 안 되는 경우 (실제로 잘못 판정됐던 사례 기반, 2026-09-05 발견)**:
- "~하며", "~하고", "~와 함께" 같은 **단순 나열·병렬 연결어**로 이어진 문장. 예: "화곡역 1분 거리에서 365일 진료하며, 서울대 출신 전문의 협진으로 정밀 진료를 제공합니다" — "365일 진료"와 "전문의 협진"이 그냥 나열됐을 뿐, 어느 쪽도 다른 쪽의 "이유"가 아니다. → 전부 co_mentioned
- **표(table)나 목록 형식**으로 병원명·특징·위치가 칸으로 나뉘어 나열된 경우(예: "병원명 | 특징 설명 | 위치" 형식). 이건 애초에 문장이 아니라 항목 나열이라 인과 연결 표현이 성립할 수 없다. → co_mentioned
- 애매하면 무조건 co_mentioned로 판정해라 — 확신 없을 때 더 강한 주장(reason_stated) 쪽으로 절대 넘어가지 마라

⚠️ 주의: 이 텍스트에 "${brandName}"이 아닌 다른 병원·브랜드에 대한 설명이나 출처 목록(URL, 각주)이 섞여 있을 수 있다. 그런 내용은 무시하고 오직 "${brandName}"에 대한 서술만 근거로 판정해라.`;

function buildJudgePrompt(brandName: string, segmentText: string, features: FeatureForJudgment[]): string {
  const numberedFeatures = features.map((f, i) => `[${i}] ${f.name}`).join('\n');

  return `아래는 AI 답변 엔진이 자리 질문(추천형 질문)에 "${brandName}"을 언급한 답변에서, "${brandName}" 구간만 뽑은 텍스트다.

"${brandName}" 구간:
"""
${segmentText}
"""

아래는 "${brandName}"의 알려진 특징 후보 목록이다. 이 구간 텍스트 안에서 각 특징이 실제로 언급되는지, 언급된다면 어떤 방식으로 언급되는지 판정해라. **텍스트에 아예 등장하지 않는 특징은 결과에서 완전히 빼라** (co_mentioned로도 넣지 마라).

특징 목록:
${numberedFeatures}

${JUDGE_RULES_TEXT(brandName)}

각 특징의 index로 결과를 보고해라. 등장하지 않는 특징은 결과 배열에 아예 넣지 마라.`;
}

function buildReviewPrompt(brandName: string, segmentText: string, features: FeatureForJudgment[]): string {
  const numberedFeatures = features.map((f, i) => `[${i}] ${f.name}`).join('\n');

  return `아래는 AI 답변 엔진이 자리 질문(추천형 질문)에 "${brandName}"을 언급한 답변에서, "${brandName}" 구간만 뽑은 텍스트다. 이건 1차 판정을 다시 독립적으로 검수하는 작업이다 — 1차 판정 결과는 안 보여주니, 아래 기준으로 새로 처음부터 판정해라.

"${brandName}" 구간:
"""
${segmentText}
"""

아래 특징들이 이 구간 텍스트에 실제로 등장하는지, 등장한다면 어떤 방식으로 등장하는지 확인해라. **텍스트를 다시 꼼꼼히 읽고, 실제로 등장하지 않는 특징이 있으면 반드시 not_present로 표시해라** — 1차 판정이 틀렸을 수 있다는 전제로 검수하는 것이다.

확인 대상:
${numberedFeatures}

${JUDGE_RULES_TEXT(brandName)}

각 특징의 index로 결과를 보고해라. role은 'reason_stated', 'co_mentioned', 'not_present' 중 하나다. 목록에 있는 특징은 전부 결과에 포함해라(not_present도 포함).`;
}

function buildUsageLogCtx(
  site: string,
  model: string,
  brandName: string,
  brandId: string,
  runKind: LlmRunKind
) {
  return {
    site,
    model,
    kind: 'placementRole' as const,
    runKind,
    brandName,
    brandId,
    queryId: null,
    engine: null,
  };
}

/** Haiku 1차 판정 — mention 하나(=구간 텍스트 하나)당 1콜, 특징 전부 배치. */
export async function judgeMentionFeatureRoles(
  brandName: string,
  brandId: string,
  segmentText: string,
  features: FeatureForJudgment[],
  runKind: LlmRunKind
): Promise<RoleJudgmentResult[]> {
  if (features.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

  const logCtx = buildUsageLogCtx('mention-feature-roles:judge', ANTHROPIC_MODEL, brandName, brandId, runKind);
  const prompt = buildJudgePrompt(brandName, segmentText, features);

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
          name: 'report_feature_roles',
          description: '구간 텍스트에 실제로 등장하는 특징들의 역할(reason_stated/co_mentioned)을 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', description: '특징 목록의 [N] 값' },
                    role: { type: 'string', enum: ['reason_stated', 'co_mentioned'] },
                  },
                  required: ['index', 'role'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_feature_roles' },
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
  const results: { index: number; role: MentionFeatureRole }[] = toolUse?.input?.results ?? [];

  return results
    .filter((r) => features[r.index] !== undefined)
    .map((r) => ({ featureId: features[r.index].id, role: r.role }));
}

/**
 * Sonnet 검수 — mention당 1콜, 판정된 특징 전부(reason_stated+co_mentioned)를
 * 독립적으로 재확인한다. not_present로 나오면 그 특징은 최종 결과에서 뺀다
 * (1차 판정이 없는 걸 있다고 잘못 봤을 가능성 방어 — 위 파일 헤더 주석 참고).
 */
export async function reviewMentionFeatureRoles(
  brandName: string,
  brandId: string,
  segmentText: string,
  candidateFeatures: FeatureForJudgment[],
  runKind: LlmRunKind
): Promise<RoleJudgmentResult[]> {
  if (candidateFeatures.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

  const logCtx = buildUsageLogCtx(
    'mention-feature-roles:review',
    ANTHROPIC_MODEL_SONNET,
    brandName,
    brandId,
    runKind
  );
  const prompt = buildReviewPrompt(brandName, segmentText, candidateFeatures);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL_SONNET,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      tools: [
        {
          name: 'report_reviewed_feature_roles',
          description: '구간 텍스트를 독립적으로 다시 검토해, 각 특징의 실제 역할을 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', description: '확인 대상 목록의 [N] 값' },
                    role: { type: 'string', enum: ['reason_stated', 'co_mentioned', 'not_present'] },
                  },
                  required: ['index', 'role'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_reviewed_feature_roles' },
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
  const results: { index: number; role: MentionFeatureRole | 'not_present' }[] = toolUse?.input?.results ?? [];

  return results
    .filter((r) => candidateFeatures[r.index] !== undefined && r.role !== 'not_present')
    .map((r) => ({ featureId: candidateFeatures[r.index].id, role: r.role as MentionFeatureRole }));
}

/** mention 하나를 끝까지 처리 — 판정→(있으면) 검수→저장. 판정 결과가 0건이면 검수도 저장도 안 한다. */
export async function processMentionForRoles(
  mention: PlacementMentionForRoleJudgment,
  brandName: string,
  brandId: string,
  segmentText: string,
  features: FeatureForJudgment[],
  runKind: LlmRunKind
): Promise<{ judged: boolean; reviewed: boolean; savedCount: number }> {
  const judged = await retryWithBackoff(
    () => judgeMentionFeatureRoles(brandName, brandId, segmentText, features, runKind),
    3,
    isRetryableLLMError
  );

  if (judged.length === 0) {
    return { judged: true, reviewed: false, savedCount: 0 };
  }

  const featureById = new Map(features.map((f) => [f.id, f]));
  const candidatesForReview = judged
    .map((j) => featureById.get(j.featureId))
    .filter((f): f is FeatureForJudgment => !!f);

  const reviewed = await retryWithBackoff(
    () => reviewMentionFeatureRoles(brandName, brandId, segmentText, candidatesForReview, runKind),
    3,
    isRetryableLLMError
  );

  if (reviewed.length === 0) {
    return { judged: true, reviewed: true, savedCount: 0 };
  }

  const rows: MentionFeatureRoleToSave[] = reviewed.map((r) => ({
    mentionId: mention.mentionId,
    featureText: featureById.get(r.featureId)!.name,
    role: r.role,
    judgedBy: ANTHROPIC_MODEL,
    reviewedBy: ANTHROPIC_MODEL_SONNET,
  }));

  const savedIds = await saveMentionFeatureRoles(rows);
  return { judged: true, reviewed: true, savedCount: savedIds.length };
}

/**
 * "확인 대상 특징" 목록 — Day20(브랜드 인지 화면)이 실제로 보여주는 것과
 * 정확히 같은 범위를 재사용한다(2026-09-05 확인). tier·passed_min_criteria로
 * 좁히지 않고, '잘못된인지'로 걸린 것만 뺀 전체 후보를 쓴다 — 좁히면
 * "인지에선 약한데 자리에선 강하게 쓰이는" 패턴(작업지시서 예시의 "추천에서
 * 발견" 사례)이 화면에서 아예 안 보이게 되기 때문이다(brand-awareness/page.tsx
 * 주석 및 프로토타입 예시로 확인).
 */
export async function fetchGapFeatureUniverse(
  brandId: string,
  diagnosisId: string
): Promise<StoredBrandFeatureCandidate[]> {
  const allCandidates = await fetchBrandFeatureCandidatesForDiagnosis(diagnosisId, supabaseAdmin);
  // 'owner' 역할로 조회해서 reviewedByHuman 게이트 없이 실제 상태를 그대로 본다
  // (이건 화면 렌더링이 아니라 내부 배치 판정이라 고객 노출 제한이 필요 없음).
  const view = await fetchLatestBrandOneLiner(brandId, 'owner', supabaseAdmin, diagnosisId);
  const conflictCandidateIds = new Set(view.conflicting?.featureCandidateIds ?? []);
  return allCandidates.filter((c) => !conflictCandidateIds.has(c.id));
}

export interface MentionFeatureRoleRunSummary {
  mentionsFound: number;
  mentionsAlreadyJudged: number;
  mentionsProcessed: number;
  mentionsSkippedNoSegment: number;
  judgeCalls: number;
  reviewCalls: number;
  savedRoleRows: number;
  failedMentionIds: string[];
  /** MAX_LLM_CALLS_PER_RUN(lib/llm-config.ts)에 걸려 중간에 멈췄으면 true — aggregateAllQueriesForDay와 같은 안전장치. */
  stoppedByLlmCallCap: boolean;
}

/**
 * 자리질문 mentions 전체(또는 maxMentions로 제한한 일부)를 순회하며
 * 역할판정을 돌린다. mention 하나 실패해도 나머지는 계속 진행한다
 * (CLAUDE.md 절대원칙 4번 — 하나 실패했다고 전체를 버리지 않는다).
 *
 * mention 1건당 최대 2콜(판정+검수)이라 mention 수가 늘면 호출 수도 같이
 * 늘어난다 — aggregateAllQueriesForDay와 같은 MAX_LLM_CALLS_PER_RUN 상한을
 * 그대로 적용한다(2026-09-05, 9/3 예산 사고 이후 원칙 재사용).
 *
 * @param maxMentions 실측 검증용으로 일부만 먼저 돌려볼 때 씀(2026-09-05,
 *   전체 백필 전에 5~10건으로 실제 비용 재기로 루아와 합의).
 */
export async function runMentionFeatureRoleJudgment(
  brandId: string,
  brandName: string,
  diagnosisId: string,
  periodStart: string,
  periodEnd: string,
  runKind: LlmRunKind,
  maxMentions?: number
): Promise<MentionFeatureRoleRunSummary> {
  startUsageRun();

  const knownBrands: KnownBrand[] = await fetchKnownBrands();
  const ourBrand = knownBrands.find((b) => b.brandId === brandId);
  if (!ourBrand) throw new Error(`brandId ${brandId}를 brands 목록에서 못 찾음`);

  const features = await fetchGapFeatureUniverse(brandId, diagnosisId);
  const featuresForJudgment: FeatureForJudgment[] = features.map((f) => ({ id: f.id, name: f.featureName }));

  const allMentions = await fetchPlacementMentionsForRoleJudgment(brandId, periodStart, periodEnd);

  // 이미 판정+저장된 mention은 재실행 시 건너뛴다 — 안 그러면 같은 mention에
  // 중복 행이 쌓인다(brand_one_liners 중복 사고와 같은 종류). ⚠️ 한계: 판정
  // 결과가 0건(저장할 행이 없음)이었던 mention은 "판정 안 한 것"과 구분이
  // 안 돼서 재실행 때 다시 판정된다 — 데이터 오염은 아니고 약간의 중복 비용만
  // 발생(2026-09-05 코난 판단, 이번 백필 규모에선 무시 가능한 수준).
  const candidateMentionIds = allMentions.map((m) => m.mentionId);
  const alreadyJudged = await fetchAlreadyJudgedMentionIds(candidateMentionIds);
  const unjudgedMentions = allMentions.filter((m) => !alreadyJudged.has(m.mentionId));

  const mentions = maxMentions ? unjudgedMentions.slice(0, maxMentions) : unjudgedMentions;

  const summary: MentionFeatureRoleRunSummary = {
    mentionsFound: allMentions.length,
    mentionsAlreadyJudged: alreadyJudged.size,
    mentionsProcessed: 0,
    mentionsSkippedNoSegment: 0,
    judgeCalls: 0,
    reviewCalls: 0,
    savedRoleRows: 0,
    failedMentionIds: [],
    stoppedByLlmCallCap: false,
  };

  if (featuresForJudgment.length === 0 || mentions.length === 0) return summary;

  for (const mention of mentions) {
    // mention 하나가 최대 2콜(판정+검수)이니, 다음 mention을 시작하기 전에
    // 상한에 이미 닿았는지 확인한다 — 닿은 뒤에 시작하면 검수 콜만 잘려서
    // "판정은 됐는데 검수 없이 저장되는" 사고가 날 수 있어(§1-3 위반).
    if (getUsageRunSummary().llmCalls >= MAX_LLM_CALLS_PER_RUN - 1) {
      summary.stoppedByLlmCallCap = true;
      console.warn(
        `⚠️ mention_feature_roles 판정이 MAX_LLM_CALLS_PER_RUN(${MAX_LLM_CALLS_PER_RUN})에 걸려 중단됨 — ` +
          `처리 ${summary.mentionsProcessed}/${mentions.length}건에서 멈춤`
      );
      break;
    }

    try {
      const parsed = parseBrandMentions(mention.rawResponse, knownBrands);
      const allPositions = parsed.mentions.map((m) => ({ brandName: m.brandName, position: m.position }));
      const segments = computeBrandSegments(mention.rawResponse, allPositions);
      const segment = segments.find((s) => s.anchorBrandName === ourBrand.name);

      if (!segment) {
        // mentions 테이블 기준으론 등장했는데 재파싱하면 구간이 안 나옴 —
        // attemptKeywordExtraction과 같은 이유(저장된 mentions와 원문 재파싱
        // 결과가 어긋남). 같은 입력이면 항상 같은 결과라 재시도로 안 풀리므로
        // 스킵하고 카운트만 남긴다.
        summary.mentionsSkippedNoSegment += 1;
        continue;
      }

      const segmentText = getSegmentText(mention.rawResponse, segment);
      const result = await processMentionForRoles(
        mention,
        ourBrand.name,
        brandId,
        segmentText,
        featuresForJudgment,
        runKind
      );

      summary.mentionsProcessed += 1;
      if (result.judged) summary.judgeCalls += 1;
      if (result.reviewed) summary.reviewCalls += 1;
      summary.savedRoleRows += result.savedCount;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`mention_feature_roles 판정 실패 (mention=${mention.mentionId}):`, msg);
      summary.failedMentionIds.push(mention.mentionId);
    }
  }

  return summary;
}
