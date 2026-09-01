// lib/brand-one-liner.ts

/**
 * 브랜드 한 줄 로직 4-2단계 — 진단 종료 시 합성 (2026-09-01)
 * ═══════════════════════════════════════════════════════
 *
 * 작업지시서_브랜드한줄로직_v1.1.md 4-2, 원안(브랜드 한 줄 생성 로직 v1.0)
 * 4~10번을 구현한다. 진단 회차 하나가 끝날 때(diagnoses: collecting→completed)
 * 딱 한 번 실행된다 — lib/aggregator.ts처럼 매일 도는 게 아니다.
 *
 * 처리 순서 (전부 이 파일 안에서):
 *   1. 그 진단 기간의 brand_expressions 전부 조회
 *   2. 완전히 같은 표현 문자열끼리 먼저 코드로 합침(중복 제거) — 그래야
 *      LLM에 보낼 항목 수가 줄어든다. 예: 7일치 수백 건이어도 서로 다른
 *      표현 문자열은 훨씬 적다.
 *   3. 그 "고유 표현 목록"을 LLM(Sonnet)에 보내서 비슷한 의미끼리 묶는다
 *      (원안 4번) — 원문은 그대로, memberIds로만 연결
 *   4. 묶음별로 최소기준(원안 5번) 통과 여부 + 강도(원안 6번)를 코드로
 *      계산 — 이건 결정적 계산이라 LLM에 안 맡긴다(top N을 LLM에 안
 *      맡기는 keyword-extractor.ts 원칙과 동일)
 *   5. 대표 특징 최대 3개 선정(원안 7번, 코드)
 *   6. 문장 작성(LLM, 원안 8번) — 근거 안에서만
 *   7. 자동 검수(LLM, 별도 호출 — 문장작성과 같은 호출 안에서 자기가 쓴 걸
 *      자기가 확인하면 확증편향 위험이 있다는 지적을 받아 분리함, 2026-09-01)
 *   8. 실패 조건 있으면 그 특징 빼고 6~7 재시도 (최대 2회)
 *   9. brand_facts와 충돌하는 특징은 별도 행(잘못된인지)으로 분리 저장(원안 9번)
 *
 * ⚠️ 아직 실측(live API) 검증 전이다.
 */

import { ANTHROPIC_API_URL, ANTHROPIC_MODEL_SONNET, ANTHROPIC_VERSION } from './llm-config';
import {
  type StoredBrandExpression,
  type StoredDiagnosis,
  type SelectedFeatureToSave,
  type BrandOneLinerToSave,
  fetchBrandExpressionsForBrand,
  fetchValidEnginesForQueriesInPeriod,
  fetchActiveQueries,
  fetchKnownBrands,
  fetchExpiredDiagnoses,
  completeDiagnosis,
  saveBrandOneLiner,
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

export type FeatureCategory =
  | '치료분야'
  | '진료체계'
  | '의료역량'
  | '환자상황'
  | '이용편의성'
  | '일반적_표현'; // '좋은 치과' 류 — 브랜드 구분력 없는 표현

interface RawGroup {
  label: string;
  category: FeatureCategory;
  memberIndexes: number[]; // uniqueExpressions 배열의 인덱스
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
   - 일반적_표현 ("좋은 치과", "신뢰할 만한", "전문적인"처럼 어느 병원에나 붙을 수 있는 표현)
4. 표현 하나는 반드시 하나의 묶음에만 속해야 한다(중복 배정 금지). 의미가 뚜렷이 다르면 억지로 묶지 말고 따로 둬라.
5. 서로 무관한 표현을 하나의 묶음으로 억지로 합치지 마라.

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
                      enum: ['치료분야', '진료체계', '의료역량', '환자상황', '이용편의성', '일반적_표현'],
                    },
                    member_indexes: { type: 'array', items: { type: 'integer' } },
                  },
                  required: ['label', 'category', 'member_indexes'],
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

  const CATEGORIES: FeatureCategory[] = [
    '치료분야', '진료체계', '의료역량', '환자상황', '이용편의성', '일반적_표현',
  ];

  const output: RawGroup[] = [];
  for (const g of rawGroups) {
    if (typeof g !== 'object' || g === null) continue;
    const label = (g as Record<string, unknown>).label;
    const category = (g as Record<string, unknown>).category;
    const memberIndexes = (g as Record<string, unknown>).member_indexes;
    if (typeof label !== 'string' || label.trim().length === 0) continue;
    if (!Array.isArray(memberIndexes)) continue;

    output.push({
      label: label.trim(),
      category: CATEGORIES.includes(category as FeatureCategory)
        ? (category as FeatureCategory)
        : '일반적_표현', // 형식이 어긋나면 보수적으로 "일반적 표현"(구체성 인정 안 함) 처리
      memberIndexes: memberIndexes.filter((i): i is number => typeof i === 'number'),
    });
  }
  return output;
}

