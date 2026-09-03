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
