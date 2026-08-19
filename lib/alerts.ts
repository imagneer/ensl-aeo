// lib/alerts.ts

/**
 * 알림 가드레일 판정 로직 (Day 13)
 *
 * aggregated_metrics에 쌓인 daily 집계를 읽어서 "이건 진짜 신호다"라고
 * 판정된 것만 alerts 표에 남긴다. 실제 발송(이메일/슬랙)은 이 파일 밖의
 * 몫이고, 여기서는 판정까지만 한다.
 *
 * PRD 원칙("1회 관측으로 결론 내지 않는다")이 코드로 강제되는 자리다.
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (2026-08-19 루아 확인)
 * ─────────────────────────────────────────────────────────
 *  1. 알림 대상은 "3일 연속 미노출"(daily 집계 mention_count=0) 하나뿐이다.
 *     등급도 sustained_miss 하나만 쓴다.
 *     ⚠️ 검토 과정에서 "하루만 빠져도 즉시 알림"(daily_miss 등급 추가)을
 *     검토했다가 폐기했다. 이유: 매일의 노출 현황은 대시보드가 게이트 없이
 *     그대로 보여주므로(Day16), alerts 표까지 매일 울릴 이유가 없다. 브랜드가
 *     늘어날수록 알림함이 도배돼서 정작 진짜 신호를 무시하게 된다.
 *
 *     ⚠️ "0은 아니지만 평소보다 크게 떨어진" 급락은 아직 알림 대상이 아니다.
 *     "평소 노출률"의 기준을 정의해야 하는데 그 기준 자체가 미검증이라 뺐다.
 *
 *  2. 경쟁사 동조는 회차(스냅샷) 단위로 판정한다 — 날짜 단위가 아니다.
 *     3일 window 안의 모든 유효 회차를 훑어서, 경쟁사가 단 한 번이라도
 *     언급된 회차가 있으면 competitor_correlated=false("우리만의 문제"),
 *     한 번도 없으면 true("시장/엔진 전체가 함께 조용했다").
 *
 *     왜 회차 단위인가 (루아의 3개월 실측 관찰에 근거):
 *       같은 날 안에서도 아침엔 경쟁사 포함 전부 안 나오다가 저녁엔 일부만
 *       나오는 식으로 회차마다 흔들린다. 하루 단위로 뭉치면 "타겟만 빠진
 *       회차가 있었다"는 결정적 증거가 사라진다.
 *
 *     ⚠️ "경쟁사 1곳만 함께 미노출이어도 동조"로 볼 뻔했다가 폐기했다.
 *     경쟁사 노출 자체가 원래 들쭉날쭉해서, 무관한 노이즈를 "시장 탓"으로
 *     오판하게 된다.
 *
 *  3. competitor_correlated는 표시형이다 — 동조로 판정돼도 알림은 만든다.
 *     플래그만 붙여서 대시보드에서 성격을 구분해 보여줄 수 있게 한다.
 *     (억제형이었다면 이 컬럼이 저장될 일 자체가 없다)
 *
 *  4. is_confirmed는 항상 false로 시작한다. "사람이 검토해서 진짜 신호로
 *     확정했는지"를 뜻하며, 그 검토 워크플로는 아직 없다(별도 과제).
 *
 *  5. 같은 (query, brand, engine, alert_type) 조합에 resolved_at이 NULL인
 *     알림이 이미 있으면 새로 만들지 않고 consecutive_periods만 갱신한다.
 *     노출이 회복되면 resolved_at을 채워 종료한다.
 *     → 나흘째, 닷새째로 이어져도 알림은 "진행 중인 사건" 1건으로 유지된다.
 *
 * ─────────────────────────────────────────────────────────
 * 관통하는 원칙: "모른다"를 "나쁘다"로 바꿔치기하지 않는다
 * ─────────────────────────────────────────────────────────
 *   - totalRuns=0(그날 유효 관측 0건)은 미노출이 아니라 판정 불가다.
 *     연속에 포함시키지 않고 거기서 끊는다. 못 잰 걸 미노출로 세면
 *     수집 인프라 장애를 브랜드 노출 문제로 오판하게 된다.
 *   - 그 3일 구간에 유효 회차가 하나도 없으면 동조 여부는 확인 불가다.
 *     이 경우 false(우리만의 문제)로 둔다 — 판단 불가를 시장 탓으로
 *     돌리지 않는다.
 *   - 오늘 데이터가 없으면 "회복됐다"고 보지 않는다. 진행 중인 알림을
 *     그대로 열어둔 채 보류한다.
 *
 * ⚠️ 시각 비교 함정 (2026-08-19 실측): JS의 toISOString()은 "...Z" 형식,
 *    Postgres의 timestamptz는 "...+00:00" 형식을 준다. 같은 순간인데 글자가
 *    달라서 문자열 직접 비교(===/!==)는 위험하다. getTime()으로 비교한다.
 *    (DB에 조건을 맡기는 .eq() 방식은 안전 — Postgres가 시각 타입으로 비교함)
 *
 * ⚠️ 권한 전제조건: service_role이 alerts 표 권한이 없으면 판정이 조용히
 *    실패한다(2026-08-19 실측 확인). Supabase SQL Editor에서 먼저 실행:
 *      GRANT ALL ON public.alerts TO service_role;
 */