// ── 4단계: 최소기준 필터 + 강도 계산 (코드, 결정적) ──

export interface EvaluatedGroup {
  label: string;
  category: FeatureCategory;
  members: StoredBrandExpression[];
  coverage: { questions: number; engines: number; days: number };
  strength: number;
  passesMinimum: boolean;
  isConflicting: boolean;
}

/**
 * 판정 규칙(2026-09-01 확정):
 *  - 최소기준 5번("AI 3개 이상")은 절대값 고정. 유효 엔진 수가 3개 미만인
 *    특징은 이 절대 기준을 통과할 수 없다 — 의도된 동작이다(9/7~8 첫
 *    진단 종료 후 재검토 예정, 그 전엔 임의로 완화 안 함).
 *  - v1.1 ④(동적 분모)는 강도 계산(AI 범위 비율)에만 적용한다.
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

    const passesMinimum =
      questionSet.size >= 2 && // 인지 질문 3개 중 2개 이상
      engineSet.size >= 3 && // AI 6개 중 3개 이상 (절대값, 위 주석 참고)
      daySet.size >= 3 && // 서로 다른 날짜 3일 이상
      nonInducedCount > 0; // 유도된 표현만으로 구성되지 않음

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
      passesMinimum,
      // 절반 넘게 브랜드 사실과 충돌하면 그 묶음 전체를 "충돌 특징"으로 본다.
      isConflicting: members.length > 0 && conflictCount > members.length / 2,
    };
  });
}

// ── 5단계: 대표 특징 선정 (코드) ──

/**
 * 원안 7번 우선순위(여러 질문 자발 등장 > 여러 AI·날짜 유지 > 구체적 > 근거
 * 명확)를 strength(세 범위 평균) 내림차순 정렬로 근사한다 — 세 요소를 이미
 * 균등하게 반영하는 지표라 정렬 기준으로 충분하다고 판단.
 *
 * "최소 하나는 구체적 특징이어야 한다"만 별도로 강제한다(원안 7번 마지막
 * 문단) — 상위 3개가 전부 '일반적_표현'이면 그 다음으로 강한 구체적 특징을
 * 대신 끌어온다.
 */
function selectRepresentativeFeatures(evaluated: EvaluatedGroup[]): EvaluatedGroup[] {
  const candidates = evaluated
    .filter((g) => g.passesMinimum && !g.isConflicting)
    .sort((a, b) => b.strength - a.strength);

  const top3 = candidates.slice(0, 3);
  const hasConcrete = top3.some((g) => g.category !== '일반적_표현');

  if (!hasConcrete && top3.length > 0) {
    const concrete = candidates.find(
      (g) => g.category !== '일반적_표현' && !top3.includes(g)
    );
    if (concrete) {
      top3[top3.length - 1] = concrete;
      top3.sort((a, b) => b.strength - a.strength);
    }
    // 구체적 특징이 후보군에 아예 없으면 여기서 못 바꾼다 — 8단계
    // 자동검수가 "구체적 특징 없음"을 걸러내야 하는 케이스로 남긴다.
  }

  return top3;
}

