// lib/brand-one-liner.ts

/**
 * 브랜드 한 줄 로직 4-2단계 — 진단 종료 시 합성 (2026-09-01, v1.2: 2026-09-02 보완)
 * ═══════════════════════════════════════════════════════
 *
 * 작업지시서_브랜드한줄로직_v1.1.md + v1.2_보완.md, 원안(브랜드 한 줄 생성
 * 로직 v1.0) 4~10번을 구현한다. 진단 회차 하나가 끝날 때(diagnoses:
 * collecting→completed) 딱 한 번 실행된다 — lib/aggregator.ts처럼 매일
 * 도는 게 아니다.
 *
 * 처리 순서 (전부 이 파일 안에서):
 *   1. 그 진단 기간의 brand_expressions 전부 조회
 *   2. 완전히 같은 표현 문자열끼리 먼저 코드로 합침(중복 제거) — 그래야
 *      LLM에 보낼 항목 수가 줄어든다. 예: 7일치 수백 건이어도 서로 다른
 *      표현 문자열은 훨씬 적다.
 *   3. 그 "고유 표현 목록"을 LLM(Sonnet)에 보내서 비슷한 의미끼리 묶는다
 *      (원안 4번) — 원문은 그대로, memberIds로만 연결. 지역/조건 표현은
 *      '지역_조건' 카테고리로, 의미가 불분명한 묶음은 is_unclear로 표시(v1.2)
 *   3-2. 노이즈 필터(v1.2 결정 1) — 독립 관측 1건뿐이거나 is_unclear인
 *      묶음은 여기서 제외한다. brand_feature_candidates에 저장조차 안 함.
 *   4. 묶음별로 최소기준(원안 5번) 통과 여부 + 강도(원안 6번) + tier(v1.2
 *      결정 1)를 코드로 계산 — 이건 결정적 계산이라 LLM에 안 맡긴다
 *      (top N을 LLM에 안 맡기는 keyword-extractor.ts 원칙과 동일)
 *   4-2. 노이즈 필터를 통과한 묶음 전부를 brand_feature_candidates에 저장
 *      (v1.2 결정 1 — 통과/미통과 관계없이 상한 없이 저장)
 *   5. 대표 특징 최대 3개 선정(원안 7번, 코드) — category='지역_조건'은
 *      이 풀에서 제외(v1.2 결정 2). 지역_조건 중 가장 강한 것 1개는 별도로
 *      location_context_id에 선정(v1.2 결정 3)
 *   6. 문장 작성(LLM, 원안 8번) — 근거 안에서만. 지역 맥락은 문맥으로만
 *      쓰고 특징으로 나열하지 않는다(v1.2 결정 3-3)
 *   7. 자동 검수(LLM, 별도 호출 — 문장작성과 같은 호출 안에서 자기가 쓴 걸
 *      자기가 확인하면 확증편향 위험이 있다는 지적을 받아 분리함, 2026-09-01)
 *   8. 실패 조건 있으면 그 특징 빼고 6~7 재시도 (최대 2회)
 *   9. brand_facts와 충돌하는 특징은 별도 행(잘못된인지)으로 분리 저장(원안 9번)
 *   10. (Day21) AI 간 "서로 다르게 설명하는 지점" 탐지 — 위 9번까지 다 끝난
 *      뒤 별도 단계로 붙는다. brand_feature_candidates 중 tier가 확정 또는
 *      가능성있음인 것만 대상으로, LLM이 의미상 진짜 대립하는 쌍을 찾고
 *      (탐지), 별도 호출로 재검수한 뒤(확증편향 방지, 7번과 같은 이유),
 *      통과한 것만 brand_feature_conflicts에 저장한다. 실패해도 위
 *      1~9번(브랜드 한 줄 본문)은 이미 끝났으므로 조용히 스킵하고
 *      전체 진단 완료 처리를 막지 않는다.
 *
 * ⚠️ 아직 실측(live API) 검증 전이다.
 */

import { ANTHROPIC_API_URL, ANTHROPIC_MODEL_SONNET, ANTHROPIC_VERSION } from './llm-config';
import {
  type StoredBrandExpression,
  type StoredDiagnosis,
  type FeatureCategory,
  type FeatureTier,
  type BrandFeatureCandidateToSave,
  type BrandFeatureConflictToSave,
  type BrandOneLinerToSave,
  fetchBrandExpressionsForBrand,
  fetchValidEnginesForQueriesInPeriod,
  fetchActiveQueries,
  fetchKnownBrands,
  fetchExpiredDiagnoses,
  completeDiagnosis,
  saveBrandOneLiner,
  saveBrandFeatureCandidates,
  saveBrandFeatureConflicts,
} from './supabase';
import { kstDayBoundsUtc } from './aggregator';
import { retryWithBackoff, isRetryableLLMError } from './retry';

// ── 1~2단계: 조회 + 고유 표현으로 축약 (코드) ──

interface UniqueExpression {
  text: string;
  memberIds: string[]; // 이 문자열과 완전히 같은 brand_expressions.id들
}

function buildUniqueExpressions(expressions: StoredBrandExpression[]): UniqueExpression[] {
  const byText = new Map<string, string[]>();
  for (const e of expressions) {
    const key = e.expression.trim();
    if (key.length === 0) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key)!.push(e.id);
  }
  return Array.from(byText.entries()).map(([text, memberIds]) => ({ text, memberIds }));
}

// ── 3단계: 비슷한 표현 묶기 (LLM, Sonnet) ──

const CATEGORIES: FeatureCategory[] = [
  '치료분야', '진료체계', '의료역량', '환자상황', '이용편의성', '지역_조건', '일반적표현',
];

interface RawGroup {
  label: string;
  category: FeatureCategory;
  memberIndexes: number[]; // uniqueExpressions 배열의 인덱스
  /** LLM이 이 묶음의 의미가 불분명하다고 판단했는지(v1.2) — true면 노이즈
   *  필터에서 제외되고 brand_feature_candidates에 저장조차 안 된다. */
  isUnclear: boolean;
}