import type { RecentDailyMetric } from './supabase';
import {
  fetchActiveQueries,
  fetchKnownBrands,
  fetchRecentDailyMetrics,
  fetchSnapshotsForAggregation,
  fetchMentionsForAggregation,
  findOpenAlert,
  insertAlert,
  updateAlert,
  resolveAlert,
} from './supabase';
import { kstDayBoundsUtc } from './aggregator';
import { ENGINE_NAMES } from './engine-config';

// ── 규칙 1: 연속 미노출 판정 ──

export interface ConsecutiveMissResult {
  consecutiveDays: number;
  periods: RecentDailyMetric[]; // 실제로 연속 미노출로 카운트된 날짜들 (최신순)
}

/**
 * 최근 daily 집계(최신순 정렬)를 앞에서부터 훑어서, mention_count=0인 날이
 * 며칠 연속인지 센다. (규칙 1, 2026-08-19 확인)
 *
 * 판정:
 *   - totalRuns > 0 && mentionCount === 0 → "미노출 확인됨" (연속에 포함)
 *   - totalRuns === 0                     → "판정 불가"(수집 실패/스킵) → 연속 끊음
 *   - mentionCount > 0                    → "노출됨" → 연속 끊음
 *   - 하루 이상 간격이 빈 경우(그날 행 자체가 없음, 즉 aggregator 규칙 E에서
 *     스냅샷 시도조차 없었던 날) → 판정 불가와 동일하게 연속 끊음
 *
 * 왜 판정 불가를 미노출로 안 세는가: totalRuns=0은 "우리가 못 쟀다"는
 * 뜻이지 "안 나왔다"는 뜻이 아니다. 못 잰 걸 미노출로 세면 수집 인프라
 * 장애를 브랜드 노출 문제로 오판하게 된다 — 규칙 2(경쟁사 동조)와 같은 함정.
 */
export function checkConsecutiveMissDays(
  recentMetrics: RecentDailyMetric[]
): ConsecutiveMissResult {
  const streak: RecentDailyMetric[] = [];

  for (const row of recentMetrics) {
    if (row.totalRuns === 0) break;      // 판정 불가
    if (row.mentionCount > 0) break;     // 노출됨

    if (streak.length > 0) {
      const prevDate = new Date(streak[streak.length - 1].periodStart);
      const currDate = new Date(row.periodStart);
      const diffDays = (prevDate.getTime() - currDate.getTime()) / (24 * 60 * 60 * 1000);
      if (diffDays !== 1) break; // 날짜가 하루 간격이 아님 → 그 사이 행이 통째로 없음
    }

    streak.push(row);
  }

  return { consecutiveDays: streak.length, periods: streak };
}

export interface CompetitorCorrelationParams {
  queryId: string;
  engine: string;
  periods: RecentDailyMetric[]; // checkConsecutiveMissDays 결과의 periods (최신순)
  competitorBrandIds: string[];
}

