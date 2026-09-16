// lib/placement-expression-classifier.ts

/**
 * "인지와 추천, 그 사이" 화면 — 추천 표현(자리질문 mentions에서 뽑은 원자 표현)에
 * 기존 7개 카테고리(brand_feature_candidates.category와 동일 체계)를 붙이고,
 * 같은 카테고리 안에서 왼쪽(소개 특징) 후보와 구체적으로 같은 특징인지 판정한다.
 * (작업지시서_표현정규화_2026-09-16_V1.2)
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (2026-09-16 확정)
 * ─────────────────────────────────────────────────────────
 *  - 1단계: 7개 카테고리(치료분야/진료체계/의료역량/환자상황/이용편의성/지역_조건/
 *    일반적표현) 중 하나, 또는 어디에도 안 맞으면 미분류(null) — "일반적표현"으로
 *    뭉개지 말 것(2026-09-16 루아 지시, 억지로 카테고리에 끼워맞추지 않는다).
 *  - 2단계: 같은 카테고리 안에서 왼쪽 특징 후보와 "세부 의미까지" 같은지 판정.
 *    같은 카테고리라는 이유만으로 같은 특징으로 보지 않는다(2026-09-16 루아 지시)
 *    — 예: "365일 연중무휴 진료"와 "분과별 전문의 협진"은 같은 카테고리가 아니라
 *    애초에 무관하지만, 설령 같은 카테고리 안이어도(예: "365일 진료" vs "당일
 *    원데이 시스템", 둘 다 이용편의성) 서로 다른 구체적 주장이면 매칭 안 시킨다.
 *    반대로 "365일 연중무휴 진료"와 "일요일 진료"처럼 한쪽이 다른 쪽의 구체적
 *    증거일 뿐이면 같은 특징으로 인정한다.
 *
 * ⚠️ 판정(judge)과 검수(review)를 분리한다 — lib/mention-feature-roles.ts와 같은
 *    원칙("자기 판정을 자기가 승인하지 않게"). Haiku 1차 판정 → Sonnet이 판정
 *    결과를 안 보여준 채 독립적으로 재판정(reason_stated 검수와 동일 원칙).
 *
 * ⚠️ "확신 낮은 것만 상위 모델/사람 검수로"라는 조건부 분기는 아직 안 넣는다
 *    (작업지시서 3단계, reason_stated 패턴을 잘못 안 것을 정정 — 실제 reason_stated는
 *    조건부 분기 없이 전건 재검수). 이 기능도 우선 전건 재검수로 시작하고, 돌려본
 *    비용·정확도를 보고 조건부 분기 도입 여부를 나중에 결정한다.
 */

import {
  ANTHROPIC_API_URL,
  ANTHROPIC_MODEL,
  ANTHROPIC_MODEL_SONNET,
  ANTHROPIC_VERSION,
} from './llm-config';
import { logLlmCallSuccess, logLlmCallFailure, type LlmRunKind } from './llm-usage';
import { FEATURE_CATEGORIES, type FeatureCategory } from './supabase';

export interface ExpressionForClassification {
  index: number;
  text: string;
}

export interface LeftCandidateForMatching {
  index: number;
  id: string;
  name: string;
  category: FeatureCategory;
}

export interface ClassificationResult {
  index: number; // ExpressionForClassification.index
  category: FeatureCategory | null; // null = 미분류(7개 어디에도 안 맞음)
  matchedLeftIndex: number | null; // LeftCandidateForMatching.index, 없으면 null
}

const NO_MATCH = -1;
const UNCATEGORIZED = '미분류';

