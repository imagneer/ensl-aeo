// lib/supabase.ts
// Supabase 클라이언트 — 프로젝트 전체에서 이 파일 하나만 import해서 사용

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** 읽기 전용 클라이언트 (브라우저에서도 안전) */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * 서버 전용 Supabase 클라이언트 (관리자 권한).
 *
 * ⚠️ 절대 브라우저(클라이언트 컴포넌트)에서 쓰지 말 것.
 *    이 키는 RLS를 통과하는 마스터키라, 노출되면 누구나 측정 데이터를 조작할 수 있다.
 *    반드시 app/api/... 안의 서버 코드에서만 사용한다.
 *
 * 왜 필요한가:
 *   anon 키는 공개되는 값이라 쓰기(INSERT) 권한을 주면 안 된다.
 *   측정 데이터를 외부에서 조작할 수 있게 되면 데이터 신뢰성이 무너진다.
 */
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,   // 서버에서는 세션을 저장할 필요 없음
    autoRefreshToken: false,
  },
});


// ── DB에서 브랜드 목록 가져오기 ──

import type { KnownBrand } from './parser';

/**
 * Supabase brands 테이블에서 브랜드 목록을 읽어온다.
 * parser.ts의 KNOWN_BRANDS 하드코딩을 대체하는 함수.
 *
 * 왜 async(비동기)인가:
 *   DB 조회는 네트워크를 타야 하니까 시간이 걸린다.
 *   "주문하고 기다렸다가 받는" 구조라서 await를 써야 한다.
 */
export async function fetchKnownBrands(): Promise<KnownBrand[]> {
  const { data, error } = await supabase
    .from('brands')
    .select('id, name, aliases, is_target');

  if (error) {
    console.error('brands 테이블 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    brandId: row.id,
    name: row.name,
    aliases: row.aliases || [],
    isTarget: row.is_target || false,
  }));
}
// ── DB에서 쿼리 목록 가져오기 ──

export interface StoredQuery {
  id: string;
  queryText: string;
  intent: string;

  /**
   * 이 쿼리가 원래 추적하려던 타겟 브랜드.
   * (2026-08-17, Day 9 추가) — 집계 로직이 "이 쿼리는 어느 브랜드를 위한
   * 관측인가"를 알아야 aggregated_metrics.brand_id를 채울 수 있어서 추가했다.
   * 이전까지는 이 필드가 필요한 소비처(집계)가 없어서 select에서 빠져 있었다.
   */
  brandId: string;
}

/**
 * Supabase queries 테이블에서 활성화된(is_active=true) 쿼리 목록을 읽어온다.
 * 하드코딩된 testQuery 문자열을 대체하는 함수.
 */
export async function fetchActiveQueries(): Promise<StoredQuery[]> {
  const { data, error } = await supabase
    .from('queries')
    .select('id, query_text, intent, brand_id')
    .eq('is_active', true);

  if (error) {
    console.error('queries 테이블 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    queryText: row.query_text,
    intent: row.intent,
    brandId: row.brand_id,
  }));
}
// ── 수집 결과를 DB에 저장하기 ──

import { ENGINE_CONFIG } from './engine-config';
import type { ParseResult, OverallMention } from './parser';
import type { RetrievedSource, CitedSpan } from './types';

export interface SnapshotToSave {
  queryId: string;
  engine: string;         // 어댑터가 돌려준 실제 engine 값 (예: 'claude', 'chatgpt')
  rawResponse: string;
  modelVersion: string;
  batchId: string;
  runIndex: number;
  status: 'success' | 'failed';
  errorMessage: string | null;

  /**
   * 본 것 — 검색해서 받아온 후보 출처 목록.
   *
   * ⚠️ null이 두 가지 뜻을 가진다. 구분은 status 칸으로 한다:
   *   status='success' + null → 이 엔진은 후보 목록을 제공하지 않음 (ChatGPT)
   *   status='failed'  + null → 수집 자체가 실패해서 아무것도 못 받음
   * 빈 배열([])은 또 다르다 — "제공은 하는데 이번엔 0개였음"(검색을 건너뛴 경우).
   */
  retrievedSources: RetrievedSource[] | null;