/**
 * 연속 미노출 구간 동안, 경쟁사도 함께 안 나왔는지 확인한다.
 * (규칙 2, 2026-08-19 확인 — 회차/스냅샷 단위 판정)
 *
 * 판정: 이 구간의 모든 유효 회차(status='success' && search_performed=true)를
 * 훑어서, 경쟁사가 단 한 번이라도 언급된 회차가 있으면 false("우리만의 문제"),
 * 한 번도 없으면 true("시장/엔진 전체가 함께 조용했다").
 *
 * 타겟 브랜드의 부재는 이 함수에서 다시 확인하지 않는다 — checkConsecutiveMissDays가
 * 이미 daily 집계(mention_count=0)로 확인한 사실을 그대로 신뢰한다. 원본
 * snapshots/mentions까지 내려가서 타겟 부재를 재확인하면, 두 곳(daily 집계 vs
 * 원본 조회)의 판정이 어긋날 경우 어느 쪽을 믿어야 할지 모르는 상황이 생긴다.
 *
 * 유효 회차가 0개면(그 구간이 전부 실패/스킵) 동조 여부를 확인할 근거가 없다
 * → false를 돌려준다(판단 불가를 시장 탓으로 돌리지 않는다 — 규칙 2의 원래
 * 취지와 같은 이유).
 */
export async function checkCompetitorCorrelation(
  params: CompetitorCorrelationParams
): Promise<boolean> {
  if (params.periods.length === 0 || params.competitorBrandIds.length === 0) {
    return false;
  }

  const oldestStart = params.periods[params.periods.length - 1].periodStart;
  const newestStart = params.periods[0].periodStart;
  const windowEnd = new Date(
    new Date(newestStart).getTime() + 24 * 60 * 60 * 1000
  ).toISOString();

  const snapshots = await fetchSnapshotsForAggregation({
    queryId: params.queryId,
    engine: params.engine,
    periodStart: oldestStart,
    periodEnd: windowEnd,
  });

  const validSnapshots = snapshots.filter(
    (s) => s.status === 'success' && s.searchPerformed === true
  );
  if (validSnapshots.length === 0) return false;

  const mentions = await fetchMentionsForAggregation(validSnapshots.map((s) => s.id));

  const competitorMentionedSnapshotIds = new Set(
    mentions
      .filter((m) => m.brandId !== null && params.competitorBrandIds.includes(m.brandId))
      .map((m) => m.snapshotId)
  );

  return competitorMentionedSnapshotIds.size === 0;
}
// ── 규칙 5: 진행 중인 알림 갱신/생성/종료 ──

/**
 * sustained_miss 알림을 갱신하거나 새로 만든다.
 * 반환값은 오케스트레이터(runAlertCheckForDay)가 하루 요약을 만들 때 쓴다.
 */
export async function upsertAlert(params: {
  queryId: string;
  brandId: string;
  engine: string;
  consecutiveDays: number;
  competitorCorrelated: boolean;
  periods: RecentDailyMetric[];
}): Promise<'created' | 'updated'> {
  const existing = await findOpenAlert({
    queryId: params.queryId,
    brandId: params.brandId,
    engine: params.engine,
    alertType: 'sustained_miss',
  });

  // details에는 이 판정의 근거 기간을 남긴다 — alerts 테이블엔 period_start/end가
  // 없어서, 나중에 "이 알림이 왜 떴는지" 검증하려면 여기 기록해두는 수밖에 없다.
  const details = { periodStarts: params.periods.map((p) => p.periodStart) };

  if (existing) {
    await updateAlert(existing.id, {
      consecutivePeriods: params.consecutiveDays,
      competitorCorrelated: params.competitorCorrelated,
      details,
    });
    return 'updated';
  }

  await insertAlert({
    queryId: params.queryId,
    brandId: params.brandId,
    engine: params.engine,
    alertType: 'sustained_miss',
    consecutivePeriods: params.consecutiveDays,
    competitorCorrelated: params.competitorCorrelated,
    details,
  });
  return 'created';
}

/**
 * 오늘 노출이 회복됐으면(mentionCount > 0), 진행 중인 알림이 있는지 확인하고 종료 처리한다.
 * 진행 중인 알림이 없었으면 false를 돌려준다(아무 일도 안 일어남).
 */
export async function resolveAlertIfRecovered(params: {
  queryId: string;
  brandId: string;
  engine: string;
}): Promise<boolean> {
  const existing = await findOpenAlert({
    queryId: params.queryId,
    brandId: params.brandId,
    engine: params.engine,
    alertType: 'sustained_miss',
  });

  if (!existing) return false;

  await resolveAlert(existing.id);
  return true;
}
// ── 하루 전체 알림 판정 (Day 13 오케스트레이터) ──

