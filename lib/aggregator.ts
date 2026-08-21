// lib/aggregator.ts

/**
 * 집계 로직 (Day 9) — snapshots·mentions의 개별 관측치를 묶어서
 * aggregated_metrics 표에 확률 데이터(노출률%, 평균순위, 표준편차) 1줄로 저장한다.
 *
 * PRD 원칙("단발 관측으로 결론 내지 않는다")을 실제로 구현하는 자리다.
 * 이 파일이 만드는 숫자가 나중에 알림(Day 12)과 대시보드(Week 4)의 기준이 된다.
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (2026-08-17 루아 확인, day9-decision-aggregation.md 참고)
 * ─────────────────────────────────────────────────────────
 *  A. 한 행 = (쿼리, 엔진, 기간, aggregation_level) 조합마다 그 쿼리의
 *     타겟 브랜드(queries.brand_id) 기준 1행. 같은 기간 다른 등록 브랜드들의
 *     노출률은 competitor_data(jsonb)에 요약해서 같은 행에 넣는다.
 *     ⚠️ 한계: 경쟁사 자체의 시계열 추이는 이 표만으로 못 뽑는다(jsonb라
 *     시계열 집계에 비효율적). 필요해지면 브랜드별 행 분리로 바꿔야 한다.
 *
 *  B. 순위 지표(avgRank/rankStddev)는 mentions.rank(=overallRank, 미등록
 *     브랜드까지 포함한 절대 등장 순서)를 그대로 쓴다. rankAmongKnown(등록
 *     브랜드끼리의 순위)은 현재 DB에 저장되지 않아서 못 쓴다 — 별도 과제.
 *     ⚠️ 미등록 경쟁사가 답변마다 들쭉날쭉 등장하면, 등록 경쟁사 대비 위치는
 *     안 변했는데 overallRank만 흔들려서 "순위가 나빠졌다"는 착시가 생길 수 있다.
 *
  *  C. 분모(totalRuns)는 유효 관측치만 센다:
 *       status='success' AND search_performed=true
 *     실패(status='failed')와 검색-스킵(search_performed=false)은 둘 다 제외한다.
 *     (search_performed=false를 포함하면 "AEO 개선 효과가 반영될 수 없는 관측"이
 *      노출률에 섞여서, 콘텐츠를 개선해도 수치가 안 오르는 것처럼 보일 위험이 있다.
 *      이 원칙은 AGENTS.md에 이미 있던 것 — Day 9에서 분모 계산에 실제로 반영함)
 *     (2026-08-18 Day 13에서 해결) 제외된 실패/스킵 건수는 이제 failedCount/
 *     skippedCount로 따로 저장한다. "실패율이 높아서 표본이 적은 기간"과
 *     "표본이 원래 적은 기간"을 이제 구분할 수 있다.
 *
 *  D. 언급된 관측치가 2개 미만이면 rankStddev는 null로 남긴다.
 *     "표준편차 계산 불가"와 "편차가 0(항상 같은 순위)"은 다른 사실이라
 *     0으로 채우면 안 된다.
 *
 *  E. 그 기간에 시도(스냅샷)는 있었지만 유효 관측치가 0건이면(전부 실패거나
 *     전부 검색 스킵), 행을 건너뛰지 않고 totalRuns=0, visibilityRate=null인
 *     행을 그대로 저장한다. 조용히 건너뛰면 "그 기간엔 관측이 아예 없었다"와
 *     "관측을 시도했는데 전부 실패/스킵됐다"를 구분할 수 없게 된다.
 *     반대로 그 기간에 스냅샷 시도 자체가 없었으면(수집이 아예 안 돌았으면)
 *     행을 만들지 않는다 — 일어나지 않은 일을 기록하면 안 된다.
 *
 * ⚠️ 통계 방식: rankStddev는 표본표준편차(n-1, 불편추정량)를 쓴다. 매 관측을
 *    "AI가 낼 수 있는 모든 응답 중 하나의 표본"으로 보는 게 이 프로젝트의
 *    전제(PRD "확률 측정")와 맞기 때문이다. 모표준편차(n)를 쓰면 관측이 적을 때
 *    편차를 과소평가한다. (2026-08-17 판단 — 통계적으로 사소하지 않은 선택이라
 *    명시해둔다. n=2~6인 지금 표본 크기에서는 둘의 차이가 꽤 크다)
 *
 * ⚠️ 권한 전제조건: service_role이 aggregated_metrics에 대한 권한이 없으면
 *    (2026-08-17 실측 확인된 상태) 이 파일의 저장 함수가 전부 실패한다.
 *    Supabase SQL Editor에서 먼저 실행:  GRANT ALL ON public.aggregated_metrics TO service_role;
 */

