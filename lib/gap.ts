// lib/gap.ts

/**
 * "인지와 추천, 그 사이" 화면(Day23, 2026-09-10 — Day22 "인지와 위치의
 * 간극" 화면을 대체) — 순수 계산 함수만 모아둔 파일.
 * DB 접근은 app/(dashboard)/gap/page.tsx가 lib/supabase.ts로 끝내고,
 * 이 파일은 그 결과를 입력으로 받아 파생시킨다.
 *
 * ⚠️ 2026-09-10 전면 교체 — 예전 hero/pill 뺄셈 구조(간극 있음/추천 근거로
 * 확인됨/추천에서 발견/조건 정보, selectGapHero 등)는 전부 삭제했다.
 * 이유(작업지시서_간극화면_교체_2026-09-09_V1.0.md §0): 포괄적 특징을
 * 구조적으로 불리하게 다뤄서 hero가 엉뚱하게 뽑히고, 표본이 얇았고,
 * "AI 내부에서 선택 이유로 작동했나"를 암묵적으로 다시 주장하게 됐다.
 * 새 설계는 뺄셈이 아니라 대조 — 소개 TOP10과 추천 TOP10을 나란히 놓고
 * "얼마나 겹치는가"만 관측 사실로 보여준다. 옛 코드가 필요하면 git
 * history(이 커밋 이전)에서 그대로 복원 가능.
 */

import type { StoredBrandFeatureCandidate } from './supabase';

export interface AwarenessFeatureFrequency {
  featureName: string;
  questionCount: number;
  questionTotal: number;
  engineCount: number;
  engineTotal: number;
  dayCount: number;
  dayTotal: number;
}

/**
 * "소개 특징 TOP10" — brand_feature_candidates를 intensityScore(질문·AI·
 * 날짜 커버리지 비율의 평균, brand-one-liner.ts evaluateGroups 참고) 내림차순
 * 정렬해서 상위 N개만 낸다.
 *
 * ⚠️ intensityScore 1등이 실제 "브랜드 한 줄"에 반영된다는 보장은 없다
 * (2026-09-09 확인 — 최종 반영 여부는 이 점수 뒤에 붙는 별도 LLM 자동검수
 * 단계에서 갈릴 수 있다). 이 목록은 "반영 여부"가 아니라 "커버리지가 가장
 * 넓은 특징이 뭔가"를 보여주는 순수 순위표라 반영 배지를 붙이지 않는다
 * (2026-09-10 루아 확인).
 */
export function buildAwarenessFeatureTop10(
  candidates: StoredBrandFeatureCandidate[],
  topN = 10
): AwarenessFeatureFrequency[] {
  return [...candidates]
    .sort((a, b) => b.intensityScore - a.intensityScore)
    .slice(0, topN)
    .map((c) => ({
      featureName: c.featureName,
      questionCount: c.questionCount,
      questionTotal: c.questionTotal,
      engineCount: c.engineCount,
      engineTotal: c.engineTotal,
      dayCount: c.dayCount,
      dayTotal: c.dayTotal,
    }));
}
