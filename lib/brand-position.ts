// lib/brand-position.ts

/**
 * 브랜드 현 위치 화면(Day21, /brand-position) — 순수 계산 로직만 모아둔 파일.
 * lib/query-detail.ts와 같은 원칙: DB 접근은 페이지에서 배치로 끝내고,
 * 여기 함수들은 그 결과를 입력으로 받아 파생시킨다.
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (2026-09-03 루아 확인 — 작업지시서 "배지 임계값 + 보조 질문
 * 수집 구조" 후속)
 * ─────────────────────────────────────────────────────────
 *  A. 자리 질문 9개는 전부 동일하게 취급한다. "메인/보조" 구분, 차등
 *     수집 빈도는 없다 — "판단할 데이터가 부족함"은 특정 질문에 고정된
 *     라벨이 아니라 badge-thresholds.ts 기준을 밑도는 질문이면 9개 중
 *     어디에나 나타날 수 있는 일반 상태다.
 *  B. 배지 판정은 lib/badge-thresholds.ts의 classifyExposureBadge를
 *     그대로 쓴다 — 이 파일에서 임계값을 다시 정의하지 않는다.
 *  C. "함께 등장한 브랜드"/"대신 등장한 브랜드" 구분은 badge로 결정한다:
 *     strong/sometimes(타겟이 실제로 등장) → "함께 등장한 브랜드" + 해석
 *     문장 시도. none(등장률 0, 등장은 없지만 판단은 가능) → "대신 등장한
 *     브랜드"(해석 문장 없음). insufficient → 둘 다 안 보여준다(프로토타입
 *     원본 예시와 동일 — 판단 자체를 유보하는 상태에서 부분 데이터를
 *     보여주면 오히려 오해를 줄 수 있다는 판단, 코난 판단).
 *  D. 해석 문장은 새 LLM 호출 없이, 이미 aggregateOne이 채워둔
 *     top_keywords(타겟)/competitor_data[].topKeywords(경쟁사)를 진단
 *     기간 전체로 합쳐서(combineTopKeywords) 고정 템플릿에 꽂는다.
 *     타겟 또는 최고경쟁사의 top 키워드가 하나도 없으면(null/빈 배열/
 *     경쟁사가 미등록 브랜드라 애초에 키워드 자체가 없는 경우 포함)
 *     문장 생성을 건너뛴다 — null 반환.
 *  E. 조사(은/는, 이라는/라는) 처리는 lib/korean-utils.ts를 쓴다(2026-09-03
 *     분리 — 브랜드명·키워드가 문장에 들어가는 다른 화면(간극·변화 추이·
 *     브랜드 한 줄)도 같은 문제를 겪으므로 공용 파일로 뺐다). 이 파일에서
 *     직접 만들지 않는다.
 */

import {
  computeAppearanceHeaderStats,
  computeCompetitorBrands,
  selectTopCompetitors,
  isValidRecord,
  type CompetitorBrandRow,
} from './query-detail';
import { classifyExposureBadge, type ExposureBadge } from './badge-thresholds';
import { topicParticle, quoteParticle } from './korean-utils';
import { truncateExcerpt, type QuerySnapshotRecord, type AggregatedKeywordRow } from './supabase';

export interface TopKeyword {
  keyword: string;
  count: number;
}

/**
 * 여러 날짜 × 여러 엔진에 걸쳐 이미 하루 단위로 집계된 top_keywords 배열들을
 * 하나로 합친다. 같은 문자열이면 count를 더하고, 합산 기준 내림차순 상위
 * topN개만 남긴다. keyword-extractor.ts의 countTopKeywords와 원칙은 같지만
 * (LLM 재호출 없이 코드로 결정적 계산), 입력이 "문단별 표현 목록"이 아니라
 * "이미 집계된 TopKeyword 목록 여러 개"라는 점이 다르다.
 *
 * ⚠️ 알려진 한계(정규화 안 됨, Notion 부채 트래커 Day12 항목과 동일 성격):
 * "협진 시스템"과 "협진 진료 시스템"은 문자열이 다르므로 다른 키워드로
 * 카운트된다. 의미 단위 정규화는 이번 범위 밖.
 */