  /** 사용한 것 — 답변의 어느 구간이 어느 출처를 근거로 삼았는지 */
  citedSpans: CitedSpan[] | null;

  /**
   * 검색을 실제로 수행했는지.
   *
   * ⚠️ 수집 실패 시에는 false가 아니라 null이다.
   *    false는 "검색을 안 하고 답했다"는 사실 주장인데, 실패한 호출은
   *    답변 자체가 없었던 것이라 그렇게 말할 수 없다. false로 적으면
   *    나중에 "검색 없이 답한 관측"을 셀 때 실패분까지 섞여 들어간다.
   */
  searchPerformed: boolean | null;

  /**
   * Tier 1(SerpApi) 전용 - 검색 결과 페이지에 AI요약이 떴는지.
   * Tier 2 엔진은 이 개념이 없으므로 null.
   */
  overviewShown: boolean | null;
}

/**
 * snapshots 테이블에 원시 응답 1건을 저장하고, 생성된 snapshot의 id를 돌려준다.
 * mentions를 저장하려면 이 id가 필요하다 (외래키 연결).
 */


export async function saveSnapshot(snap: SnapshotToSave): Promise<string | null> {
  const tierInfo = ENGINE_CONFIG[snap.engine as keyof typeof ENGINE_CONFIG];

  if (!tierInfo) {
    console.error(`알 수 없는 엔진 이름: ${snap.engine} — engine-config.ts에 없음`);
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('snapshots')
    .insert({
      query_id: snap.queryId,
      engine: snap.engine,
      engine_tier: tierInfo.tier,
      raw_response: snap.rawResponse,
      model_version: snap.modelVersion,
      batch_id: snap.batchId,
      run_index: snap.runIndex,
      status: snap.status,
      error_message: snap.errorMessage,
      executed_at: new Date().toISOString(),
      // Day 8 추가 — 출처를 스냅샷 단위로 보존한다.
      // 이전에는 출처가 mentions에만 흘러가서, 브랜드가 하나도 안 잡힌 답변은
      // 그 답변이 참고한 출처가 통째로 사라졌다. 미노출 관측이야말로
      // "그럼 AI는 누구를 근거로 삼았나"를 봐야 하는 자리인데 그게 없어졌다.
      retrieved_sources: snap.retrievedSources,
      cited_spans: snap.citedSpans,
      search_performed: snap.searchPerformed,
      overview_shown: snap.overviewShown,
    })
    .select('id')
    .single();

  if (error) {
    console.error('snapshot 저장 실패:', error);
    return null;
  }

  return data.id;
}




export interface MentionToSave {
  snapshotId: string;
  brandId: string | null;
  brandNameRaw: string;
  isTarget: boolean;
  rank: number;

  /**
   * 이 브랜드에 연결된 출처 주소들.
   * ⚠️ Day 8부터 의미가 바뀌었다. 이전에는 답변 전체의 출처를 모든 브랜드에
   *    똑같이 복사했다(이름과 내용이 달랐다). 이제는 citation-linker가
   *    브랜드별로 갈라낸 값이 들어간다.
   */
  sourceUrls: string[];

  /** 이 브랜드에 연결된 출처 도메인들 — 엔진 간 비교는 이 값을 쓴다 */
  sourceDomains: string[];

  /**
   * 연결의 확신도. 판정 규칙은 lib/citation-linker.ts 참고.
   *   confirmed = 문단에 이 브랜드만 있었음
   *   estimated = 문단에 브랜드가 여럿이라 어느 출처가 누구 근거인지 모름
   *   none      = 문단에 출처가 아예 없었음
   * ⚠️ 이건 AI가 알려준 값이 아니라 엔슬의 판정이다.
   */
  citationConfidence: 'confirmed' | 'estimated' | 'none';
}

/**
 * mentions 테이블에 파싱된 브랜드 멘션들을 한 번에(bulk) 저장한다.
 * 멘션이 없으면(빈 배열) 아무것도 안 하고 조용히 끝난다.
 */
export async function saveMentions(mentions: MentionToSave[]): Promise<boolean> {
  if (mentions.length === 0) return true;

  const { error } = await supabaseAdmin.from('mentions').insert(
    mentions.map((m) => ({
      snapshot_id: m.snapshotId,
      brand_id: m.brandId,
      brand_name_raw: m.brandNameRaw,
      is_target: m.isTarget,
      rank: m.rank,
      source_urls: m.sourceUrls,
      source_domains: m.sourceDomains,
      citation_confidence: m.citationConfidence,
    }))
  );

  if (error) {
    console.error('mentions 저장 실패:', error);
    return false;
  }

  return true;
}





// ── 집계용 원시 데이터 읽어오기 (Day 9) ──

export interface SnapshotForAggregation {
  id: string;
  status: 'success' | 'failed';
  searchPerformed: boolean | null;
  executedAt: string;
  batchId: string;        // ← 추가
}

/**
 * 집계 대상 기간의 snapshots를 읽어온다.
 *
 * ⚠️ anon이 아니라 supabaseAdmin을 쓴다. AGENTS.md의 "읽기는 supabase(anon)"
 *    원칙과 다르게 보이지만, 실측 확인 결과(2026-08-17) anon 키로 snapshots를
 *    조회하면 permission denied가 난다 — 이 표는 raw_response(원시 응답, 사업
 *    데이터)를 담고 있어서 anon에 애초에 읽기 권한을 안 준 것으로 보인다.
 *    brands·queries는 anon으로 정상 조회되므로 그 두 표는 계속 anon을 쓴다.
 *
 * batchId를 주면 그 배치만, 안 주면 [periodStart, periodEnd) 구간 전체를 가져온다.
 */
export async function fetchSnapshotsForAggregation(params: {
  queryId: string;
  engine: string;
  periodStart?: string;
  periodEnd?: string;
  batchId?: string;
}): Promise<SnapshotForAggregation[]> {
  let query = supabaseAdmin
    .from('snapshots')
    .select('id, status, search_performed, executed_at, batch_id')
    .eq('query_id', params.queryId)
    .eq('engine', params.engine);

  if (params.batchId) {
    query = query.eq('batch_id', params.batchId);
  } else {
    if (params.periodStart) query = query.gte('executed_at', params.periodStart);
    if (params.periodEnd) query = query.lt('executed_at', params.periodEnd);
  }

  const { data, error } = await query;

  if (error) {
    console.error('집계용 snapshots 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    status: row.status,
    searchPerformed: row.search_performed,
    executedAt: row.executed_at,
    batchId: row.batch_id,
  }));
}

