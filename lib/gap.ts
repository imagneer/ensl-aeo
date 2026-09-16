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
 * 새 설계는 뺄셈이 아니라 대조 — 소개와 추천을 나란히 놓고 "얼마나
 * 겹치는가"만 관측 사실로 보여준다. 옛 코드가 필요하면 git history(이
 * 커밋 이전)에서 그대로 복원 가능.
 *
 * ⚠️ 2026-09-16 재교체 — TOP10끼리 순위로 맞대고 문자열 부분매칭(낱말
 * 겹침)으로 강조하던 방식(buildAwarenessFeatureTop10/markTop10Overlap,
 * 이 커밋 이전 history에서 복원 가능)을 버렸다. 왼쪽(소개 특징)은 LLM이
 * 원자 표현을 묶어 새로 요약한 라벨(가공 후)이고 오른쪽(추천 표현)은
 * 원문 그대로의 원자 표현(가공 전)이라 처리 단계 자체가 달라서, 부분
 * 문자열 매칭으로는 과다/과소 집계가 둘 다 실측 확인됐다
 * (작업지시서_표현정규화_2026-09-16_V1.2 §왜). 대신 양쪽을 기존 7개
 * 카테고리(brand_feature_candidates.category와 동일 체계)로 분류하고,
 * 카테고리 안에서만 왼쪽 클러스터에 세부 매칭한다(lib/placement-expression-classifier.ts).
 */

import { FEATURE_CATEGORIES, type FeatureCategory, type StoredBrandFeatureCandidate, type StoredPlacementExpressionClassification } from './supabase';

// ── 카테고리 비교 (작업지시서_표현정규화_2026-09-16_V1.2 §5단계) ──
//
// 왼쪽(소개 특징)과 오른쪽(추천 표현, lib/placement-expression-classifier.ts가
// 분류한 결과)을 TOP10끼리 순위로 맞대는 대신, 기존 7개 카테고리 기준으로
// "소개 강도 vs 추천 등장 비율"을 나란히 보여준다. 카테고리가 null(미분류)인
// 오른쪽 표현은 이 집계에서 제외한다 — 7개 중 어디에도 안 맞는다고 판정된
// 것이라 카테고리 비교표에 넣을 자리가 없다(별도 관찰 로그,
// fetchUncategorizedExpressionsForBrand 참고).

export interface CategoryComparisonRow {
  category: FeatureCategory;
  awarenessCount: number;
  /** 이 카테고리의 왼쪽 특징 중 intensityScore 상위 3개 — 화면에 예시로 보여줄 용도 */
  topAwarenessFeatureNames: string[];
  placementOccurrence: number;
  /** 분모 — 매니페스토 3원칙(비율은 반드시 분모 포함)에 따라 화면에 같이 표시할 것 */
  appearedRuns: number;
  placementRate: number;
  /** 카테고리 안에서 세부 의미까지 같다고 판정된 왼쪽 특징 이름(중복 제거) */
  matchedFeatureNames: string[];
}

export function buildCategoryComparison(
  candidates: StoredBrandFeatureCandidate[],
  classifications: StoredPlacementExpressionClassification[]
): CategoryComparisonRow[] {
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const appearedRuns = classifications[0]?.appearedRuns ?? 0;

  return FEATURE_CATEGORIES.map((category) => {
    const awarenessInCategory = candidates
      .filter((c) => c.category === category)
      .sort((a, b) => b.intensityScore - a.intensityScore);

    const placementInCategory = classifications.filter((c) => c.category === category);
    const placementOccurrence = placementInCategory.reduce((sum, c) => sum + c.occurrenceCount, 0);

    const matchedFeatureNames = [
      ...new Set(
        placementInCategory
          .map((c) => (c.matchedFeatureId ? candidateById.get(c.matchedFeatureId)?.featureName : null))
          .filter((name): name is string => !!name)
      ),
    ];

    return {
      category,
      awarenessCount: awarenessInCategory.length,
      topAwarenessFeatureNames: awarenessInCategory.slice(0, 3).map((c) => c.featureName),
      placementOccurrence,
      appearedRuns,
      placementRate: appearedRuns > 0 ? placementOccurrence / appearedRuns : 0,
      matchedFeatureNames,
    };
  }).filter((row) => row.awarenessCount > 0 || row.placementOccurrence > 0);
}