/** 원안 9번 "잘못된 인지" — 최소기준을 통과했지만 브랜드 사실과 충돌하는 특징 중 가장 강한 것 하나. */
function findConflictingFeature(evaluated: EvaluatedGroup[]): EvaluatedGroup | null {
  const conflicting = evaluated
    .filter((g) => g.passesMinimum && g.isConflicting)
    .sort((a, b) => b.strength - a.strength);
  return conflicting[0] ?? null;
}

// ── 6단계: 문장 작성 (LLM, Sonnet) ──

function buildWritingPrompt(brandName: string, features: EvaluatedGroup[]): string {
  const featureBlocks = features
    .map((f, i) => {
      const examples = f.members
        .slice(0, 3)
        .map((m) => `    · "${m.sourceSentence}"`)
        .join('\n');
      return `${i + 1}. ${f.label}\n${examples}`;
    })
    .join('\n');

  return `"${brandName}"에 대해 AI 답변에서 반복 확인된 특징 ${features.length}개가 아래에 근거 문장과 함께 있다.

선정된 특징과 근거:
${featureBlocks}

위 근거 "안에서만" 정보를 써서, "${brandName}"을 설명하는 한 문장을 만들어라.

작성 규칙:
1. 위 근거에 없는 특징이나 사실을 추가하지 마라.
2. 최상급·과장 표현(최고, 유일, 압도적, 국내 최초 등)을 쓰지 마라.
3. 근거 문장의 부정적인 뉘앙스를 긍정적으로 바꾸지 마라.
4. 사용자가 한 번에 이해할 수 있는 자연스러운 한국어 문장으로 써라.
5. 60자 안팎의 한 문장으로 써라.
6. 위에 선정된 특징만 조합해라 — 그 외 정보를 넣지 마라.`;
}