function buildGroupingPrompt(brandName: string, uniqueExpressions: UniqueExpression[]): string {
  const numbered = uniqueExpressions.map((u, i) => `[${i}] ${u.text}`).join('\n');

  return `아래는 AI 답변 엔진들이 "${brandName}"을(를) 설명할 때 실제로 쓴 표현들이다. 서로 다른 관측에서 나온 표현이 번호와 함께 나열돼 있다.

의미가 비슷한 표현끼리 묶어서 특징 묶음을 만들어라. 규칙:
1. 같은 묶음으로 볼 수 있는 표현들을 모아, 그 묶음을 대표하는 짧은 이름(label)을 붙여라.
2. label은 원문 표현들이 실제로 말하고 있는 내용만 요약해라. 원문에 없는 새로운 장점이나 해석을 추가하지 마라(예: 원문들이 "우수하다"고 안 했는데 label에 "우수한"을 넣지 마라).
3. 각 묶음에 아래 카테고리 중 가장 맞는 것 하나를 붙여라:
   - 치료분야 (예: 임플란트, 신경치료 등 특정 진료 분야)
   - 진료체계 (예: 협진, 다학제 진료 등 진료가 조직되는 방식)
   - 의료역량 (예: 고난도 케이스 경험, 전문의 보유 등)
   - 환자상황 (예: 특정 환자군 대응, 재수술 등)
   - 이용편의성 (예: 주말진료, 원스톱 진료 등 접근성/편의)
   - 지역_조건 (예: "강서구", "OO역 근처"처럼 지역명·위치 조건)
   - 일반적표현 ("좋은 치과", "신뢰할 만한", "전문적인"처럼 어느 병원에나 붙을 수 있는 표현)
4. 표현 하나는 반드시 하나의 묶음에만 속해야 한다(중복 배정 금지). 의미가 뚜렷이 다르면 억지로 묶지 말고 따로 둬라.
5. 서로 무관한 표현을 하나의 묶음으로 억지로 합치지 마라.
6. 묶음이 무엇을 말하는지 애매하거나(예: 표현들끼리 의미가 잘 안 이어짐) 판단이 어려우면 is_unclear를 true로 표시해라. 이런 묶음은 특징으로 반영되지 않는다.

표현 목록:
${numbered}`;
}

async function groupSimilarExpressions(
  brandName: string,
  uniqueExpressions: UniqueExpression[]
): Promise<RawGroup[]> {
  if (uniqueExpressions.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

  const prompt = buildGroupingPrompt(brandName, uniqueExpressions);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL_SONNET,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      tools: [
        {
          name: 'report_expression_groups',
          description: '비슷한 표현끼리 묶은 결과를 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              groups: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    category: {
                      type: 'string',
                      enum: CATEGORIES,
                    },
                    member_indexes: { type: 'array', items: { type: 'integer' } },
                    is_unclear: { type: 'boolean' },
                  },
                  required: ['label', 'category', 'member_indexes', 'is_unclear'],
                },
              },
            },
            required: ['groups'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_expression_groups' },
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
    throw new Error('LLM 응답에서 report_expression_groups 도구 호출을 찾지 못했습니다.');
  }

  const rawGroups = (toolUseBlock.input as { groups?: unknown }).groups;
  if (!Array.isArray(rawGroups)) {
    throw new Error('LLM 응답의 groups 필드가 배열이 아닙니다.');
  }

  const output: RawGroup[] = [];
  for (const g of rawGroups) {
    if (typeof g !== 'object' || g === null) continue;
    const label = (g as Record<string, unknown>).label;
    const category = (g as Record<string, unknown>).category;
    const memberIndexes = (g as Record<string, unknown>).member_indexes;
    const isUnclear = (g as Record<string, unknown>).is_unclear;
    if (typeof label !== 'string' || label.trim().length === 0) continue;
    if (!Array.isArray(memberIndexes)) continue;

    output.push({
      label: label.trim(),
      category: CATEGORIES.includes(category as FeatureCategory)
        ? (category as FeatureCategory)
        : '일반적표현', // 형식이 어긋나면 보수적으로 "일반적 표현"(구체성 인정 안 함) 처리
      memberIndexes: memberIndexes.filter((i): i is number => typeof i === 'number'),
      isUnclear: isUnclear === true,
    });
  }
  return output;
}

// ── 3-2단계: 노이즈 필터 (코드, v1.2 결정 1) ──

/**
 * "묶기" 직후, "최소기준 판정" 이전에 적용하는 저장 자체의 문턱이다.
 * 여기서 걸러진 묶음은 brand_feature_candidates에 아예 안 남는다 — tier가
 * '관찰중'인 것과는 다르다(관찰중은 저장은 되지만 화면에서 약한 신호로
 * 표시됨, 여긴 저장 자체를 안 함).
 */
function filterNoiseGroups(groups: RawGroup[], uniqueExpressions: UniqueExpression[]): RawGroup[] {
  return groups.filter((g) => {
    if (g.isUnclear) return false;
    const totalMemberCount = g.memberIndexes
      .map((i) => uniqueExpressions[i])
      .filter((u): u is UniqueExpression => !!u)
      .reduce((sum, u) => sum + u.memberIds.length, 0);
    return totalMemberCount > 1; // 독립 관측 1건뿐이면 제외
  });
}

// ── 4단계: 최소기준 판정 + 강도 + tier 계산 (코드, 결정적) ──

export interface EvaluatedGroup {
  label: string;
  category: FeatureCategory;
  members: StoredBrandExpression[];
  coverage: { questions: number; engines: number; days: number };
  strength: number;
  /**
   * ⚠️ tier(v1.2)와 이름이 비슷해 보이지만 다른 걸 판정한다 — 헷갈리지 말 것.
   *  passedMinCriteria: "질문2+/AI3+/날짜3+ 3개 전부" + "유도된 표현만으로
   *    구성되지 않음"까지 포함한 v1.1 원래 통과 기준. 대표 특징·지역맥락·
   *    잘못된인지 "선정"에 이 필드를 쓴다(선정 자격 판단용).
   *  tier: v1.2 결정 1이 명시한 대로 딱 3개 조건(질문/AI/날짜)의 충족
   *    개수만으로 정해진다 — 유도 여부는 안 본다. 화면 배지 표시 전용이라
   *    passedMinCriteria가 false여도(예: 전부 유도된 표현) tier가 '확정'로
   *    나올 수 있다. 이 괴리는 의도된 것이다: "확정(=반복확인됨)"이라는
   *    표는 일반적인 경우를 설명한 것이지, 두 필드가 항상 같다는 뜻이 아님.
   */
  passedMinCriteria: boolean;
  tier: FeatureTier;
  isConflicting: boolean;
}

