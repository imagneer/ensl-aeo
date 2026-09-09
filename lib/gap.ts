// lib/gap.ts

/**
 * Day22 "인지와 위치의 간극" 화면 — 순수 계산 함수만 모아둔 파일.
 * DB 접근(mention_feature_roles·brand_feature_candidates·자리질문
 * snapshots 조회)은 app/(dashboard)/gap/page.tsx가 lib/supabase.ts로
 * 끝내고, 이 파일은 그 결과를 입력으로 받아 파생시킨다 — "판단 로직을
 * 화면 컴포넌트에 넣지 않기" 원칙(lib/query-detail.ts와 동일한 이유).
 *
 * ⚠️ LLM이 생성하는 문장(why-box 설명, counter-box "왜 제외됐는지" 설명)은
 * 이 파일 범위 밖이다 — 판정+검수 분리가 필요한 별도 LLM 호출로, 다음
 * 단계에서 lib/mention-feature-roles.ts에 추가할 예정(2026-09-05 계획).
 * 이 파일은 그 설명문을 만들 때 필요한 "어떤 mention을 근거로 쓸지"까지만
 * 골라준다.
 *
 * ─────────────────────────────────────────────────────────
 * 핵심 공식 (2026-09-05 루아 확인)
 * ─────────────────────────────────────────────────────────
 *  - 인지측 비율("AI가 알고 있음") = engineCount / engineTotal
 *    (brand_feature_candidates, v1.1 기존 데이터 재사용 — 신규 로직 없음
 *    원칙, 질문/일수 커버리지 대신 "AI 개수" 프레이밍인 이걸 골랐다)
 *  - 자리측 분모("자리질문 9개 전체 관측") = 9개 자리질문의 유효 관측
 *    (status=success && search_performed=true, lib/query-detail.ts
 *    computeAppearanceHeaderStats와 동일 정의)을 합산한 실측치 —
 *    9×6×7=378 같은 이론값이 아니다.
 *  - 자리측 분자 = mention_feature_roles에서 role='reason_stated'로
 *    저장된 mention 수 (feature_text로 매칭, brand_feature_candidates에
 *    id 참조가 없어서 문자열 일치로 묶는다 — 저장 시 항상
 *    candidate.featureName을 그대로 썼으므로 정확히 일치한다)
 *  - pill 분류는 새 임계값을 만들지 않고 기존 passed_min_criteria(v1.1,
 *    지금까지 화면에서 안 쓰이고 있었지만 이미 계산돼 있던 값)를
 *    "인지가 확정 수준인가"의 기준으로 재사용한다:
 *      passed_min_criteria=true  + reason_stated 0건   → '간극 있음'
 *      passed_min_criteria=true  + reason_stated 1건+  → '추천 근거로 확인됨'
 *      passed_min_criteria=false + reason_stated 1건+  → '추천에서 발견'
 *      passed_min_criteria=false + reason_stated 0건   → 목록에 안 보여줌
 *        (인지도 자리도 둘 다 신호가 없어서 "간극"이라 부를 근거 자체가 없음)
 *    지역_조건 카테고리는 위 분류와 무관하게 항상 '조건 정보'.
 */

import type {
  FeatureCategory,
  StoredBrandFeatureCandidate,
  MentionFeatureRoleRow,
  QuerySnapshotRecord,
} from './supabase';
import { classifyExposureBadge, MIN_RUNS_FOR_JUDGMENT, type ExposureBadge } from './badge-thresholds';
import { computeAppearanceHeaderStats } from './query-detail';
import { combineTopKeywords } from './brand-position';

/**
 * 자리질문 9개 각각의 snapshot 레코드 배열을 받아 "유효 관측" 합계를
 * 낸다 — brand-position.ts(Day21)가 질문별 통계를 page.tsx에서 fetch한
 * 배치 결과로 계산하는 것과 같은 분업(순수 계산은 lib, fetch·합산 루프는
 * 호출부)을 따른다. 여기서는 합산까지 lib에 두는 이유: 이 합계 하나가
 * 특징 여러 개가 전부 공유하는 "전역 분모"라서, 화면 쪽에서 매번 다시
 * 합산 코드를 짜면 실수하기 쉽다(알려진 정합성 이슈 2번과 같은 종류).
 */
export function sumPlacementTotalValidRuns(recordsByQuery: QuerySnapshotRecord[][]): number {
  return recordsByQuery.reduce((sum, records) => sum + computeAppearanceHeaderStats(records).totalValidRuns, 0);
}