import {
  fetchActiveQueries,
  fetchKnownBrands,
  fetchSnapshotsForAggregation,
  fetchSnapshotsForKeywordExtraction,
  fetchMentionsForAggregation,
  fetchFailedKeywordExtractionRows,
  saveAggregatedMetric,
  updateKeywordExtractionResult,
  type SnapshotForAggregation,
  type MentionForAggregation,
  type AggregatedMetricToSave,
} from './supabase';

import { parseBrandMentions, type KnownBrand } from './parser';
import {
  buildBrandParagraphs,
  extractExpressionsFromParagraphs,
  countTopKeywords,
  type TopKeyword,
} from './keyword-extractor';
import { retryWithBackoff, isRetryableLLMError } from './retry';

import { ENGINE_NAMES, type EngineName } from './engine-config';

// ── 통계 헬퍼 ──

function average(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * 표본표준편차 (n-1). 규칙 D 참고 — 호출부에서 nums.length >= 2를 보장해야 한다.
 * (여기서 강제하지 않는 이유: 이 함수 자체는 범용 통계 함수로 남기고,
 *  "2개 미만이면 null" 판정은 도메인 규칙이라 호출부인 aggregateOne에 둔다)
 */
function sampleStddev(nums: number[]): number {
  const avg = average(nums);
  const variance = nums.reduce((sum, n) => sum + (n - avg) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}


/**
 * 지금 이 순간 기준, "어제"에 해당하는 KST 날짜를 'YYYY-MM-DD' 문자열로 계산한다.
 * new Date().toISOString()을 그대로 쓰면 안 되는 이유: KST 00:00~08:59 시간대엔
 * UTC 날짜가 아직 하루 전이라, 호출 시각에 따라 우연히 맞거나 틀리는 상태가 된다.
 * 여기선 시각에 상관없이 항상 KST 기준으로 명시적으로 계산한다.
 */
export function yesterdayKST(): string {
  const nowUtc = new Date();
  const kstMs = nowUtc.getTime() + 9 * 60 * 60 * 1000; // UTC → KST로 이동
  const kstDate = new Date(kstMs);
  kstDate.setUTCDate(kstDate.getUTCDate() - 1); // KST 기준 하루 전
  return kstDate.toISOString().slice(0, 10);
}

// ── KST 날짜 경계 계산 ──

/**
 * KST(한국시간, UTC+9) 기준 하루의 시작·끝을 UTC ISO 문자열로 변환한다.
 *
 * 왜 필요한가 (day4-decision-schedule.md에서 이미 확인된 함정):
 *   Supabase의 executed_at은 UTC로 저장돼 있다. "오늘 하루"를 KST 기준
 *   00:00~24:00으로 정의하지 않고 UTC 00:00~24:00으로 잘못 계산하면,
 *   한국시간 오전 0~9시 관측이 전날로 잘못 묶인다.
 *
 * @param dateKST 'YYYY-MM-DD' 형식, 한국시간 기준 날짜
 */
export function kstDayBoundsUtc(dateKST: string): { periodStart: string; periodEnd: string } {
  const start = new Date(`${dateKST}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

export type TimeSlot = '아침' | '점심' | '저녁';

/**
 * UTC 시각을 KST로 바꿔서 어느 시간대인지 판정한다.
 * 경계: 06:00~11:59 아침 / 12:00~16:59 점심 / 17:00~23:59 저녁
 * 그 외(00:00~05:59)는 null — 라벨을 붙이지 않는다.
 */
export function kstTimeSlot(executedAt: string | Date): TimeSlot | null {
  const d = new Date(executedAt);
  // UTC 시각에 9시간을 더해 KST로 변환한 뒤, 그 시각의 '시'를 읽는다
  const kstHour = new Date(d.getTime() + 9 * 60 * 60 * 1000).getUTCHours();

  if (kstHour >= 6 && kstHour < 12) return '아침';
  if (kstHour >= 12 && kstHour < 17) return '점심';
  if (kstHour >= 17) return '저녁';
  return null;
}

// ── 핵심 집계 함수 ──

export interface AggregateOneParams {
  queryId: string;
  targetBrandId: string;
  engine: EngineName;
  aggregationLevel: 'batch' | 'daily';
  /** batch 레벨일 때만 사용. 주면 periodStart/End 대신 이 배치의 스냅샷만 모은다 */
  batchId?: string;
  /** daily 레벨(또는 batchId 없이 기간으로 모을 때) 사용 */
  periodStart?: string;
  periodEnd?: string;
}

interface KeywordExtractionResult {
  topKeywords: TopKeyword[] | null;
  status: 'success' | 'failed';
}

/**
 * (쿼리, 엔진, 기간) 조합 하나의 키워드 추출을 시도한다. (Day 15)
 *
 * position은 DB에 저장 안 돼 있어서(A안 결정), 원문을 다시 parseBrandMentions로
 * 재파싱해서 구한다 — Day 12 실측 검증을 거친 것과 동일한 함수 재사용.
 */
async function attemptKeywordExtraction(params: {
  queryId: string;
  engine: string;
  periodStart: string;
  periodEnd: string;
  targetBrandName: string;
  knownBrands: KnownBrand[];
}): Promise<KeywordExtractionResult> {
  try {
    const rawSnapshots = await fetchSnapshotsForKeywordExtraction({
      queryId: params.queryId,
      engine: params.engine,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
    });

    const snapshotsForParagraphs = rawSnapshots
      .map((s) => {
        const parsed = parseBrandMentions(s.rawResponse, params.knownBrands);
        if (!parsed.targetMention) return null; // 이 관측엔 타겟이 없었음(재파싱 기준)
        return {
          snapshotId: s.id,
          rawText: s.rawResponse,
          targetBrandName: params.targetBrandName,
          allMentions: parsed.mentions.map((m) => ({
            brandName: m.brandName,
            position: m.position,
          })),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const paragraphs = buildBrandParagraphs(snapshotsForParagraphs);

    // mentions 테이블 기준으론 언급됐는데 재파싱 결과 문단이 0개면, 저장된
    // mentions와 원문이 어긋난다는 뜻 — 같은 입력이면 항상 같은 결과가 나오므로
    // 재시도로 풀릴 문제가 아니다. success로 처리하고 빈 배열을 남긴다.
    if (paragraphs.length === 0) {
      return { topKeywords: [], status: 'success' };
    }

    const results = await retryWithBackoff(
      () => extractExpressionsFromParagraphs(params.targetBrandName, paragraphs),
      3,
      isRetryableLLMError
    );

    return { topKeywords: countTopKeywords(results, 5), status: 'success' };
  } catch (error) {
    console.error(
      `키워드 추출 실패 (query=${params.queryId}, engine=${params.engine}, period=${params.periodStart}):`,
      error
    );
    return { topKeywords: null, status: 'failed' };
  }
}

/**
 * (쿼리, 엔진, 기간) 조합 하나를 집계해서 저장 직전 형태(AggregatedMetricToSave)로 돌려준다.
 *
 * @param otherBrands competitor_data를 채울 때 쓸 "타겟이 아닌 등록 브랜드" 목록.
 *   매번 DB에서 다시 안 읽도록 호출부(aggregateAllQueriesForDay 등)에서 한 번만
 *   fetchKnownBrands()로 읽어서 넘겨준다.
 * @returns 그 기간에 스냅샷 시도가 아예 없었으면 null (규칙 E 후반부 — 없는 일을 기록하지 않는다)
 */
export async function aggregateOne(
  params: AggregateOneParams,
  otherBrands: { brandId: string; name: string }[],
  allKnownBrands: KnownBrand[]   // ← 추가
): Promise<AggregatedMetricToSave | null> {
  const snapshots = await fetchSnapshotsForAggregation({
    queryId: params.queryId,
    engine: params.engine,
    batchId: params.batchId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
  });

  // 규칙 E 후반부: 시도 자체가 없었으면 행을 만들지 않는다.
  if (snapshots.length === 0) return null;

  // 규칙 C: 유효 관측치 = 성공 + 실제로 검색을 수행한 것만.
  const validSnapshots = snapshots.filter(
    (s) => s.status === 'success' && s.searchPerformed === true
  );
  const totalRuns = validSnapshots.length;
  // 유효/실패/스킵은 서로 겹치지 않는 배타적 분류다 (status는 'success'|'failed' 둘뿐이므로
  // 항상 totalRuns + failedCount + skippedCount === snapshots.length 여야 정상이다)
  const failedCount = snapshots.filter((s) => s.status === 'failed').length;
  const skippedCount = snapshots.filter(
    (s) => s.status === 'success' && s.searchPerformed === false
  ).length;

  // 헤더 표시용 — 그날 실제로 몇 개 배치가, 어느 시간대에 돌았는지 (Day 17)
  const batchCount = new Set(snapshots.map((s) => s.batchId)).size;

  const SLOT_ORDER: TimeSlot[] = ['아침', '점심', '저녁'];
  const slotSet = new Set(
    snapshots
      .map((s) => kstTimeSlot(s.executedAt))
      .filter((v): v is TimeSlot => v !== null)
  );
  const timeSlots = SLOT_ORDER.filter((slot) => slotSet.has(slot));


  const validSnapshotIds = validSnapshots.map((s) => s.id);
  const mentions =
    validSnapshotIds.length > 0 ? await fetchMentionsForAggregation(validSnapshotIds) : [];

  // 실제 기간(period_start/end)은 호출부가 준 값을 우선 쓰되, batch 집계처럼
  // 명시적 기간이 없는 경우엔 실제로 관측된 스냅샷들의 시각 범위로 대체한다.
  const periodStart = params.periodStart ?? minExecutedAt(snapshots);
  const periodEnd = params.periodEnd ?? maxExecutedAt(snapshots);

  const targetStats = computeBrandStats(params.targetBrandId, mentions, totalRuns);

  const competitorData: AggregatedMetricToSave['competitorData'] =
    otherBrands.length > 0
      ? Object.fromEntries(
          otherBrands.map((b) => {
            const stats = computeBrandStats(b.brandId, mentions, totalRuns);
            return [
              b.brandId,
              {
                name: b.name,
                mentionCount: stats.mentionCount,
                visibilityRate: stats.visibilityRate,
                avgRank: stats.avgRank,
              },
            ];
          })
        )
      : null;

  let topKeywords: TopKeyword[] | null = null;
  let keywordExtractionStatus: 'success' | 'failed' | null = null;

  if (targetStats.mentionCount > 0) {
    const targetBrand = allKnownBrands.find((b) => b.brandId === params.targetBrandId);
    if (targetBrand) {
      const kwResult = await attemptKeywordExtraction({
        queryId: params.queryId,
        engine: params.engine,
        periodStart,
        periodEnd,
        targetBrandName: targetBrand.name,
        knownBrands: allKnownBrands,
      });
      topKeywords = kwResult.topKeywords;
      keywordExtractionStatus = kwResult.status;
    }
  }

  return {
    queryId: params.queryId,
    brandId: params.targetBrandId,
    engine: params.engine,
    periodStart,
    periodEnd,
    aggregationLevel: params.aggregationLevel,
    batchId: params.batchId ?? null,
    totalRuns,
    mentionCount: targetStats.mentionCount,
    visibilityRate: targetStats.visibilityRate,
    avgRank: targetStats.avgRank,
    rankStddev: targetStats.rankStddev,
    competitorData,
    failedCount,
    skippedCount,
    batchCount,
    timeSlots,
    topKeywords,              // ← 추가
    keywordExtractionStatus,  // ← 추가

  };
}

/** 특정 브랜드 하나의 mentionCount/visibilityRate/avgRank/rankStddev를 계산한다 (규칙 C·D 적용) */
function computeBrandStats(
  brandId: string,
  mentions: MentionForAggregation[],
  totalRuns: number
): { mentionCount: number; visibilityRate: number | null; avgRank: number | null; rankStddev: number | null } {
  // ⚠️ 같은 브랜드가 한 snapshot에서 두 번 잡힐 수 없다는 전제(parser.ts의
  // parseBrandMentions는 브랜드당 "가장 먼저 등장하는 위치" 하나만 채택함)에
  // 기대고 있다. 혹시 이 전제가 깨지면(버그 등) snapshot_id로 한 번 더 걸러야
  // 하는데, 지금은 그 전제가 성립한다는 걸 parser.ts 코드로 확인했으므로
  // 별도 dedupe 없이 진행한다.
  const brandMentions = mentions.filter((m) => m.brandId === brandId);
  const mentionCount = brandMentions.length;

  const visibilityRate = totalRuns > 0 ? mentionCount / totalRuns : null;

  const ranks = brandMentions.map((m) => m.rank);
  const avgRank = ranks.length > 0 ? average(ranks) : null;
  const rankStddev = ranks.length >= 2 ? sampleStddev(ranks) : null; // 규칙 D

  return { mentionCount, visibilityRate, avgRank, rankStddev };
}

function minExecutedAt(snapshots: SnapshotForAggregation[]): string {
  return snapshots.reduce((min, s) => (s.executedAt < min ? s.executedAt : min), snapshots[0].executedAt);
}

function maxExecutedAt(snapshots: SnapshotForAggregation[]): string {
  return snapshots.reduce((max, s) => (s.executedAt > max ? s.executedAt : max), snapshots[0].executedAt);
}

// ── 하루 전체 집계 (daily 레벨) ──

export interface DailyAggregationSummary {
  dateKST: string;
  attempted: number;   // (쿼리 × 엔진) 조합 중 실제로 시도해본 개수
  saved: number;        // 저장 성공 개수
  skipped: number;      // 그 기간에 스냅샷 자체가 없어서 건너뛴 개수 (규칙 E)
  failed: number;        // 저장 시도했는데 DB 에러로 실패한 개수
  keywordRetryAttempted: number;   // ← 추가: 오늘 재시도 시도한 실패건 개수
  keywordRetryRecovered: number;   // ← 추가: 그중 재시도로 성공한 개수
}

/**
 * status='failed'인 키워드 추출 건을 다시 시도한다. (Day 15)
 * aggregateAllQueriesForDay가 그날 할 일을 시작하기 전에 먼저 부른다 —
 * "오늘의 실행 기회"를 "어제 못 끝낸 일"에도 나눠주는 것.
 */
export async function retryFailedKeywordExtractions(): Promise<{
  attempted: number;
  recovered: number;
}> {
  const failedRows = await fetchFailedKeywordExtractionRows();
  const knownBrands = await fetchKnownBrands();

  let recovered = 0;

  for (const row of failedRows) {
    const brand = knownBrands.find((b) => b.brandId === row.brandId);
    if (!brand) continue; // 브랜드가 그 사이 삭제됐거나 못 찾으면 스킵(방어적)

    const result = await attemptKeywordExtraction({
      queryId: row.queryId,
      engine: row.engine,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      targetBrandName: brand.name,
      knownBrands,
    });

    await updateKeywordExtractionResult(row.id, result.topKeywords, result.status);
    if (result.status === 'success') recovered++;
  }

  return { attempted: failedRows.length, recovered };
}

/**
 * 특정 KST 날짜에 대해, 활성 쿼리 × 전체 엔진(6개) 조합을 전부 집계해서
 * aggregated_metrics에 daily 레벨로 저장한다.
 *
 * 왜 엔진을 4개(구현된 어댑터)가 아니라 ENGINE_NAMES 전체(6개)로 도는가:
 *   아직 Tier 1 어댑터(구글 AI Overviews, 네이버 AI브리핑)가 없어서 그 두 엔진은
 *   snapshots가 0건일 뿐이다. aggregateOne은 스냅샷이 0건이면 자동으로 null을
 *   돌려주고 건너뛰므로(규칙 E), 나중에 Tier 1 어댑터가 붙어도 이 함수는 코드
 *   수정 없이 그대로 동작한다. 지금 4개로 좁혀놓으면 그 때 또 고쳐야 한다.
 *
 * 왜 Promise.all이 아니라 순차 처리인가:
 *   DB 조회 자체(같은 Supabase 프로젝트)라 외부 API rate limit 문제는 없지만,
 *   (쿼리 5개 × 엔진 6개 =) 30개 조합을 한꺼번에 병렬로 쏘면 로그가 뒤섞여서
 *   실패했을 때 어느 조합이 실패했는지 읽기 어려워진다. 지금 데이터 규모(하루
 *   30건 이내)에서는 순차 처리 속도 손해가 무시할 만하다.
 */
export async function aggregateAllQueriesForDay(dateKST: string): Promise<DailyAggregationSummary> {
  const keywordRetryResult = await retryFailedKeywordExtractions();
  const { periodStart, periodEnd } = kstDayBoundsUtc(dateKST);

  const queries = await fetchActiveQueries();
  const knownBrands = await fetchKnownBrands();

  const summary: DailyAggregationSummary = { 
    dateKST, 
    attempted: 0, 
    saved: 0, 
    skipped: 0, 
    failed: 0, 
    keywordRetryAttempted: keywordRetryResult.attempted,   // ← 추가
    keywordRetryRecovered: keywordRetryResult.recovered,   // ← 추가
  
  };

  for (const query of queries) {
    const otherBrands = knownBrands
      .filter((b) => b.brandId !== query.brandId)
      .map((b) => ({ brandId: b.brandId, name: b.name }));

    for (const engine of ENGINE_NAMES) {
      summary.attempted++;

      const result = await aggregateOne(
        {
          queryId: query.id,
          targetBrandId: query.brandId,
          engine,
          aggregationLevel: 'daily',
          periodStart,
          periodEnd,
        },
        otherBrands,
        knownBrands   // ← 추가
      );

      if (result === null) {
        summary.skipped++;
        continue;
      }

      const savedId = await saveAggregatedMetric(result);
      if (savedId) {
        summary.saved++;
      } else {
        summary.failed++;
      }
    }
  }

  return summary;
}