/**
 * 판정 규칙(2026-09-01 확정, v1.2 결정 1로 tier 계산 추가):
 *  - 최소기준 5번("AI 3개 이상")은 절대값 고정. 유효 엔진 수가 3개 미만인
 *    특징은 이 절대 기준을 통과할 수 없다 — 의도된 동작이다(9/7~8 첫
 *    진단 종료 후 재검토 예정, 그 전엔 임의로 완화 안 함).
 *  - v1.1 ④(동적 분모)는 강도 계산(AI 범위 비율)에만 적용한다.
 *  - tier는 질문/AI/날짜 3개 조건을 각각 독립 판정한 뒤 몇 개를 충족했는지로
 *    센다 — 하나만 보고 판단하지 않는다(v1.2 결정 1).
 */
function evaluateGroups(
  groups: RawGroup[],
  uniqueExpressions: UniqueExpression[],
  expressionsById: Map<string, StoredBrandExpression>,
  totalRecognitionQuestions: number,
  totalDiagnosisDays: number,
  validEngineCount: number
): EvaluatedGroup[] {
  return groups.map((g) => {
    const memberIds = g.memberIndexes
      .map((i) => uniqueExpressions[i])
      .filter((u): u is UniqueExpression => !!u)
      .flatMap((u) => u.memberIds);

    const members = memberIds
      .map((id) => expressionsById.get(id))
      .filter((m): m is StoredBrandExpression => !!m);

    const questionSet = new Set(members.map((m) => m.queryId));
    const engineSet = new Set(members.map((m) => m.engine));
    const daySet = new Set(members.map((m) => m.observedDate));

    const nonInducedCount = members.filter((m) => !m.isInduced).length;
    const conflictCount = members.filter((m) => m.conflictsWithBrandFacts).length;

    const qOk = questionSet.size >= 2; // 인지 질문 3개 중 2개 이상
    const aOk = engineSet.size >= 3; // AI 6개 중 3개 이상 (절대값, 위 주석 참고)
    const dOk = daySet.size >= 3; // 서로 다른 날짜 3일 이상
    const conditionsMet = [qOk, aOk, dOk].filter(Boolean).length;

    const tier: FeatureTier =
      conditionsMet === 3 ? '확정' : conditionsMet === 2 ? '가능성있음' : '관찰중';

    const passedMinCriteria = qOk && aOk && dOk && nonInducedCount > 0;

    const qRatio = totalRecognitionQuestions > 0
      ? Math.min(questionSet.size / totalRecognitionQuestions, 1)
      : 0;
    const aRatio = validEngineCount > 0 ? Math.min(engineSet.size / validEngineCount, 1) : 0;
    const dRatio = totalDiagnosisDays > 0 ? Math.min(daySet.size / totalDiagnosisDays, 1) : 0;

    return {
      label: g.label,
      category: g.category,
      members,
      coverage: { questions: questionSet.size, engines: engineSet.size, days: daySet.size },
      strength: (qRatio + aRatio + dRatio) / 3,
      passedMinCriteria,
      tier,
      // 절반 넘게 브랜드 사실과 충돌하면 그 묶음 전체를 "충돌 특징"으로 본다.
      isConflicting: members.length > 0 && conflictCount > members.length / 2,
    };
  });
}

// ── 4-2단계: 전체 후보 저장 (코드, v1.2 결정 1) ──

interface CandidateWithId {
  group: EvaluatedGroup;
  candidateId: string;
}

async function saveAllCandidates(
  diagnosisId: string,
  brandId: string,
  evaluated: EvaluatedGroup[],
  totalRecognitionQuestions: number,
  totalDiagnosisDays: number,
  validEngineCount: number
): Promise<CandidateWithId[]> {
  if (evaluated.length === 0) return [];

  const toSave: BrandFeatureCandidateToSave[] = evaluated.map((g) => ({
    diagnosisId,
    brandId,
    featureName: g.label,
    category: g.category,
    questionCount: g.coverage.questions,
    questionTotal: totalRecognitionQuestions,
    engineCount: g.coverage.engines,
    engineTotal: validEngineCount,
    dayCount: g.coverage.days,
    dayTotal: totalDiagnosisDays,
    passedMinCriteria: g.passedMinCriteria,
    tier: g.tier,
    intensityScore: g.strength,
    evidenceExpressionIds: g.members.map((m) => m.id),
  }));

  const ids = await saveBrandFeatureCandidates(toSave);
  // ⚠️ saveBrandFeatureCandidates가 입력 개수만큼 id를 못 돌려주면(저장 실패
  // 등) zip이 어긋난다 — 그 경우 뒤 단계(대표 특징 선정)가 candidateId 없는
  // 항목을 만나지 않도록 아예 빈 배열로 처리한다(부분 저장 상태로 진행하지 않음).
  if (ids.length !== evaluated.length) {
    console.error(
      `brand_feature_candidates 저장 개수가 안 맞아 이번 진단(${diagnosisId})의 특징 선정을 건너뜁니다.`
    );
    return [];
  }
  return evaluated.map((group, i) => ({ group, candidateId: ids[i] }));
}

// ── 5단계: 대표 특징 + 지역 맥락 선정 (코드) ──