export interface MentionForAggregation {
  snapshotId: string;
  brandId: string | null;
  rank: number;
}

/**
 * 주어진 snapshot id 목록에 속한 mentions를 전부 읽어온다.
 * (브랜드별로 나누는 건 aggregator.ts에서 한다 — 이 함수는 원시 조회만 담당)
 */
export async function fetchMentionsForAggregation(
  snapshotIds: string[]
): Promise<MentionForAggregation[]> {
  if (snapshotIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('mentions')
    .select('snapshot_id, brand_id, rank')
    .in('snapshot_id', snapshotIds);

  if (error) {
    console.error('집계용 mentions 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    snapshotId: row.snapshot_id,
    brandId: row.brand_id,
    rank: row.rank,
  }));
}

// ── 이미 저장된 집계 결과 읽어오기 (Day 11 — 분석 함수 검증용) ──

export interface StoredAggregatedMetric extends AggregatedMetricToSave {
  id: string;
}

/**
 * aggregated_metrics에 이미 저장된 행들을 (periodStart, aggregationLevel) 기준으로
 * 조회한다. lib/analysis.ts의 계산 함수(computeShareOfVoice 등)는 이 형태의
 * 데이터를 받아서 쓴다.
 *
 * ⚠️ anon이 아니라 supabaseAdmin을 쓴다. Day 9에서 GRANT ALL을 service_role에만
 *    내렸고, anon이 aggregated_metrics를 읽을 수 있는지는 아직 확인 안 됐다.
 *    확인 전까지는 snapshots·mentions와 같은 취급(admin 전용)으로 둔다.
 *    나중에 대시보드가 브라우저에서 직접 읽게 하려면 이 전제를 다시 확인해야 한다.
 *
 * periodStart는 정확히 일치하는 값만 찾는다(범위 검색 아님) — daily 집계는
 * aggregateAllQueriesForDay가 그 날의 모든 행에 동일한 periodStart를 쓰므로
 * (kstDayBoundsUtc 참고) 정확히 일치시키는 게 더 안전하다.
 */