function buildRulesText(brandName: string): string {
  return `판정 기준:
1. 아래 "왼쪽 특징 목록"은 "${brandName}"을 소개하는 답변에서 이미 정리된 특징들이고, 각각 카테고리가 붙어 있다.
2. 각 "추천 표현"에 카테고리를 하나 배정해라. 반드시 왼쪽 특징 목록에 쓰인 7개 카테고리(치료분야/진료체계/의료역량/환자상황/이용편의성/지역_조건/일반적표현) 중 하나이거나, 그 어디에도 안 맞으면 "${UNCATEGORIZED}"다.
3. **억지로 끼워맞추지 마라.** 애매하면 "일반적표현"에 몰아넣지 말고 "${UNCATEGORIZED}"로 판정해라. "일반적표현"은 실제로 "어느 병원에나 붙을 수 있는 표현"일 때만 써라.
4. 카테고리를 배정했으면, 같은 카테고리에 속한 왼쪽 특징들 중에 **세부 의미까지 같은 것**이 있는지 확인해라. 같은 카테고리라는 이유만으로 매칭시키지 마라 — 서로 다른 구체적 주장이면 매칭 없음(matchedLeftIndex: ${NO_MATCH})으로 남겨라.
   - 매칭으로 인정: 한쪽이 다른 쪽보다 더 구체적인 증거/하위 사례일 뿐 같은 주장인 경우. 예: "365일 연중무휴 진료"(왼쪽)와 "일요일 진료"(오른쪽) → 같은 특징(일요일 진료는 연중무휴 진료의 구체적 증거).
   - 매칭으로 인정 안 함: 같은 카테고리여도 서로 다른 구체적 주장인 경우. 예: "365일 연중무휴 진료"(이용편의성)와 "당일 진단부터 보철 제작까지 원데이 시스템"(이용편의성) → 둘 다 이용편의성이지만 다른 특징, 매칭 없음.
5. 왼쪽 목록에 없는 카테고리를 배정했다면(그 카테고리엔 왼쪽 특징이 아예 없다면) matchedLeftIndex는 당연히 ${NO_MATCH}다.
6. 확실하지 않으면 매칭시키지 마라(matchedLeftIndex: ${NO_MATCH}) — 억지로 연결하는 것보다 안 하는 게 낫다.`;
}

function buildLeftCandidatesText(leftCandidates: LeftCandidateForMatching[]): string {
  return leftCandidates.map((c) => `[${c.index}] (${c.category}) ${c.name}`).join('\n');
}

function buildExpressionsText(expressions: ExpressionForClassification[]): string {
  return expressions.map((e) => `[${e.index}] ${e.text}`).join('\n');
}

const CLASSIFY_TOOL_NAME = 'report_expression_classifications';
const REVIEW_TOOL_NAME = 'report_reviewed_expression_classifications';

function buildClassifyToolSchema(toolName: string, description: string) {
  return {
    name: toolName,
    description,
    input_schema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer', description: '추천 표현 목록의 [N] 값' },
              category: {
                type: 'string',
                enum: [...FEATURE_CATEGORIES, UNCATEGORIZED],
              },
              matchedLeftIndex: {
                type: 'integer',
                description: `세부 의미까지 같은 왼쪽 특징의 [N] 값. 없으면 ${NO_MATCH}.`,
              },
            },
            required: ['index', 'category', 'matchedLeftIndex'],
          },
        },
      },
      required: ['results'],
    },
  };
}

function parseToolResults(data: { content?: { type: string; input?: unknown }[] }): ClassificationResult[] {
  const toolUse = data.content?.find((c) => c.type === 'tool_use');
  const raw: { index: number; category: string; matchedLeftIndex: number }[] =
    (toolUse?.input as { results?: typeof raw })?.results ?? [];

  return raw.map((r) => ({
    index: r.index,
    category: r.category === UNCATEGORIZED ? null : (r.category as FeatureCategory),
    matchedLeftIndex: r.matchedLeftIndex === NO_MATCH ? null : r.matchedLeftIndex,
  }));
}

function buildUsageLogCtx(site: string, model: string, brandName: string, brandId: string, runKind: LlmRunKind) {
  return {
    site,
    model,
    kind: 'expressionMatch' as const,
    runKind,
    brandName,
    brandId,
    queryId: null,
    engine: null,
  };
}