/**
 * 원안 7번 우선순위(여러 질문 자발 등장 > 여러 AI·날짜 유지 > 구체적 > 근거
 * 명확)를 strength(세 범위 평균) 내림차순 정렬로 근사한다 — 세 요소를 이미
 * 균등하게 반영하는 지표라 정렬 기준으로 충분하다고 판단.
 *
 * "최소 하나는 구체적 특징이어야 한다"만 별도로 강제한다(원안 7번 마지막
 * 문단) — 상위 3개가 전부 '일반적표현'이면 그 다음으로 강한 구체적 특징을
 * 대신 끌어온다.
 *
 * category='지역_조건'은 이 풀에서 제외한다(v1.2 결정 2) — 지역은 대표
 * 특징 슬롯을 안 쓰고 별도의 location_context_id를 쓴다.
 */
function selectRepresentativeFeatures(candidates: CandidateWithId[]): CandidateWithId[] {
  const pool = candidates
    .filter((c) => c.group.category !== '지역_조건' && c.group.passedMinCriteria && !c.group.isConflicting)
    .sort((a, b) => b.group.strength - a.group.strength);

  const top3 = pool.slice(0, 3);
  const hasConcrete = top3.some((c) => c.group.category !== '일반적표현');

  if (!hasConcrete && top3.length > 0) {
    const concrete = pool.find(
      (c) => c.group.category !== '일반적표현' && !top3.includes(c)
    );
    if (concrete) {
      top3[top3.length - 1] = concrete;
      top3.sort((a, b) => b.group.strength - a.group.strength);
    }
    // 구체적 특징이 후보군에 아예 없으면 여기서 못 바꾼다 — 8단계
    // 자동검수가 "구체적 특징 없음"을 걸러내야 하는 케이스로 남긴다.
  }

  return top3;
}

/**
 * category='지역_조건'인 후보 중 최소기준을 통과한 가장 강한 것 1개
 * (v1.2 결정 3-2) — 대표 특징과 별개 슬롯이라 상한도 3개가 아니라 1개다.
 */
function selectLocationContext(candidates: CandidateWithId[]): CandidateWithId | null {
  const pool = candidates
    .filter((c) => c.group.category === '지역_조건' && c.group.passedMinCriteria && !c.group.isConflicting)
    .sort((a, b) => b.group.strength - a.group.strength);
  return pool[0] ?? null;
}

/** 원안 9번 "잘못된 인지" — 최소기준을 통과했지만 브랜드 사실과 충돌하는 특징 중 가장 강한 것 하나. */
function findConflictingFeature(candidates: CandidateWithId[]): CandidateWithId | null {
  const conflicting = candidates
    .filter((c) => c.group.passedMinCriteria && c.group.isConflicting)
    .sort((a, b) => b.group.strength - a.group.strength);
  return conflicting[0] ?? null;
}

// ── 6단계: 문장 작성 (LLM, Sonnet) ──

function buildWritingPrompt(
  brandName: string,
  features: CandidateWithId[],
  locationContext: CandidateWithId | null
): string {
  const featureBlocks = features
    .map((c, i) => {
      const examples = c.group.members
        .slice(0, 3)
        .map((m) => `    · "${m.sourceSentence}"`)
        .join('\n');
      return `${i + 1}. ${c.group.label}\n${examples}`;
    })
    .join('\n');

  const locationBlock = locationContext
    ? `\n\n지역/조건 맥락(문장에 특징으로 나열하지 말고, 자연스러운 문맥으로만 녹여라): ${locationContext.group.label}`
    : '';

  return `"${brandName}"에 대해 AI 답변에서 반복 확인된 특징 ${features.length}개가 아래에 근거 문장과 함께 있다.

선정된 특징과 근거:
${featureBlocks}${locationBlock}

위 근거 "안에서만" 정보를 써서, "${brandName}"을 설명하는 한 문장을 만들어라.

작성 규칙:
1. 위 근거에 없는 특징이나 사실을 추가하지 마라.
2. 최상급·과장 표현(최고, 유일, 압도적, 국내 최초 등)을 쓰지 마라.
3. 근거 문장의 부정적인 뉘앙스를 긍정적으로 바꾸지 마라.
4. 사용자가 한 번에 이해할 수 있는 자연스러운 한국어 문장으로 써라.
5. 60자 안팎의 한 문장으로 써라.
6. 위에 선정된 특징만 조합해라 — 그 외 정보를 넣지 마라.
7. 지역/조건 맥락이 주어졌으면 특징처럼 나열하지 말고 문맥으로만 자연스럽게 녹여 써라(예: "OO구에서 임플란트로 반복 언급됩니다"처럼). 주어지지 않았으면 무시해라.`;
}