export async function fetchAggregatedMetrics(params: {
  periodStart: string;
  aggregationLevel?: 'batch' | 'daily';
}): Promise<StoredAggregatedMetric[]> {
  let query = supabaseAdmin
    .from('aggregated_metrics')
    .select(
      'id, query_id, brand_id, engine, period_start, period_end, aggregation_level, batch_id, total_runs, mention_count, visibility_rate, avg_rank, rank_stddev, competitor_data, failed_count, skipped_count, top_keywords, keyword_extraction_status, batch_count, time_slots'
    )
    .eq('period_start', params.periodStart);

  if (params.aggregationLevel) {
    query = query.eq('aggregation_level', params.aggregationLevel);
  }

  const { data, error } = await query;

  if (error) {
    console.error('aggregated_metrics 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    queryId: row.query_id,
    brandId: row.brand_id,
    engine: row.engine,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    aggregationLevel: row.aggregation_level,
    batchId: row.batch_id,
    totalRuns: row.total_runs,
    mentionCount: row.mention_count,
    visibilityRate: row.visibility_rate,
    avgRank: row.avg_rank,
    rankStddev: row.rank_stddev,
    competitorData: row.competitor_data,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    topKeywords: row.top_keywords,
    keywordExtractionStatus: row.keyword_extraction_status,
    batchCount: row.batch_count,
    timeSlots: row.time_slots,
  }));
}
  
// ── 최근 daily 집계 조회 (Day 13 — 알림 판정용) ──

export interface RecentDailyMetric {
  periodStart: string;   // ISO 문자열, KST 자정 기준 하루 시작
  totalRuns: number;
  mentionCount: number;
}

/**
 * 특정 (쿼리, 브랜드, 엔진) 조합의 최근 daily 집계를 최신순으로 가져온다.
 * lib/alerts.ts의 연속 미노출 판정(checkConsecutiveMissDays)이 쓴다.
 *
 * fetchAggregatedMetrics와 다른 점: 그쪽은 "하루 전체(모든 조합)"를 훑고,
 * 이 함수는 "한 조합의 최근 며칠"을 훑는다 — 필터링 축이 달라서 별도 함수로
 * 뺐다 (2026-08-19 판단, Day 13).
 *
 * limit을 넉넉히(기본 10) 잡는 이유: 그 사이 수집 자체가 안 돌아서 행이 없는
 * 날이 섞여 있을 수 있다. "최근 N개 행"이 실제 "최근 N일"과 다를 수 있어서,
 * 날짜 간격 판단은 호출부(checkConsecutiveMissDays)에서 하도록 넘긴다.
 */
