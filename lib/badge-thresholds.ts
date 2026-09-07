// lib/badge-thresholds.ts

/**
 * 등장률 배지("강하게 등장"/"가끔 등장"/"아직 등장하지 않음"/"판단할 데이터가
 * 부족함") 판정 기준 — 단일 진실 소스 (2026-09-03, 루아 확인).
 *
 * ⚠️ 이 상수는 여기서만 정의한다. 브랜드 현 위치 화면뿐 아니라 앞으로 만들
 * 간극·변화 추이 화면도 "같은 개념은 같은 기준" 원칙(매니페스토 5번)에 따라
 * 이 파일을 import해서 쓴다 — 화면마다 하드코딩 금지.
 *
 * 판정 순서(반드시 이 순서, 위에서부터 먼저 맞는 조건 채택):
 *   1) totalRuns < MIN_RUNS_FOR_JUDGMENT           → 'insufficient'
 *   2) visibilityRate >= STRONG_VISIBILITY_THRESHOLD → 'strong'
 *   3) 0 < visibilityRate < STRONG_VISIBILITY_THRESHOLD → 'sometimes'
 *   4) visibilityRate === 0                         → 'none'
 */

export const MIN_RUNS_FOR_JUDGMENT = 10;
export const STRONG_VISIBILITY_THRESHOLD = 0.5;

export type ExposureBadge = 'insufficient' | 'strong' | 'sometimes' | 'none';

export const EXPOSURE_BADGE_LABEL: Record<ExposureBadge, string> = {
  insufficient: '판단할 데이터가 부족함',
  strong: '강하게 등장',
  sometimes: '가끔 등장',
  none: '아직 등장하지 않음',
};

/**
 * @param totalRuns 유효 관측 횟수(규칙 C: status='success' && search_performed=true)
 * @param visibilityRate totalRuns가 0이면 정의되지 않으므로 null을 받는다 —
 *   그 경우도 totalRuns 자체가 MIN_RUNS_FOR_JUDGMENT 미만이라 어차피 1번
 *   조건에서 'insufficient'로 걸러진다.
 */
export function classifyExposureBadge(
  totalRuns: number,
  visibilityRate: number | null
): ExposureBadge {
  if (totalRuns < MIN_RUNS_FOR_JUDGMENT) return 'insufficient';
  // totalRuns>=10인데 visibilityRate가 null인 경우는 이론상 없어야 한다
  // (분모가 있으면 분자/분모는 항상 계산 가능) — 방어적으로만 처리.
  if (visibilityRate === null) return 'insufficient';
  if (visibilityRate >= STRONG_VISIBILITY_THRESHOLD) return 'strong';
  if (visibilityRate > 0) return 'sometimes';
  return 'none';
}

/**
 * 간극 화면(Day22) "판정 신뢰도" — 관측량(observationCount) 기반 판정.
 * 프로토타입 원본은 "사람 검토 완료 여부"로 신뢰도를 표시했는데, 그건
 * 내부 승인 화면(9/11 데모 범위 밖)이 있어야 성립해서 못 쓴다. 대신 그
 * 특징이 자리질문 답변에 실제로 등장한 횟수(reason_stated+co_mentioned
 * 합계 — mention_feature_roles/lib/gap.ts의 관측 10회 게이팅과 같은
 * 값)로 판정한다(2026-09-08 루아 확정).
 *
 * ⚠️ 구간 값은 코난 제안(2026-09-08) — 새 숫자를 지어내지 않고
 * MIN_RUNS_FOR_JUDGMENT(10)의 배수로 잡았다: 10~19(1~2배)=낮음,
 * 20~39(2~4배)=보통, 40 이상(4배+)=높음. 현재 데이터(문구 생성 대상 7개
 * 특징, 관측 16~61건 분포) 기준으로 낮음 1개·보통 4개·높음 2개로 갈림 —
 * 루아 확인 후 확정.
 */
export type ObservationConfidence = 'high' | 'medium' | 'low';

export const OBSERVATION_CONFIDENCE_LOW_MAX = MIN_RUNS_FOR_JUDGMENT * 2; // < 20
export const OBSERVATION_CONFIDENCE_MEDIUM_MAX = MIN_RUNS_FOR_JUDGMENT * 4; // < 40

export const OBSERVATION_CONFIDENCE_LABEL: Record<ObservationConfidence, string> = {
  high: '높음',
  medium: '보통',
  low: '낮음',
};

/** @param observationCount 그 특징의 reason_stated+co_mentioned 합계. MIN_RUNS_FOR_JUDGMENT 미만이면 애초에 이 함수를 호출할 일이 없다(화면 자체가 안 뜸). */
export function classifyObservationConfidence(observationCount: number): ObservationConfidence {
  if (observationCount < OBSERVATION_CONFIDENCE_LOW_MAX) return 'low';
  if (observationCount < OBSERVATION_CONFIDENCE_MEDIUM_MAX) return 'medium';
  return 'high';
}