async function writeOneLiner(brandName: string, features: EvaluatedGroup[]): Promise<string> {
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
      messages: [{ role: 'user', content: buildWritingPrompt(brandName, features) }],
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

function buildReviewPrompt(brandName: string, oneLiner: string, features: EvaluatedGroup[]): string {
  const featureBlocks = features
    .map((f, i) => {
      const examples = f.members
        .slice(0, 3)
        .map((m) => `    · "${m.sourceSentence}"`)
        .join('\n');
      return `${i + 1}. ${f.label}\n${examples}`;
    })
    .join('\n');

  return `아래는 "${brandName}"에 대해 자동 생성된 브랜드 한 줄과, 그 근거로 쓰인 특징들이다. 너는 이 문장을 검수하는 역할이다 — 이 문장을 쓴 사람이 아니라, 이 문장이 규칙을 어겼는지 의심하고 확인하는 감사자다.

생성된 문장: "${oneLiner}"

사용된 특징과 근거:
${featureBlocks}

아래 기준을 하나씩 확인해라:
1. 문장에 쓰인 모든 내용에 위 근거가 있는가?
2. 근거보다 강한 표현(최상급·과장)을 쓰지 않았는가?
3. 근거 문장의 긍정·부정 뉘앙스를 바꾸지 않았는가?
4. 근거에 없는 내용을 추가하지 않았는가?
5. 문장의 각 부분에서 위 근거 중 하나로 되짚어갈 수 있는가?

하나라도 어겼으면 어느 특징(위 번호) 때문인지 짚어서 보고해라. 근거가 모호하면 통과시키지 말고 위반으로 판단해라.`;
}

async function reviewOneLiner(
  brandName: string,
  oneLiner: string,
  features: EvaluatedGroup[]
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
      messages: [{ role: 'user', content: buildReviewPrompt(brandName, oneLiner, features) }],
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

// ── 오케스트레이션 ──

export interface SynthesisResult {
  diagnosisId: string;
  savedOneLinerIds: string[];
}

function diagnosisDurationDays(diagnosis: StoredDiagnosis, endedAt: string): number {
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
      selectedFeatures: null,
      questionIds,
      engineList,
    });
    if (id) savedOneLinerIds.push(id);
    return { diagnosisId: diagnosis.id, savedOneLinerIds };
  }

  const expressionsById = new Map(expressions.map((e) => [e.id, e]));
  const uniqueExpressions = buildUniqueExpressions(expressions);
  const rawGroups = await retryWithBackoff(
    () => groupSimilarExpressions(brandName, uniqueExpressions),
    3,
    isRetryableLLMError
  );

  const totalDiagnosisDays = diagnosisDurationDays(diagnosis, endedAt);
  const evaluated = evaluateGroups(
    rawGroups,
    uniqueExpressions,
    expressionsById,
    totalRecognitionQuestions,
    totalDiagnosisDays,
    engineList.length
  );

  // ── 정상 계열(반복확인/초기한줄/근거부족) ──
  let selected = selectRepresentativeFeatures(evaluated);

  if (selected.length === 0) {
    const id = await saveBrandOneLiner({
      diagnosisId: diagnosis.id,
      brandId: diagnosis.brandId,
      status: '근거부족',
      oneLiner: null,
      selectedFeatures: null,
      questionIds,
      engineList,
    });
    if (id) savedOneLinerIds.push(id);
  } else {
    // 문장작성 → 자동검수(별도 호출) → 위반 특징 있으면 빼고 재시도(최대 2회)
    const originalFeatureCount = selected.length;
    const excludedByReview: string[] = [];
    let retryCount = 0;
    let oneLiner: string | null = null;

    for (let attempt = 0; attempt < 2 && selected.length > 0; attempt++) {
      const draft = await writeOneLiner(brandName, selected);
      const review = await reviewOneLiner(brandName, draft, selected);

      if (review.passed) {
        oneLiner = draft;
        break;
      }

      retryCount++;
      console.error(
        `브랜드 한 줄 자동검수 실패 (diagnosis=${diagnosis.id}, attempt=${attempt}): ${review.reason ?? '사유 미상'} — 위반 특징: ${review.violatedFeatureLabels.join(', ')}`
      );
      excludedByReview.push(...review.violatedFeatureLabels);
      selected = selected.filter((f) => !review.violatedFeatureLabels.includes(f.label));
    }

    const status: BrandOneLinerToSave['status'] =
      oneLiner && selected.length >= 2 ? '반복확인' : oneLiner && selected.length === 1 ? '초기한줄' : '근거부족';

    const selectedFeaturesToSave: SelectedFeatureToSave[] | null =
      status === '근거부족'
        ? null
        : selected.map((f) => ({
            feature: f.label,
            coverage: f.coverage,
            evidence: f.members.map((m) => m.id),
          }));

    const id = await saveBrandOneLiner({
      diagnosisId: diagnosis.id,
      brandId: diagnosis.brandId,
      status,
      oneLiner: status === '근거부족' ? null : oneLiner,
      selectedFeatures: selectedFeaturesToSave,
      questionIds,
      engineList,
      generationLog:
        retryCount > 0 ? { originalFeatureCount, retryCount, excludedByReview } : null,
    });
    if (id) savedOneLinerIds.push(id);
  }

  // ── 잘못된 인지 (원안 9번, 정상 계열과 별개 행으로 저장) ──
  const conflicting = findConflictingFeature(evaluated);
  if (conflicting) {
    const id = await saveBrandOneLiner({
      diagnosisId: diagnosis.id,
      brandId: diagnosis.brandId,
      status: '잘못된인지',
      oneLiner: `AI가 '${conflicting.label}'라고 인지하고 있지만, 입력된 브랜드 정보와 일치하지 않습니다.`,
      selectedFeatures: [
        {
          feature: conflicting.label,
          coverage: conflicting.coverage,
          evidence: conflicting.members.map((m) => m.id),
        },
      ],
      questionIds,
      engineList,
    });
    if (id) savedOneLinerIds.push(id);
  }

  return { diagnosisId: diagnosis.id, savedOneLinerIds };
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