export function combineTopKeywords(
  lists: (TopKeyword[] | null | undefined)[],
  topN = 5
): TopKeyword[] {
  const countByKeyword = new Map<string, number>();
  const firstSeenOrder: string[] = [];

  for (const list of lists) {
    if (!list) continue;
    for (const { keyword, count } of list) {
      if (!countByKeyword.has(keyword)) {
        countByKeyword.set(keyword, 0);
        firstSeenOrder.push(keyword);
      }
      countByKeyword.set(keyword, countByKeyword.get(keyword)! + count);
    }
  }

  return firstSeenOrder
    .map((keyword) => ({ keyword, count: countByKeyword.get(keyword)! }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

export interface InterpretationCompetitor {
  name: string;
  topKeywords: TopKeyword[];
}

/**
 * "{타겟}{은/는} '{표현}'{이라는/라는} 표현과 함께 등장하고, {경쟁사}
 * {은/는} '{표현}'{이라는/라는} 다른 표현과 함께 등장하고 있어요. 어떤
 * 표현이 실제 선택으로 이어지는지는 아직 확인하지 못했어요." — 고정
 * 템플릿(작업지시서 4번, 마지막 문장 변경 금지: "간극" 화면의 역할을 이
 * 화면이 침범하지 않기 위함). 조사만 동적으로 맞춘다.
 *
 * 타겟/경쟁사 어느 한쪽이라도 top 키워드가 없으면 null — 호출부가
 * "대신 등장한 브랜드" 패턴이나 키워드 없이 목록만 보여주는 쪽으로
 * 폴백해야 한다.
 */
export function buildInterpretationSentence(params: {
  targetBrandName: string;
  targetTopKeywords: TopKeyword[];
  competitor: InterpretationCompetitor | null;
}): string | null {
  const { targetBrandName, targetTopKeywords, competitor } = params;
  if (targetTopKeywords.length === 0) return null;
  if (!competitor || competitor.topKeywords.length === 0) return null;

  const targetKeyword = targetTopKeywords[0].keyword;
  const competitorKeyword = competitor.topKeywords[0].keyword;

  return (
    `${targetBrandName}${topicParticle(targetBrandName)} '${targetKeyword}'${quoteParticle(targetKeyword)} 표현과 함께 등장하고, ` +
    `${competitor.name}${topicParticle(competitor.name)} '${competitorKeyword}'${quoteParticle(competitorKeyword)} 다른 표현과 함께 등장하고 있어요. ` +
    `어떤 표현이 실제 선택으로 이어지는지는 아직 확인하지 못했어요.`
  );
}

export interface RepresentativeSnapshot {
  engine: string;
  executedAt: string;
  excerpt: string;
}

export interface QueryPositionStats {
  queryId: string;
  queryText: string;
  totalRuns: number;
  appearedRuns: number;
  visibilityRate: number;
  badge: ExposureBadge;
  /** selectTopCompetitors 결과 그대로 — 타겟 포함, 등장률 내림차순. */
  competitorRows: CompetitorBrandRow[];
  targetTopKeywords: TopKeyword[];
  topCompetitor: { name: string; brandId: string | null; rate: number; topKeywords: TopKeyword[] } | null;
  /** null이면 화면에서 해석 문장 대신 폴백 UI를 써야 한다. */
  interpretation: string | null;
  /**
   * "실제 근거" 카드용 대표 관측 1건 — 타겟이 실제로 등장했을 때만
   * (strong/sometimes) 존재한다. 질문상세 화면의 "대표 근거" 선정
   * 규칙과 동일하게 가장 최근 것을 대표로 쓴다.
   */
  representativeSnapshot: RepresentativeSnapshot | null;
}

/**
 * 질문 하나에 대해 위 모든 걸 계산해서 화면이 바로 쓸 수 있는 형태로 만든다.
 *
 * @param records 이 질문의 진단 기간 전체 snapshot+mentions
 *   (fetchQuerySnapshotsWithMentionsBatch 결과에서 이 질문 몫만).
 * @param keywordRows 이 질문의 진단 기간 전체 daily 집계 행들
 *   (fetchAggregatedKeywordRowsForQueries 결과에서 이 질문 몫만) — 여러
 *   날짜 × 여러 엔진 행이 섞여 있고, combineTopKeywords가 합친다.
 * @param knownBrandIdByName 경쟁사 이름 → brandId. competitor_data는
 *   brandId로 키가 잡혀 있는데 CompetitorBrandRow는 이름만 노출해서 필요.
 *   미등록 브랜드(예: 파서가 감지만 한 "○○치과")는 이 맵에 없고, 그 경우
 *   경쟁사 키워드는 애초에 존재하지 않는다(집계 대상이 등록 브랜드
 *   3곳뿐이므로) — topCompetitor.topKeywords가 자연히 빈 배열이 된다.
 */
export function buildQueryPositionStats(params: {
  queryId: string;
  queryText: string;
  records: QuerySnapshotRecord[];
  brandNameById: Map<string, string>;
  keywordRows: AggregatedKeywordRow[];
  targetBrandName: string;
  knownBrandIdByName: Map<string, string>;
}): QueryPositionStats {
  const headerStats = computeAppearanceHeaderStats(params.records);
  const badge = classifyExposureBadge(headerStats.totalValidRuns, headerStats.rate);

  const competitorRows = selectTopCompetitors(
    computeCompetitorBrands(params.records, params.brandNameById)
  );

  const targetTopKeywords = combineTopKeywords(params.keywordRows.map((r) => r.topKeywords));

  const topCompetitorRow = competitorRows.find((r) => !r.isTarget) ?? null;
  let topCompetitor: QueryPositionStats['topCompetitor'] = null;
  if (topCompetitorRow) {
    const brandId = params.knownBrandIdByName.get(topCompetitorRow.name) ?? null;
    const competitorTopKeywords = brandId
      ? combineTopKeywords(params.keywordRows.map((r) => r.competitorData?.[brandId]?.topKeywords))
      : [];
    topCompetitor = {
      name: topCompetitorRow.name,
      brandId,
      rate: topCompetitorRow.rate,
      topKeywords: competitorTopKeywords,
    };
  }

  // 규칙 C: 타겟이 실제로 등장했을 때만(strong/sometimes) 해석 문장을 시도한다.
  const interpretation =
    badge === 'strong' || badge === 'sometimes'
      ? buildInterpretationSentence({
          targetBrandName: params.targetBrandName,
          targetTopKeywords,
          competitor: topCompetitor,
        })
      : null;

  // 대표 근거: 타겟이 실제로 등장한 유효 관측 중 가장 최근 것 하나.
  // (프로토타입 예시와 동일 — none/insufficient는 타겟 등장 자체가
  // 없거나 판단을 유보하는 상태라 근거를 안 보여준다)
  let representativeSnapshot: RepresentativeSnapshot | null = null;
  if (badge === 'strong' || badge === 'sometimes') {
    const appeared = params.records
      .filter(isValidRecord)
      .filter((r) => r.mentions.some((m) => m.isTarget))
      .sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1));
    const latest = appeared[0];
    if (latest) {
      representativeSnapshot = {
        engine: latest.engine,
        executedAt: latest.executedAt,
        excerpt: truncateExcerpt(latest.rawResponse),
      };
    }
  }

  return {
    queryId: params.queryId,
    queryText: params.queryText,
    totalRuns: headerStats.totalValidRuns,
    appearedRuns: headerStats.appearedRuns,
    visibilityRate: headerStats.rate,
    badge,
    representativeSnapshot,
    competitorRows,
    targetTopKeywords,
    topCompetitor,
    interpretation,
  };
}

/**
 * 히어로 질문 선정(작업지시서 3번): "판단할 데이터가 부족함"이 아닌 것들
 * 중에서 등장률(visibilityRate) 최고인 1개. 전부 부족 상태면(진단 극초반)
 * null — 호출부가 "아직 데이터가 충분히 쌓이지 않았어요" 안내로 대체해야
 * 한다.
 */
export function selectHeroQuery(stats: QueryPositionStats[]): QueryPositionStats | null {
  const judgeable = stats.filter((s) => s.badge !== 'insufficient');
  if (judgeable.length === 0) return null;

  return judgeable.reduce((best, cur) => (cur.visibilityRate > best.visibilityRate ? cur : best));
}

/**
 * "나머지 자리 질문" 목록 정렬(작업지시서엔 명시 없음, 프로토타입 예시가
 * strong→sometimes→none→insufficient 순으로 보여줘서 그 순서를 그대로
 * 따름 — 코난 판단). 같은 등급 안에서는 등장률 내림차순.
 */
const BADGE_ORDER: Record<ExposureBadge, number> = {
  strong: 0,
  sometimes: 1,
  none: 2,
  insufficient: 3,
};

export function sortForQuestionList(stats: QueryPositionStats[]): QueryPositionStats[] {
  return [...stats].sort((a, b) => {
    const badgeDiff = BADGE_ORDER[a.badge] - BADGE_ORDER[b.badge];
    if (badgeDiff !== 0) return badgeDiff;
    return b.visibilityRate - a.visibilityRate;
  });
}

/**
 * 팁 박스용 "가장 약한 질문" 선정 — 히어로(가장 강한 질문)와 대비시켜
 * "질문에 따라 강점과 빈자리가 다르다"는 걸 보여주는 게 목적이다.
 * insufficient(판단 유보)는 대비 대상으로 못 쓴다 — 판단을 안 한 상태를
 * "약하다"고 단정하면 매니페스토 3번(추측과 사실 구분) 위반.
 */
export function selectWorstQuery(
  stats: QueryPositionStats[],
  excludeQueryId: string
): QueryPositionStats | null {
  const judgeable = stats.filter((s) => s.badge !== 'insufficient' && s.queryId !== excludeQueryId);
  if (judgeable.length === 0) return null;

  return judgeable.reduce((worst, cur) => (cur.visibilityRate < worst.visibilityRate ? cur : worst));
}

/**
 * 팁 박스 설명 문장 — "이번 진단에서 {브랜드}는 '{베스트}'에서는 가장 자주
 * 등장했지만, '{워스트}'에서는 {등장 안 함/상대적으로 덜 등장} 표현으로
 * 갈린다. worst.badge==='none'일 때만 "아직 등장하지 않았어요"라고 단정
 * 한다 — sometimes(등장은 했음)인데 "등장하지 않았다"고 쓰면 사실과
 * 다르다(매니페스토 3번).
 */
export function buildTipDescription(
  brandName: string,
  best: QueryPositionStats,
  worst: QueryPositionStats
): string {
  const worstClause = worst.badge === 'none' ? '아직 등장하지 않았어요' : '상대적으로 덜 등장했어요';

  return (
    `이번 진단에서 ${brandName}${topicParticle(brandName)} '${best.queryText}'에서는 가장 자주 등장했지만, ` +
    `'${worst.queryText}'에서는 ${worstClause}. 어떤 질문을 관찰하느냐에 따라 브랜드의 강점과 빈자리가 다르게 보여요.`
  );
}