/**
 * sumPlacementTotalValidRuns와 분모가 다르다 — 저건 "우리 등장 여부와
 * 무관하게 시도된 유효 관측 전체"(간극 화면 본문의 reason_stated 비율용,
 * "언급조차 안 됨"도 0점으로 셀 만한 분모가 맞는 지표), 이건 "그중 우리
 * 브랜드가 실제로 등장한 관측"만 센다(2026-09-09 정정 — TOP10처럼 "우리
 * 브랜드를 설명한 표현"을 다루는 지표는 애초에 우리가 등장 안 한 관측을
 * 분모에 넣으면 안 된다, 등장하지 않은 관측엔 표현 자체가 존재할 수 없어서
 * 비율의 뜻이 안 맞기 때문).
 */
export function sumPlacementAppearedRuns(recordsByQuery: QuerySnapshotRecord[][]): number {
  return recordsByQuery.reduce((sum, records) => sum + computeAppearanceHeaderStats(records).appearedRuns, 0);
}

export interface PlacementFeatureFrequency {
  keyword: string;
  /** 이 표현이 등장한 "유효 관측" 횟수. */
  count: number;
  /** 분모 — 우리 브랜드가 실제로 등장한 관측 수(sumPlacementAppearedRuns
   *  결과를 그대로 받는다. sumPlacementTotalValidRuns와 다르다 — 그건
   *  "등장 여부 무관 전체", 이건 "그중 우리가 등장한 것만").
   *  ⚠️ 이 표현 데이터(aggregated_metrics.top_keywords)는 이 분모보다 더
   *  적은 관측만 커버할 수 있다 — 일부 날짜는 집계 자체가 밀려서 아예
   *  안 됐을 수 있다(기존에 알려진 daily 집계 지연 부채와 같은 종류).
   *  즉 count 합계가 이 분모보다 항상 작을 수 있고, 그건 "표현이 없어서"가
   *  아니라 "집계가 아직 못 따라가서"일 수 있다 — 화면에서 이 차이를
   *  숨기지 않는다(호출부가 placementFeatureDataRuns로 따로 보여줌). */
  appearedRuns: number;
  rate: number;
}

/**
 * 자리질문 9개 전체에 걸쳐 daily 집계된 top_keywords(질문×엔진×날짜 단위
 * 행, fetchAggregatedKeywordRowsForQueries 결과)를 문자열 완전일치로 합쳐서
 * 빈도순 TOP N을 낸다("추천 특징 TOP10", 2026-09-09 작업지시).
 *
 * ⚠️ brand-position.ts의 combineTopKeywords와 셈법이 다르다 — 그쪽은 한
 * daily 행 안에 같은 표현이 여러 번 잡히면 그대로 다 더하지만(빈도 합산),
 * 여기서는 한 daily 행(=관측 1회) 안에서 같은 표현이 여러 번 잡혀도 "관측
 * 1회"로만 센다. 분모를 "우리 브랜드가 등장한 관측 횟수"(appearedRuns,
 * 2026-09-09 정정 — 처음엔 "전체 유효 관측"으로 잘못 잡았다가, 등장 안 한
 * 관측엔 표현 자체가 있을 수 없다는 걸 뒤늦게 확인하고 고쳤다)로 잡았기
 * 때문에, 분자도 같은 단위(관측 횟수)여야 "27% · 220회 중 11회" 같은
 * 표기가 실제로 뜻이 통한다 — 안 그러면 한 답변 안에서 같은 표현이 두 번
 * 나온 것만으로 분자가 분모보다 커 보이는 경우가 생길 수 있다(알려진
 * 정합성 이슈 1번 "교집합이 부분집합보다 클 수 없음"과 같은 이유).
 */