/** Haiku 1차 판정 — 추천 표현 배치 하나당 1콜, 왼쪽 특징 목록 전체를 매번 같이 보낸다. */
export async function judgeExpressionClassifications(
  brandName: string,
  brandId: string,
  expressions: ExpressionForClassification[],
  leftCandidates: LeftCandidateForMatching[],
  runKind: LlmRunKind
): Promise<ClassificationResult[]> {
  if (expressions.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

  const logCtx = buildUsageLogCtx('placement-expression-classifier:judge', ANTHROPIC_MODEL, brandName, brandId, runKind);

  const prompt = `아래는 AI 답변 엔진이 "${brandName}"을(를) 추천한 답변에서 뽑은 표현들이다.

왼쪽 특징 목록(소개 답변에서 이미 정리됨):
${buildLeftCandidatesText(leftCandidates)}

추천 표현 목록:
${buildExpressionsText(expressions)}

${buildRulesText(brandName)}

모든 추천 표현에 대해 결과를 보고해라(하나도 빠짐없이).`;

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
      tools: [buildClassifyToolSchema(CLASSIFY_TOOL_NAME, '추천 표현 각각에 카테고리와 왼쪽 특징 매칭 여부를 보고한다.')],
      tool_choice: { type: 'tool', name: CLASSIFY_TOOL_NAME },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logLlmCallFailure(logCtx, response.status, errorBody);
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (data.usage) logLlmCallSuccess(logCtx, data.usage);

  return parseToolResults(data);
}

/**
 * Sonnet 검수 — Haiku 판정 결과는 보여주지 않고 같은 입력을 독립적으로
 * 다시 판정한다(judge 의견에 끌려가지 않게, mention-feature-roles.ts와 동일 원칙).
 * 이 결과가 최종본이다.
 */
export async function reviewExpressionClassifications(
  brandName: string,
  brandId: string,
  expressions: ExpressionForClassification[],
  leftCandidates: LeftCandidateForMatching[],
  runKind: LlmRunKind
): Promise<ClassificationResult[]> {
  if (expressions.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

  const logCtx = buildUsageLogCtx(
    'placement-expression-classifier:review',
    ANTHROPIC_MODEL_SONNET,
    brandName,
    brandId,
    runKind
  );

  const prompt = `아래는 "${brandName}" 추천 표현의 카테고리·특징 매칭을 독립적으로 검수하는 작업이다 — 1차 판정 결과는 안 보여주니, 처음부터 새로 판정해라.

왼쪽 특징 목록(소개 답변에서 이미 정리됨):
${buildLeftCandidatesText(leftCandidates)}

추천 표현 목록:
${buildExpressionsText(expressions)}

${buildRulesText(brandName)}

모든 추천 표현에 대해 결과를 보고해라(하나도 빠짐없이).`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL_SONNET,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
      tools: [
        buildClassifyToolSchema(REVIEW_TOOL_NAME, '추천 표현 각각을 독립적으로 다시 검토해 카테고리와 특징 매칭 여부를 보고한다.'),
      ],
      tool_choice: { type: 'tool', name: REVIEW_TOOL_NAME },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logLlmCallFailure(logCtx, response.status, errorBody);
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (data.usage) logLlmCallSuccess(logCtx, data.usage);

  return parseToolResults(data);
}

export interface ClassifiedExpression extends ClassificationResult {
  /** Haiku(1차)와 Sonnet(독립 재판정)이 같은 결론(카테고리+매칭)에 도달했는지.
   *  false면 두 모델이 서로 다르게 판단했다는 뜻 — 이걸 "확신 낮음" 신호로 쓴다
   *  (숫자 confidence 점수를 새로 발명하지 않고, 이미 있는 두 독립 판정을 그대로
   *  비교하는 쪽을 택함 — 2026-09-16 설계). Sonnet 결과가 최종 채택값이다. */
  agreedWithFirstPass: boolean;
}

/**
 * 배치 하나(판정→독립 재검수)를 끝까지 처리한다. mention-feature-roles.ts와 달리
 * 여기선 judge가 "검수 대상을 좁히는" 역할을 못 한다 — 모든 추천 표현이 예외 없이
 * 분류 대상이라 filtering 여지가 없다. 그래서 judge 결과를 그냥 버리지 않고
 * Sonnet의 독립 재판정과 "같은 결론인지"만 비교해서 확신 신호로 쓴다 — 이렇게 해야
 * Haiku 호출이 실제로 결과에 기여한다(안 그러면 순서만 먼저인 채 버려지는 콜이 됨).
 * 최종 채택값은 항상 Sonnet(reviewed) 쪽이다.
 */
export async function classifyExpressionBatch(
  brandName: string,
  brandId: string,
  expressions: ExpressionForClassification[],
  leftCandidates: LeftCandidateForMatching[],
  runKind: LlmRunKind
): Promise<ClassifiedExpression[]> {
  const judged = await judgeExpressionClassifications(brandName, brandId, expressions, leftCandidates, runKind);
  const reviewed = await reviewExpressionClassifications(brandName, brandId, expressions, leftCandidates, runKind);

  const judgedByIndex = new Map(judged.map((j) => [j.index, j]));

  return reviewed.map((r) => {
    const first = judgedByIndex.get(r.index);
    const agreed = !!first && first.category === r.category && first.matchedLeftIndex === r.matchedLeftIndex;
    return { ...r, agreedWithFirstPass: agreed };
  });
}