export interface AlertCheckSummary {
  dateKST: string;
  attempted: number;  // (쿼리 × 엔진) 조합 중 실제로 확인해본 개수
  created: number;    // 새로 생긴 알림
  updated: number;     // 기존 진행 중 알림의 연속 일수 갱신
  resolved: number;    // 회복돼서 종료된 알림
  pending: number;      // 오늘 데이터가 없거나 totalRuns=0이라 판단을 보류한 개수
  errored: 0,   // ← 이 줄이 있는지 확인
}

/**
 * 특정 KST 날짜에 대해, 활성 쿼리 × 전체 엔진 조합을 전부 확인해서
 * 알림 판정(생성/갱신/종료/보류)을 실행한다.
 *
 * 오늘 상태 판정 순서 (2026-08-19 확인):
 *   1. 오늘 행이 없거나 totalRuns=0 → 보류 (기존 알림 상태 그대로 둠)
 *   2. 오늘 mentionCount>0 → 회복 처리
 *   3. 오늘 totalRuns>0 && mentionCount=0 → 연속 일수 계산 → 3일 이상이면 알림
 *
 * aggregateAllQueriesForDay와 같은 이유로 순차 처리한다 — 실패 지점을
 * 로그에서 바로 찾을 수 있어야 해서, 지금 규모(하루 30건 이내)에서는
 * 병렬 처리로 얻는 속도 이득보다 이게 더 중요하다.
 */
export async function runAlertCheckForDay(dateKST: string): Promise<AlertCheckSummary> {
  const { periodStart: todayPeriodStart } = kstDayBoundsUtc(dateKST);

  const queries = await fetchActiveQueries();
  const knownBrands = await fetchKnownBrands();

  const summary: AlertCheckSummary = {
    dateKST,
    attempted: 0,
    created: 0,
    updated: 0,
    resolved: 0,
    pending: 0,
    errored: 0,   // ← 이 줄이 있는지 확인
  };

  for (const query of queries) {
    const competitorBrandIds = knownBrands
      .filter((b) => b.brandId !== query.brandId)
      .map((b) => b.brandId);

    for (const engine of ENGINE_NAMES) {
      summary.attempted++;

      try {
      const recent = await fetchRecentDailyMetrics({
        queryId: query.id,
        brandId: query.brandId,
        engine,
        limit: 10,
      });

      const today = recent[0];
 
      // 판정 1: 오늘 행이 없거나(아직 집계 전) totalRuns=0(측정 실패) → 보류
      //
      // ⚠️ periodStart는 문자열로 직접(!==) 비교하면 안 된다 (2026-08-19 실측
      //    확인). JS의 new Date().toISOString()은 "...Z" 형식을 주는데,
      //    Postgres가 돌려준 timestamptz 값은 "...+00:00" 형식이다. 둘은
      //    완전히 같은 순간을 가리켜도 글자 모양이 달라서 !==가 "다르다"고
      //    잘못 판단한다. 실제 시각(getTime())으로 비교해야 이 함정을 피한다.
      const isTodayRow =
         today !== undefined &&
         new Date(today.periodStart).getTime() === new Date(todayPeriodStart).getTime();

      if (!isTodayRow || today!.totalRuns === 0) {
        summary.pending++;
        continue;
      }

      // 판정 2: 오늘 노출 확인됨 → 회복 처리
      if (today.mentionCount > 0) {
        const wasResolved = await resolveAlertIfRecovered({
          queryId: query.id,
          brandId: query.brandId,
          engine,
        });
        if (wasResolved) summary.resolved++;
        continue;
      }

      // 판정 3: 오늘 미노출 확인됨 → 연속 일수 계산
      const { consecutiveDays, periods } = checkConsecutiveMissDays(recent);

      if (consecutiveDays < 3) continue; // 아직 3일 안 됨 — 알림 없음

      const competitorCorrelated = await checkCompetitorCorrelation({
        queryId: query.id,
        engine,
        periods,
        competitorBrandIds,
      });

      const result = await upsertAlert({
        queryId: query.id,
        brandId: query.brandId,
        engine,
        consecutiveDays,
        competitorCorrelated,
        periods,
      });

      if (result === 'created') summary.created++;
      else summary.updated++;
      } catch (error) {
        console.error(
          `알림 판정 실패 (query=${query.id}, engine=${engine}):`,
          error
        );
        summary.errored++;
      }
    }
  }

  return summary;
}