export function buildPlacementFeatureFrequencyTop10(
  keywordRows: { topKeywords: { keyword: string; count: number }[] | null }[],
  appearedRuns: number,
  topN = 10
): PlacementFeatureFrequency[] {
  const countByKeyword = new Map<string, number>();
  const firstSeenOrder: string[] = [];

  for (const row of keywordRows) {
    if (!row.topKeywords) continue;
    const seenInRow = new Set<string>();
    for (const { keyword } of row.topKeywords) {
      if (seenInRow.has(keyword)) continue;
      seenInRow.add(keyword);
      if (!countByKeyword.has(keyword)) {
        countByKeyword.set(keyword, 0);
        firstSeenOrder.push(keyword);
      }
      countByKeyword.set(keyword, countByKeyword.get(keyword)! + 1);
    }
  }

  return firstSeenOrder
    .map((keyword) => {
      const count = countByKeyword.get(keyword)!;
      return {
        keyword,
        count,
        appearedRuns,
        rate: appearedRuns > 0 ? count / appearedRuns : 0,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

export type GapPill = 'gap' | 'works' | 'new' | 'condition' | null;

export const GAP_PILL_LABEL: Record<Exclude<GapPill, null>, string> = {
  gap: '간극 있음',
  works: '추천 근거로 확인됨',
  new: '추천에서 발견',
  condition: '조건 정보',
};

export interface FeatureGapStat {
  featureId: string;
  featureName: string;
  category: FeatureCategory;
  isLocationContext: boolean;
  awarenessRatio: number;
  awarenessEngineCount: number;
  awarenessEngineTotal: number;
  placementReasonStatedCount: number;
  placementCoMentionedCount: number;
  /** 모든 특징이 공유하는 전역 분모(자리질문 9개 합산 유효 관측) — 특징별로 다르지 않다. */
  placementTotalValidRuns: number;
  placementReasonStatedRatio: number;
  placementBadge: ExposureBadge;
  /** awarenessRatio - placementReasonStatedRatio. 양수가 클수록 "인지는 있는데 자리에선 안 이어짐". */
  gapSize: number;
  pill: GapPill;
}

/**
 * feature_text 문자열 일치로 mention_feature_roles를 특징별로 묶는다.
 * (mention_feature_roles엔 candidate id 참조가 없다 — 작업지시서 §2 설계 그대로)
 */
function countRolesByFeatureText(roleRows: MentionFeatureRoleRow[]): {
  reasonStated: Map<string, number>;
  coMentioned: Map<string, number>;
} {
  const reasonStated = new Map<string, number>();
  const coMentioned = new Map<string, number>();
  for (const row of roleRows) {
    const map = row.role === 'reason_stated' ? reasonStated : coMentioned;
    map.set(row.featureText, (map.get(row.featureText) ?? 0) + 1);
  }
  return { reasonStated, coMentioned };
}

function classifyPill(isLocationContext: boolean, passedMinCriteria: boolean, reasonStatedCount: number): GapPill {
  if (isLocationContext) return 'condition';
  if (passedMinCriteria) return reasonStatedCount > 0 ? 'works' : 'gap';
  return reasonStatedCount > 0 ? 'new' : null;
}

export function buildFeatureGapStats(
  candidates: StoredBrandFeatureCandidate[],
  roleRows: MentionFeatureRoleRow[],
  placementTotalValidRuns: number
): FeatureGapStat[] {
  const { reasonStated, coMentioned } = countRolesByFeatureText(roleRows);

  return candidates.map((c): FeatureGapStat => {
    const isLocationContext = c.category === '지역_조건';
    const awarenessRatio = c.engineTotal > 0 ? c.engineCount / c.engineTotal : 0;
    const reasonStatedCount = reasonStated.get(c.featureName) ?? 0;
    const coMentionedCount = coMentioned.get(c.featureName) ?? 0;
    const placementReasonStatedRatio =
      placementTotalValidRuns > 0 ? reasonStatedCount / placementTotalValidRuns : 0;

    return {
      featureId: c.id,
      featureName: c.featureName,
      category: c.category,
      isLocationContext,
      awarenessRatio,
      awarenessEngineCount: c.engineCount,
      awarenessEngineTotal: c.engineTotal,
      placementReasonStatedCount: reasonStatedCount,
      placementCoMentionedCount: coMentionedCount,
      placementTotalValidRuns,
      placementReasonStatedRatio,
      placementBadge: classifyExposureBadge(placementTotalValidRuns, placementReasonStatedRatio),
      gapSize: awarenessRatio - placementReasonStatedRatio,
      pill: classifyPill(isLocationContext, c.passedMinCriteria, reasonStatedCount),
    };
  });
}

/** 화면 목록에 실제로 보여줄 것만 남긴다 — pill이 null인 건 "간극이라 부를 근거 자체가 없음". */
export function visibleGapFeatures(stats: FeatureGapStat[]): FeatureGapStat[] {
  return stats.filter((s) => s.pill !== null);
}

/**
 * Hero(가장 큰 간극) 선정 — pill='gap'인 것 중 placementCoMentionedCount가
 * 가장 큰 특징 하나. '조건 정보'(지역 맥락)는 애초에 "간극" 개념이 성립
 * 안 해서 후보에서 뺀다(pill='gap'이 정확히 그 패턴만 가리킨다).
 *
 * ⚠️ 2026-09-08 발견·수정 — 원래는 gapSize(awarenessRatio -
 * placementReasonStatedRatio) 기준이었다. 그런데
 * placementReasonStatedRatio의 분모가 전역 유효관측(모든 특징이 공유하는
 * 값, 지금 370)이라 어떤 특징이든 이 항이 거의 항상 0에 가깝게 수렴한다
 * — 그래서 사실상 gapSize ≈ awarenessRatio가 되어버려, hero가 "가장
 * 뾰족한 간극"이 아니라 "인지도가 가장 높은데 근거가 0인 특징"을 뽑고
 * 있었다(루아 판단 — "다양한 치과 진료 제공" 같은 포괄적 특징이 인지도만
 * 높다는 이유로 hero가 됨). placementCoMentionedCount(그 특징이 자리질문
 * 답변에 실제로 얼마나 자주 나오는지)로 바꾸면 "등장은 자주 하는데 한
 * 번도 근거로 안 묶이는" 정도를 직접 재게 된다.
 *
 * MIN_RUNS_FOR_JUDGMENT(badge-thresholds.ts, 기존 상수 재사용) 미만인
 * 후보는 노이즈로 보고 건너뛴다 — 등장 자체가 적어서 "간극"이라 부를
 * 근거가 약한 특징이 우연히 hero가 되는 걸 막는다. 전부 미달이면 hero
 * 없음(null) — 없는 뾰족함을 억지로 만들지 않는다.
 *
 * gapSize 필드 자체와 sortForFeatureList(화면 목록 정렬)는 이번엔
 * 안 건드린다 — hero 선정 로직만 분리해서 고치기로 확정(2026-09-08).
 */
export function selectGapHero(stats: FeatureGapStat[]): FeatureGapStat | null {
  const candidates = stats
    .filter((s) => s.pill === 'gap' && s.placementCoMentionedCount >= MIN_RUNS_FOR_JUDGMENT)
    .sort((a, b) => b.placementCoMentionedCount - a.placementCoMentionedCount);
  return candidates[0] ?? null;
}

/**
 * hero 문장 — tip-box도 이 문장을 그대로 재사용한다(작업지시서 §3-5,
 * "hero 문장 재사용 원칙"). "~가/이" 주격 조사가 브랜드명 받침 유무에
 * 따라 갈리는 걸 피하려고 "~에 ~가 있다는 사실" 구조로 통일했다.
 */
export function buildHeroSentence(brandName: string, hero: FeatureGapStat): string {
  return `AI는 ${brandName}에 "${hero.featureName}" 특징이 있다는 사실은 알고 있지만, 추천 답변에서는 아직 이 특징을 근거로 사용하지 않았어요.`;
}

/** 화면 정렬 순서 — 간극이 큰 것부터, 그다음 근거로 확인된 것, 발견된 것, 마지막 조건 정보. */
const PILL_SORT_ORDER: Record<Exclude<GapPill, null>, number> = { gap: 0, works: 1, new: 2, condition: 3 };

export function sortForFeatureList(stats: FeatureGapStat[]): FeatureGapStat[] {
  return [...stats].sort((a, b) => {
    const pillDiff = PILL_SORT_ORDER[a.pill as Exclude<GapPill, null>] - PILL_SORT_ORDER[b.pill as Exclude<GapPill, null>];
    if (pillDiff !== 0) return pillDiff;
    return b.gapSize - a.gapSize;
  });
}

export interface CompetitorFeatureMention {
  name: string;
  count: number;
}

export interface CompetitorFeatureExpression {
  keyword: string;
  brandName: string;
  count: number;
}

type AggregatedCompetitorRow = {
  competitorData: Record<string, { name: string; topKeywords?: { keyword: string; count: number }[] | null }> | null;
};

/** "(...)" 안 예시 항목과 괄호 밖 본문을 핵심어 후보로 뽑는다. */
function extractFeatureCoreTerms(featureName: string): string[] {
  const parenMatch = featureName.match(/\(([^)]+)\)/);
  const paren = parenMatch ? parenMatch[1] : '';
  const withoutParen = featureName.replace(/\([^)]*\)/g, '').trim();

  const terms = new Set<string>();
  for (const part of paren.split(/[·,]/)) {
    const t = part.replace(/\s*등\s*$/, '').trim();
    if (t) terms.add(t);
  }
  if (withoutParen) terms.add(withoutParen);
  return [...terms];
}

/**
 * 경쟁사 키워드(738건 백필) 중 이 특징의 핵심어를 포함하는 것만 골라
 * {브랜드, 표현, 횟수}로 펼친다 — compare-box(브랜드별 합계)와
 * expr-list(표현별 목록) 둘 다 이 결과에서 파생시킨다.
 *
 * ⚠️ 정밀 매칭이 아니다 — 우리 특징명(brand_feature_candidates, 사람이
 * 정리한 분류)과 경쟁사 키워드(LLM이 자유 형식으로 뽑은 원문 그대로의
 * 구)는 taxonomy 자체가 다르다. 특징명에서 핵심어를 뽑아 경쟁사 키워드
 * 문자열에 부분 일치하는지로 근사한다. 그래서 화면엔 반드시 "경쟁사
 * 데이터는 아직 근거 연결 여부까지 판정되지 않았어요. 함께 언급된
 * 횟수만 보여드려요" 캡션을 같이 띄운다(작업지시서 필수 캡션).
 */
function matchCompetitorFeatureExpressions(
  featureName: string,
  aggregatedRows: AggregatedCompetitorRow[]
): CompetitorFeatureExpression[] {
  const coreTerms = extractFeatureCoreTerms(featureName);
  if (coreTerms.length === 0) return [];

  const keywordListsByName = new Map<string, { keyword: string; count: number }[][]>();
  for (const row of aggregatedRows) {
    for (const comp of Object.values(row.competitorData ?? {})) {
      if (!keywordListsByName.has(comp.name)) keywordListsByName.set(comp.name, []);
      keywordListsByName.get(comp.name)!.push(comp.topKeywords ?? []);
    }
  }

  const result: CompetitorFeatureExpression[] = [];
  for (const [name, lists] of keywordListsByName) {
    const combined = combineTopKeywords(lists, 50);
    for (const k of combined) {
      if (coreTerms.some((term) => k.keyword.includes(term))) {
        result.push({ keyword: k.keyword, brandName: name, count: k.count });
      }
    }
  }

  return result.sort((a, b) => b.count - a.count);
}

/** compare-box용 — 브랜드별 합계(작업지시서 §3-2). */
export function computeCompetitorFeatureMentions(
  featureName: string,
  aggregatedRows: AggregatedCompetitorRow[]
): CompetitorFeatureMention[] {
  const matches = matchCompetitorFeatureExpressions(featureName, aggregatedRows);
  const totalByName = new Map<string, number>();
  for (const m of matches) totalByName.set(m.brandName, (totalByName.get(m.brandName) ?? 0) + m.count);
  return [...totalByName.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** expr-list용 — 표현별 목록, 상위 N개(작업지시서 §3-4). */
export function computeCompetitorFeatureExpressions(
  featureName: string,
  aggregatedRows: AggregatedCompetitorRow[],
  topN = 3
): CompetitorFeatureExpression[] {
  return matchCompetitorFeatureExpressions(featureName, aggregatedRows).slice(0, topN);
}

/**
 * dp-fact("현재 확인된 사실") — why-box처럼 매번 LLM을 부르지 않고
 * pill 종류에 따라 고정 문장을 조합한다(작업지시서 §1 범위는 why-box/
 * counter-box뿐이라 이건 신규 LLM 호출 없이 코드로 처리, 2026-09-07 판단).
 */
export function buildFeatureConclusionSentence(stat: FeatureGapStat): string {
  if (stat.pill === 'works') {
    return 'AI가 알고 있는 특징이 실제 추천 답변에서도 근거로 이어지고 있어요. 이 특징은 계속 유지하는 게 좋아요.';
  }
  if (stat.pill === 'gap') {
    return '이 특징은 AI가 알고는 있지만, 추천 답변에서는 아직 근거로 연결되지 않았어요.';
  }
  if (stat.pill === 'new') {
    return 'AI가 이 특징은 잘 알지 못하지만, 실제 추천 답변에서는 근거로 쓰이고 있어요. 인지 쪽에 더 알려지면 인지와 추천이 더 가까워질 수 있어요.';
  }
  return '';
}