async function writeOneLiner(
  brandName: string,
  features: CandidateWithId[],
  locationContext: CandidateWithId | null
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

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
      messages: [{ role: 'user', content: buildWritingPrompt(brandName, features, locationContext) }],
      tools: [
        {
          name: 'report_one_liner',
          description: '작성한 브랜드 한 줄 문장을 보고한다.',
          input_schema: {
            type: 'object',
            properties: { one_liner: { type: 'string' } },
            required: ['one_liner'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_one_liner' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const blocks: { type: string; input?: unknown }[] = data.content ?? [];
  const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
  const oneLiner = (toolUseBlock?.input as { one_liner?: unknown })?.one_liner;

  if (typeof oneLiner !== 'string' || oneLiner.trim().length === 0) {
    throw new Error('LLM 응답에서 one_liner를 찾지 못했습니다.');
  }
  return oneLiner.trim();
}

// ── 7단계: 자동 검수 (LLM, Sonnet — 문장작성과 별도 호출) ──

interface ReviewResult {
  passed: boolean;
  violatedFeatureLabels: string[];
  reason: string | null;
}

function buildReviewPrompt(
  brandName: string,
  oneLiner: string,
  features: CandidateWithId[],
  locationContext: CandidateWithId | null
): string {
  const featureBlocks = features
    .map((c, i) => {
      const examples = c.group.members
        .slice(0, 3)
        .map((m) => `    · "${m.sourceSentence}"`)
        .join('\n');
      return `${i + 1}. ${c.group.label}\n${examples}`;
    })
    .join('\n');

  const locationBlock = locationContext
    ? `\n\n지역/조건 맥락(문장에 특징으로 나열되면 안 되고, 문맥으로만 쓰였어야 함): ${locationContext.group.label}`
    : '';

  return `아래는 "${brandName}"에 대해 자동 생성된 브랜드 한 줄과, 그 근거로 쓰인 특징들이다. 너는 이 문장을 검수하는 역할이다 — 이 문장을 쓴 사람이 아니라, 이 문장이 규칙을 어겼는지 의심하고 확인하는 감사자다.

생성된 문장: "${oneLiner}"

사용된 특징과 근거:
${featureBlocks}${locationBlock}

아래 기준을 하나씩 확인해라:
1. 문장에 쓰인 모든 내용에 위 근거가 있는가?
2. 근거보다 강한 표현(최상급·과장)을 쓰지 않았는가?
3. 근거 문장의 긍정·부정 뉘앙스를 바꾸지 않았는가?
4. 근거에 없는 내용을 추가하지 않았는가?
5. 문장의 각 부분에서 위 근거 중 하나로 되짚어갈 수 있는가?
6. 지역/조건 맥락이 주어졌다면, 특징처럼 나열되지 않고 문맥으로만 자연스럽게 쓰였는가?

하나라도 어겼으면 어느 특징(위 번호, 또는 지역/조건 맥락) 때문인지 짚어서 보고해라. 지역/조건 맥락이 위반의 원인이면 violated_feature_labels에 그 맥락의 이름을 그대로 넣어라. 근거가 모호하면 통과시키지 말고 위반으로 판단해라.`;
}

async function reviewOneLiner(
  brandName: string,
  oneLiner: string,
  features: CandidateWithId[],
  locationContext: CandidateWithId | null
): Promise<ReviewResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

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
      messages: [{ role: 'user', content: buildReviewPrompt(brandName, oneLiner, features, locationContext) }],
      tools: [
        {
          name: 'report_review_result',
          description: '검수 결과를 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              passed: { type: 'boolean' },
              violated_feature_labels: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
            required: ['passed', 'violated_feature_labels'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_review_result' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const blocks: { type: string; input?: unknown }[] = data.content ?? [];
  const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
  const input = toolUseBlock?.input as
    | { passed?: unknown; violated_feature_labels?: unknown; reason?: unknown }
    | undefined;

  if (!input || typeof input.passed !== 'boolean') {
    throw new Error('LLM 응답에서 report_review_result 도구 호출을 찾지 못했습니다.');
  }

  return {
    passed: input.passed,
    violatedFeatureLabels: Array.isArray(input.violated_feature_labels)
      ? input.violated_feature_labels.filter((l): l is string => typeof l === 'string')
      : [],
    reason: typeof input.reason === 'string' ? input.reason : null,
  };
}

// ── 10단계: AI 간 "서로 다르게 설명하는 지점" 탐지 (LLM, Sonnet — Day21) ──

/**
 * 안전장치 1(작업지시서 3-3) — tier='관찰중'은 애초에 이 풀에 안 넣는다.
 * 최소한의 반복성 있는 특징끼리만 비교해서, 우연한 1회성 표현을 "대립"으로
 * 잡지 않기 위함. isConflicting(brand_facts와 충돌하는 "잘못된 인지")도
 * 같이 뺀다 — "AI 사실과 다름"과 "AI끼리 서로 다르게 말함"은 다른 축이라
 * 섞으면 화면에서 혼동을 준다(2026-09-02, 코난 판단 — 작업지시서에 명시는
 * 없으나 v1.2에서 이미 다른 화면들이 잘못된인지를 별도 취급해온 것과 같은
 * 방향으로 맞춤).
 */
function selectConflictDetectionPool(candidates: CandidateWithId[]): CandidateWithId[] {
  return candidates.filter(
    (c) => (c.group.tier === '확정' || c.group.tier === '가능성있음') && !c.group.isConflicting
  );
}

interface RawConflictPair {
  featureAIndex: number;
  featureBIndex: number;
  draftSummary: string;
}

function buildConflictDetectionPrompt(brandName: string, pool: CandidateWithId[]): string {
  const numbered = pool
    .map((c, i) => {
      const examples = c.group.members
        .slice(0, 3)
        .map((m) => `    · "${m.sourceSentence}"`)
        .join('\n');
      return `[${i}] ${c.group.label} (${c.group.category})\n${examples}`;
    })
    .join('\n');

  return `아래는 "${brandName}"에 대해 여러 AI 답변 엔진에서 반복 확인된 특징들이다. AI마다 브랜드를 설명하는 관점이 다를 수 있는데, 그중 서로 의미상 진짜 반대되거나 양립하기 어려운 설명이 있는지 찾아라.

특징 목록:
${numbered}

규칙:
1. 단순히 "다른 주제"인 쌍은 대립이 아니다(예: "임플란트 전문"과 "정밀 보철"은 서로 다른 진료 분야를 말할 뿐 반대되지 않는다) — 이런 건 절대 대립으로 보고하지 마라.
2. 진짜 의미상 반대되는 쌍만 찾아라(예: "빠른 진료"와 "충분한 상담 시간"처럼 양립하기 어려운 설명, "저렴한 비용"과 "고가 프리미엄"처럼 정면으로 배치되는 포지셔닝).
3. 확신이 없으면 아예 보고하지 마라 — 애매한 건 빼는 게 낫다.
4. 대립 쌍마다 왜 대립인지 60자 안팎의 중립적인 한국어 문장으로 요약해라. "모순", "오류", "틀렸다" 같은 단정적·부정적 단어는 절대 쓰지 마라 — AI마다 설명이 다른 건 정상적인 현상이지 브랜드의 결함이 아니다. "~로 설명하는 AI가 있는 반면, ~로 설명하는 AI도 있습니다"처럼 사실을 나열하는 톤으로 써라.
5. 대립이 하나도 없으면 빈 배열을 보고해라 — 억지로 만들지 마라.`;
}

async function detectFeatureConflicts(
  brandName: string,
  pool: CandidateWithId[]
): Promise<RawConflictPair[]> {
  if (pool.length < 2) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

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
      messages: [{ role: 'user', content: buildConflictDetectionPrompt(brandName, pool) }],
      tools: [
        {
          name: 'report_feature_conflicts',
          description: '서로 대립하는 특징 쌍을 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              conflicts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    feature_a_index: { type: 'integer' },
                    feature_b_index: { type: 'integer' },
                    summary: { type: 'string' },
                  },
                  required: ['feature_a_index', 'feature_b_index', 'summary'],
                },
              },
            },
            required: ['conflicts'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_feature_conflicts' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const blocks: { type: string; input?: unknown }[] = data.content ?? [];
  const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
  const rawConflicts = (toolUseBlock?.input as { conflicts?: unknown })?.conflicts;
  if (!Array.isArray(rawConflicts)) return [];

  const output: RawConflictPair[] = [];
  const seen = new Set<string>(); // 무순서 쌍 중복 방지
  for (const c of rawConflicts) {
    if (typeof c !== 'object' || c === null) continue;
    const a = (c as Record<string, unknown>).feature_a_index;
    const b = (c as Record<string, unknown>).feature_b_index;
    const summary = (c as Record<string, unknown>).summary;
    if (typeof a !== 'number' || typeof b !== 'number' || a === b) continue;
    if (a < 0 || a >= pool.length || b < 0 || b >= pool.length) continue;
    if (typeof summary !== 'string' || summary.trim().length === 0) continue;

    const key = [a, b].sort().join('-');
    if (seen.has(key)) continue;
    seen.add(key);

    output.push({ featureAIndex: a, featureBIndex: b, draftSummary: summary.trim() });
  }
  return output;
}

interface ConfirmedConflictPair {
  featureAIndex: number;
  featureBIndex: number;
  summary: string;
}

function buildConflictReviewPrompt(
  brandName: string,
  pool: CandidateWithId[],
  pairs: RawConflictPair[]
): string {
  const pairBlocks = pairs
    .map((p, i) => {
      const a = pool[p.featureAIndex];
      const b = pool[p.featureBIndex];
      return `${i}. "${a.group.label}" ↔ "${b.group.label}"\n   제안된 요약: "${p.draftSummary}"`;
    })
    .join('\n');

  return `아래는 "${brandName}"에 대해 자동으로 탐지된 "AI들이 다르게 설명하는 지점" 후보 쌍이다. 너는 이걸 검수하는 감사자다 — 진짜 의미상 반대되는지 의심하고 확인해라.

후보 쌍:
${pairBlocks}

각 쌍에 대해 확인해라:
1. 두 특징이 정말 의미상 서로 반대되거나 양립하기 어려운가? (단순히 다른 주제·다른 진료 분야면 반려)
2. 요약 문장이 "모순", "오류", "틀렸다" 같은 단정적·부정적 단어를 안 썼는가?
3. 요약 문장이 사실을 중립적으로 나열하는 톤인가?

하나라도 걸리면 그 쌍은 통과시키지 마라(confirmed: false). 확신이 없어도 통과시키지 마라 — 애매하면 반려가 기본값이다. 통과한 쌍은 필요하면 요약 문장을 더 다듬어서 최종 문구로 내라(2번·3번 기준을 스스로 만족시키도록).`;
}

async function reviewFeatureConflicts(
  brandName: string,
  pool: CandidateWithId[],
  pairs: RawConflictPair[]
): Promise<ConfirmedConflictPair[]> {
  if (pairs.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

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
      messages: [{ role: 'user', content: buildConflictReviewPrompt(brandName, pool, pairs) }],
      tools: [
        {
          name: 'report_conflict_review',
          description: '대립 후보 쌍의 검수 결과를 보고한다.',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    pair_index: { type: 'integer' },
                    confirmed: { type: 'boolean' },
                    summary: { type: 'string' },
                  },
                  required: ['pair_index', 'confirmed'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_conflict_review' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API 오류 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const blocks: { type: string; input?: unknown }[] = data.content ?? [];
  const toolUseBlock = blocks.find((b) => b.type === 'tool_use');
  const rawResults = (toolUseBlock?.input as { results?: unknown })?.results;
  if (!Array.isArray(rawResults)) return [];

  const output: ConfirmedConflictPair[] = [];
  for (const r of rawResults) {
    if (typeof r !== 'object' || r === null) continue;
    const idx = (r as Record<string, unknown>).pair_index;
    const confirmed = (r as Record<string, unknown>).confirmed;
    const summary = (r as Record<string, unknown>).summary;
    if (typeof idx !== 'number' || idx < 0 || idx >= pairs.length) continue;
    if (confirmed !== true) continue; // 안전장치 3 — 확신 없으면(false/누락) 저장 안 함

    const finalSummary = typeof summary === 'string' && summary.trim().length > 0
      ? summary.trim()
      : pairs[idx].draftSummary;

    output.push({
      featureAIndex: pairs[idx].featureAIndex,
      featureBIndex: pairs[idx].featureBIndex,
      summary: finalSummary,
    });
  }
  return output;
}

/**
 * 10단계 전체를 감싸는 진입점 — 실패해도 예외를 밖으로 던지지 않는다.
 * 이 단계는 브랜드 한 줄 본문(1~9단계)이 이미 저장된 뒤에 붙는 보조
 * 인사이트라, 여기서 실패한다고 진단 완료 처리 자체를 막으면 안 된다
 * (synthesizeBrandOneLiner 호출부 참고) — 실패 시 3번 칸은 그냥 빈
 * 상태로 남고, 이는 "대립 없음"과 화면상 구분이 안 되지만 완료 기준
 * 문서(4번)도 오늘은 실데이터 검증을 요구하지 않는다.
 */
async function detectAndSaveFeatureConflicts(
  diagnosisId: string,
  brandId: string,
  brandName: string,
  candidates: CandidateWithId[]
): Promise<string[]> {
  const pool = selectConflictDetectionPool(candidates);
  if (pool.length < 2) return [];

  let rawPairs: RawConflictPair[];
  try {
    rawPairs = await retryWithBackoff(
      () => detectFeatureConflicts(brandName, pool),
      3,
      isRetryableLLMError
    );
  } catch (error) {
    console.error(`특징 대립 탐지 실패 (diagnosis=${diagnosisId}):`, error);
    return [];
  }
  if (rawPairs.length === 0) return [];

  let confirmed: ConfirmedConflictPair[];
  try {
    confirmed = await retryWithBackoff(
      () => reviewFeatureConflicts(brandName, pool, rawPairs),
      3,
      isRetryableLLMError
    );
  } catch (error) {
    console.error(`특징 대립 검수 실패 (diagnosis=${diagnosisId}):`, error);
    return [];
  }
  if (confirmed.length === 0) return [];

  const toSave: BrandFeatureConflictToSave[] = confirmed.map((c) => ({
    diagnosisId,
    brandId,
    featureAId: pool[c.featureAIndex].candidateId,
    featureBId: pool[c.featureBIndex].candidateId,
    conflictSummary: c.summary,
  }));

  return saveBrandFeatureConflicts(toSave);
}

// ── 오케스트레이션 ──

export interface SynthesisResult {
  diagnosisId: string;
  savedOneLinerIds: string[];
  savedConflictIds: string[];
}

/** 화면(브랜드 인지, Day 20)도 같은 "전체 진단일 수" 계산이 필요해서 export한다. */
export function diagnosisDurationDays(diagnosis: StoredDiagnosis, endedAt: string): number {
  const start = new Date(`${diagnosis.startedAt}T00:00:00Z`);
  const end = new Date(`${endedAt}T00:00:00Z`);
  const diffDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(diffDays + 1, 1); // 시작일 포함
}

/**
 * 진단 회차 하나를 종료 처리하면서 브랜드 한 줄을 합성한다.
 * 호출부(app/api/aggregate-daily/route.ts)가 diagnoses.status를 이미
 * completed로 바꾸기 전에, 혹은 바꾸는 것과 같은 트랜잭션 흐름으로 호출한다.
 */
export async function synthesizeBrandOneLiner(
  diagnosis: StoredDiagnosis,
  brandName: string,
  endedAt: string
): Promise<SynthesisResult> {
  const expressions = await fetchBrandExpressionsForBrand(
    diagnosis.brandId,
    diagnosis.startedAt,
    endedAt
  );

  const recognitionQueries = await fetchActiveQueries(['인지']);
  const questionIds = recognitionQueries.map((q) => q.id);
  const totalRecognitionQuestions = recognitionQueries.length;

  const { periodStart } = kstDayBoundsUtc(diagnosis.startedAt);
  const { periodEnd } = kstDayBoundsUtc(endedAt);
  const engineList = await fetchValidEnginesForQueriesInPeriod(questionIds, periodStart, periodEnd);

  const savedOneLinerIds: string[] = [];

  // 근거가 아예 없으면 LLM을 부르지 않는다 (원안 9번 "근거 부족" — 억지로 문장 안 만듦)
  if (expressions.length === 0) {
    const id = await saveBrandOneLiner({
      diagnosisId: diagnosis.id,
      brandId: diagnosis.brandId,
      status: '근거부족',
      oneLiner: null,
      selectedFeatureIds: null,
      locationContextId: null,
      questionIds,
      engineList,
    });
    if (id) savedOneLinerIds.push(id);
    return { diagnosisId: diagnosis.id, savedOneLinerIds, savedConflictIds: [] };
  }

  const expressionsById = new Map(expressions.map((e) => [e.id, e]));
  const uniqueExpressions = buildUniqueExpressions(expressions);
  const rawGroups = await retryWithBackoff(
    () => groupSimilarExpressions(brandName, uniqueExpressions),
    3,
    isRetryableLLMError
  );
  const filteredGroups = filterNoiseGroups(rawGroups, uniqueExpressions);

  const totalDiagnosisDays = diagnosisDurationDays(diagnosis, endedAt);
  const evaluated = evaluateGroups(
    filteredGroups,
    uniqueExpressions,
    expressionsById,
    totalRecognitionQuestions,
    totalDiagnosisDays,
    engineList.length
  );

  // 노이즈 필터를 통과한 묶음 전부를 저장한다(v1.2 결정 1) — 통과/미통과
  // 관계없이 상한 없이. 아래 대표 특징·지역맥락·잘못된인지 선정은 전부 이미
  // 저장된 candidateId를 참조하는 방식으로 진행한다(brand_one_liners에는
  // id 참조만 남긴다).
  const candidates = await saveAllCandidates(
    diagnosis.id,
    diagnosis.brandId,
    evaluated,
    totalRecognitionQuestions,
    totalDiagnosisDays,
    engineList.length
  );

  const locationContext = selectLocationContext(candidates);

  // ── 정상 계열(반복확인/초기한줄/근거부족) ──
  let selected = selectRepresentativeFeatures(candidates);

  if (selected.length === 0) {
    const id = await saveBrandOneLiner({
      diagnosisId: diagnosis.id,
      brandId: diagnosis.brandId,
      status: '근거부족',
      oneLiner: null,
      selectedFeatureIds: null,
      locationContextId: null,
      questionIds,
      engineList,
    });
    if (id) savedOneLinerIds.push(id);
  } else {
    // 문장작성 → 자동검수(별도 호출) → 위반 특징 있으면 빼고 재시도(최대 2회)
    //
    // ⚠️ LLM 문장작성(원안 8번 "선정된 특징 2~3개만 사용해 한 문장으로
    // 조합")은 특징이 2개 이상일 때만 부른다. 특징이 1개면(처음부터
    // 1개였거나 재시도 중 줄었거나) LLM을 아예 안 부르고, 원안 9번이
    // "초기한줄"용으로 정의해둔 문구를 코드에서 템플릿으로 직접 조합한다
    // (2026-09-01, 루아 지적으로 수정) — "초기한줄" 문장은 확신 있는
    // "브랜드 한 줄"이 아니라는 게 원안의 핵심이라, LLM이 매번 다르게
    // 표현하게 두지 않고 고정 문구로 못박는다. one_liner는 항상 status와
    // 같이 저장되고, 화면은 값을 그대로 표시하기만 하면 되므로(판단은
    // 데이터 레이어에서 끝남) 화면 쪽에 별도 재조립 로직이 없어도 된다.
    const originalFeatureCount = selected.length;
    const excludedByReview: string[] = [];
    let retryCount = 0;
    let oneLiner: string | null = null;
    let usedLocationContext = locationContext;

    for (let attempt = 0; attempt < 2 && selected.length >= 2; attempt++) {
      const draft = await writeOneLiner(brandName, selected, usedLocationContext);
      const review = await reviewOneLiner(brandName, draft, selected, usedLocationContext);

      if (review.passed) {
        oneLiner = draft;
        break;
      }

      retryCount++;
      console.error(
        `브랜드 한 줄 자동검수 실패 (diagnosis=${diagnosis.id}, attempt=${attempt}): ${review.reason ?? '사유 미상'} — 위반 특징: ${review.violatedFeatureLabels.join(', ')}`
      );
      excludedByReview.push(...review.violatedFeatureLabels);
      selected = selected.filter((c) => !review.violatedFeatureLabels.includes(c.group.label));
      if (usedLocationContext && review.violatedFeatureLabels.includes(usedLocationContext.group.label)) {
        usedLocationContext = null; // 지역 맥락이 위반 원인이면 다음 재시도에서 아예 뺀다
      }
    }

    let status: BrandOneLinerToSave['status'];
    if (oneLiner && selected.length >= 2) {
      status = '반복확인';
    } else if (selected.length === 1) {
      status = '초기한줄';
      // 원안 9번 문구 그대로 — LLM 없이 결정적으로 조합(재현 가능).
      // 지역 맥락은 이 템플릿에 안 넣는다 — "특징 2~3개만 조합"하는 완성된
      // 문장 케이스에서만 문맥으로 쓰기로 했다(v1.2 결정 3-3 범위 밖).
      oneLiner = `현재 AI는 ${brandName}를 '${selected[0].group.label}'와 가장 강하게 연결하고 있습니다. 아직 다른 특징은 반복 확인 중입니다.`;
      usedLocationContext = null;
    } else {
      status = '근거부족';
      oneLiner = null;
      usedLocationContext = null;
    }

    const id = await saveBrandOneLiner({
      diagnosisId: diagnosis.id,
      brandId: diagnosis.brandId,
      status,
      oneLiner,
      selectedFeatureIds: status === '근거부족' ? null : selected.map((c) => c.candidateId),
      // ⚠️ location_context_id는 "실제로 이 문장에 문맥으로 반영된"
      // 후보만 가리킨다 — 그냥 통과했다는 사실만으로는 안 채운다(이름이
      // 내용과 다르면 안 된다는 원칙, CLAUDE.md 절대원칙 1). 화면의
      // "지역 정보로 반영됨" 배지는 이 컬럼이 아니라 후보 자체의
      // category+tier로 별도 판단한다.
      locationContextId: status === '반복확인' ? (usedLocationContext?.candidateId ?? null) : null,
      questionIds,
      engineList,
      generationLog:
        retryCount > 0 ? { originalFeatureCount, retryCount, excludedByReview } : null,
    });
    if (id) savedOneLinerIds.push(id);
  }

  // ── 잘못된 인지 (원안 9번, 정상 계열과 별개 행으로 저장) ──
  const conflicting = findConflictingFeature(candidates);
  if (conflicting) {
    const id = await saveBrandOneLiner({
      diagnosisId: diagnosis.id,
      brandId: diagnosis.brandId,
      status: '잘못된인지',
      oneLiner: `AI가 '${conflicting.group.label}'라고 인지하고 있지만, 입력된 브랜드 정보와 일치하지 않습니다.`,
      selectedFeatureIds: [conflicting.candidateId],
      locationContextId: null,
      questionIds,
      engineList,
    });
    if (id) savedOneLinerIds.push(id);
  }

  // ── (Day21) AI 간 "서로 다르게 설명하는 지점" — 위 본문과 별개 단계 ──
  const savedConflictIds = await detectAndSaveFeatureConflicts(
    diagnosis.id,
    diagnosis.brandId,
    brandName,
    candidates
  );

  return { diagnosisId: diagnosis.id, savedOneLinerIds, savedConflictIds };
}

// ── 야간 크론 진입점 ──

export interface DiagnosisCompletionSummary {
  checked: number;
  completed: string[]; // diagnoses.id 목록
  errors: string[];
}

/**
 * 매일 밤 집계 크론이 그날(dateKST) 집계를 끝낸 뒤 호출한다. 만료된
 * 진단이 있으면 브랜드 한 줄을 합성하고 diagnoses를 completed로 바꾼다.
 * (2026-09-01 확정 — 별도 트리거 없이 야간 크론에 편입)
 */
export async function checkAndCompleteDiagnoses(dateKST: string): Promise<DiagnosisCompletionSummary> {
  const expired = await fetchExpiredDiagnoses(dateKST);
  if (expired.length === 0) {
    return { checked: 0, completed: [], errors: [] };
  }

  const knownBrands = await fetchKnownBrands();
  const completed: string[] = [];
  const errors: string[] = [];

  for (const diagnosis of expired) {
    try {
      const brand = knownBrands.find((b) => b.brandId === diagnosis.brandId);
      if (!brand) {
        throw new Error(`brandId ${diagnosis.brandId}를 brands 목록에서 못 찾음`);
      }

      await synthesizeBrandOneLiner(diagnosis, brand.name, dateKST);

      const ok = await completeDiagnosis(diagnosis.id, dateKST);
      if (!ok) throw new Error('diagnoses 상태 업데이트 실패');

      completed.push(diagnosis.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`진단 종료 처리 실패 (diagnosis=${diagnosis.id}):`, msg);
      errors.push(`diagnosis ${diagnosis.id}: ${msg}`);
    }
  }

  return { checked: expired.length, completed, errors };
}