export async function fetchRecentDailyMetrics(params: {
  queryId: string;
  brandId: string;
  engine: string;
  limit?: number;
}): Promise<RecentDailyMetric[]> {
  const { data, error } = await supabaseAdmin
    .from('aggregated_metrics')
    .select('period_start, total_runs, mention_count')
    .eq('query_id', params.queryId)
    .eq('brand_id', params.brandId)
    .eq('engine', params.engine)
    .eq('aggregation_level', 'daily')
    .order('period_start', { ascending: false })
    .limit(params.limit ?? 10);

  if (error) {
    console.error('최근 daily 집계 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    periodStart: row.period_start,
    totalRuns: row.total_runs,
    mentionCount: row.mention_count,
  }));
}
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
// ── alerts 테이블 (Day 13) ──

export interface StoredAlert {
  id: string;
  consecutivePeriods: number;
  competitorCorrelated: boolean;
}

/**
 * 같은 (query, brand, engine, alert_type) 조합의 "진행 중인"(resolved_at이 NULL인)
 * 알림을 찾는다. 있으면 갱신해야 하고, 없으면 새로 만들어야 한다 (규칙 5).
 */
export async function findOpenAlert(params: {
  queryId: string;
  brandId: string;
  engine: string;
  alertType: string;
}): Promise<StoredAlert | null> {
  const { data, error } = await supabaseAdmin
    .from('alerts')
    .select('id, consecutive_periods, competitor_correlated')
    .eq('query_id', params.queryId)
    .eq('brand_id', params.brandId)
    .eq('engine', params.engine)
    .eq('alert_type', params.alertType)
    .is('resolved_at', null)
    .maybeSingle();

  if (error) {
    console.error('진행 중인 알림 조회 실패:', error);
    return null;
  }
  if (!data) return null;

  return {
    id: data.id,
    consecutivePeriods: data.consecutive_periods,
    competitorCorrelated: data.competitor_correlated,
  };
}

/** 새 알림 1건을 만든다. is_confirmed는 항상 false로 시작한다(사람 검토 전 상태 — 2026-08-19 확인). */
export async function insertAlert(params: {
  queryId: string;
  brandId: string;
  engine: string;
  alertType: string;
  consecutivePeriods: number;
  competitorCorrelated: boolean;
  details: Record<string, unknown>;
}): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('alerts')
    .insert({
      query_id: params.queryId,
      brand_id: params.brandId,
      engine: params.engine,
      alert_type: params.alertType,
      consecutive_periods: params.consecutivePeriods,
      competitor_correlated: params.competitorCorrelated,
      is_confirmed: false,
      details: params.details,
    })
    .select('id')
    .single();

  if (error) {
    console.error('알림 생성 실패:', error);
    return null;
  }
  return data.id;
}

/** 진행 중인 알림의 연속 일수/동조 여부를 갱신한다 (새 행을 만들지 않는다). */
export async function updateAlert(
  id: string,
  params: { consecutivePeriods: number; competitorCorrelated: boolean; details: Record<string, unknown> }
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('alerts')
    .update({
      consecutive_periods: params.consecutivePeriods,
      competitor_correlated: params.competitorCorrelated,
      details: params.details,
    })
    .eq('id', id);

  if (error) {
    console.error('알림 갱신 실패:', error);
    return false;
  }
  return true;
}

/** 노출이 회복된 알림을 종료 처리한다 (규칙 5). */
export async function resolveAlert(id: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('alerts')
    .update({ resolved_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    console.error('알림 종료 처리 실패:', error);
    return false;
  }
  return true;
}


export interface SnapshotForKeywordExtraction {
  id: string;
  rawResponse: string;
}

/**
 * 키워드 추출용 스냅샷 조회 (Day 15).
 * fetchSnapshotsForAggregation과 비슷하지만, raw_response(원문)까지 가져온다는
 * 게 다르다. 노출률 집계엔 원문이 필요 없어서 원래 함수엔 안 넣었는데,
 * 키워드 추출은 원문을 다시 파싱해야 해서(A안 결정) 별도로 만든다.
 *
 * status='success'인 것만 가져온다 — 실패한 관측엔 raw_response가 없거나
 * 의미 없는 값일 수 있어서.
 */
export async function fetchSnapshotsForKeywordExtraction(params: {
  queryId: string;
  engine: string;
  periodStart: string;
  periodEnd: string;
}): Promise<SnapshotForKeywordExtraction[]> {
  const { data, error } = await supabaseAdmin
    .from('snapshots')
    .select('id, raw_response')
    .eq('query_id', params.queryId)
    .eq('engine', params.engine)
    .eq('status', 'success')
    .gte('executed_at', params.periodStart)
    .lt('executed_at', params.periodEnd);

  if (error) {
    console.error('키워드 추출용 snapshots 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    rawResponse: row.raw_response,
  }));
}

// lib/supabase.ts

// ── AggregatedMetricToSave에 키워드 필드 추가 ──
export interface AggregatedMetricToSave {
  queryId: string;
  brandId: string;
  engine: string;
  periodStart: string;
  periodEnd: string;
  aggregationLevel: 'batch' | 'daily';
  batchId: string | null;
  totalRuns: number;
  mentionCount: number;
  visibilityRate: number | null;
  avgRank: number | null;
  rankStddev: number | null;
  competitorData: Record<string, { name: string; mentionCount: number; visibilityRate: number | null; avgRank: number | null }> | null;
  failedCount: number;
  skippedCount: number;
    /**
   * 그 기간에 실제로 실행된 서로 다른 batch 개수, 그리고 그 배치들이 걸친 시간대.
   * batchCount와 timeSlots 길이가 다를 수 있다 — 같은 시간대에 배치가 두 번
   * 돈 날(2026-08-19: 17:35, 18:02 둘 다 저녁)이 실제로 있었다.
   * 헤더에 "3회 관측"처럼 고정 텍스트로 주장하지 않기 위해 저장한다 (Day 17).
   */
  batchCount: number;
  timeSlots: string[];

  /**
   * 노출 키워드 (Day 15 — collector 파이프라인 실연결).
   * null = 이 기간에 타겟 브랜드가 언급 안 됨(추출 시도 자체를 안 함).
   * [] = 언급은 됐는데 LLM이 뽑은 설명 표현이 없었음.
   * [...] = 실제로 뽑힌 표현들.
   * keywordExtractionStatus가 null이면 이 필드도 항상 null이어야 한다(둘이 쌍으로 움직임).
   */
  topKeywords: { keyword: string; count: number }[] | null;

  /**
   * null = 추출을 시도할 필요 없음(언급 안 됨).
   * 'success' = 시도했고 성공(표현이 있든 없든).
   * 'failed' = 시도했으나 재시도까지 다 실패 — 다음 aggregate-daily 실행 때 재시도 대상.
   */
  keywordExtractionStatus: 'success' | 'failed' | null;
}

export async function saveAggregatedMetric(m: AggregatedMetricToSave): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('aggregated_metrics')
    .upsert(
      {
        query_id: m.queryId,
        brand_id: m.brandId,
        engine: m.engine,
        period_start: m.periodStart,
        period_end: m.periodEnd,
        aggregation_level: m.aggregationLevel,
        batch_id: m.batchId,
        total_runs: m.totalRuns,
        mention_count: m.mentionCount,
        visibility_rate: m.visibilityRate,
        avg_rank: m.avgRank,
        rank_stddev: m.rankStddev,
        competitor_data: m.competitorData,
        failed_count: m.failedCount,
        skipped_count: m.skippedCount,
        top_keywords: m.topKeywords,
        keyword_extraction_status: m.keywordExtractionStatus,
        batch_count: m.batchCount,
        time_slots: m.timeSlots,
      },
      { onConflict: 'query_id,brand_id,engine,aggregation_level,period_start' }
    )
    .select('id')
    .single();

  if (error) {
    console.error('aggregated_metrics 저장 실패:', error);
    return null;
  }

  return data.id;
}

// ── 키워드 추출 실패건 조회 (Day 15) ──

export interface FailedKeywordRow {
  id: string;
  queryId: string;
  brandId: string;
  engine: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * status='failed'인 행들을 가져온다. limit을 두는 이유: 브랜드가 늘어서
 * 실패건이 쌓이더라도, 재시도에 쓰는 시간이 그날의 본 집계 시간을 잠식하지
 * 않도록 상한을 둔다(부채 트래커에 남긴 "브랜드 늘면 300초 재계산 필요"와
 * 같은 맥락 — 지금은 20이면 충분히 여유 있음).
 */
export async function fetchFailedKeywordExtractionRows(limit = 20): Promise<FailedKeywordRow[]> {
  const { data, error } = await supabaseAdmin
    .from('aggregated_metrics')
    .select('id, query_id, brand_id, engine, period_start, period_end')
    .eq('keyword_extraction_status', 'failed')
    .limit(limit);

  if (error) {
    console.error('키워드 추출 실패건 조회 실패:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    queryId: row.query_id,
    brandId: row.brand_id,
    engine: row.engine,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  }));
}

// ── 키워드 필드만 부분 업데이트 (Day 15) ──
// saveAggregatedMetric(upsert)을 재사용하지 않는 이유: 그러면 노출률·순위 등
// 이미 확정된 값을 재계산해서 같이 덮어써야 한다. 재시도는 키워드 두 컬럼만
// 고치면 되므로, id 하나로 그 두 컬럼만 건드리는 가벼운 함수로 분리한다.
export async function updateKeywordExtractionResult(
  id: string,
  topKeywords: { keyword: string; count: number }[] | null,
  status: 'success' | 'failed'
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('aggregated_metrics')
    .update({
      top_keywords: topKeywords,
      keyword_extraction_status: status,
    })
    .eq('id', id);

  if (error) {
    console.error('키워드 추출 결과 업데이트 실패:', error);
    return false;
  }

  return true;
}
export async function fetchTargetBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('id, name')
    .eq('is_target', true)
    .order('name');

  if (error) {
    console.error('fetchTargetBrands error:', error);
    return [];
  }

  return data;
}
export type DashboardMetric = {
  queryId: string;
  engine: string;
  visibilityRate: number | null;
  avgRank: number | null;
  totalRuns: number;
  mentionCount: number;
  topKeywords: { keyword: string; count: number }[] | null;
  periodStart: string;
};

export async function fetchLatestDashboardMetrics(brandId: string): Promise<DashboardMetric[]> {
  const { data: latest, error: latestError } = await supabaseAdmin
    .from('aggregated_metrics')
    .select('period_start')
    .eq('brand_id', brandId)
    .eq('aggregation_level', 'daily')
    .order('period_start', { ascending: false })
    .limit(1);

  if (latestError || !latest || latest.length === 0) {
    if (latestError) console.error('최신 집계일 조회 실패:', latestError);
    return [];
  }

  const latestPeriod = latest[0].period_start;

  const { data, error } = await supabaseAdmin
    .from('aggregated_metrics')
    .select('query_id, engine, visibility_rate, avg_rank, total_runs, mention_count, top_keywords, period_start')
    .eq('brand_id', brandId)
    .eq('aggregation_level', 'daily')
    .eq('period_start', latestPeriod);

  if (error) {
    console.error('대시보드 집계 조회 실패:', error);
    return [];
  }

  return data.map((row) => ({
    queryId: row.query_id,
    engine: row.engine,
    visibilityRate: row.visibility_rate,
    avgRank: row.avg_rank,
    totalRuns: row.total_runs,
    mentionCount: row.mention_count,
    topKeywords: row.top_keywords,
    periodStart: row.period_start,
  }));
}