// lib/supabase.ts
// Supabase 클라이언트 — 프로젝트 전체에서 이 파일 하나만 import해서 사용

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

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

/**
 * 로그인 세션을 인식하는 요청 단위 클라이언트 (Day 19).
 *
 * 위 `supabase`(anon)와 다른 점: 이 클라이언트는 브라우저가 보낸 쿠키에서
 * 로그인 세션을 읽어와서 요청을 보낸다. RLS 정책(`is_account_member` 등)이
 * `auth.uid()`를 판단하려면 "누가 요청했는지"가 필요한데, 고정된 `supabase`
 * 싱글턴에는 그 정보가 없다 — 항상 auth.uid()가 null로 평가돼서 로그인
 * 여부와 무관하게 RLS에 막힌다.
 *
 * ⚠️ Server Component에서는 쿠키를 쓸 수 없어서(setAll이 조용히 실패)
 *    세션 토큰 자동 갱신이 여기서는 안 먹는다 — 토큰 갱신은 proxy.ts가
 *    모든 요청에서 먼저 처리한다. 이 함수는 Server Component/Server
 *    Action/Route Handler 어디서 불러도 되지만, 매 요청마다 새로 만들어야
 *    한다(다른 사용자 요청과 클라이언트를 공유하면 세션이 섞인다).
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Server Component 렌더링 중에는 쿠키를 못 쓴다 — proxy.ts가 대신 처리하므로 무시해도 안전.
        }
      },
    },
  });
}

// ── 현재 로그인한 사용자의 워크스페이스(계정) 조회 (Day 19) ──

export interface CurrentAccount {
  id: string;
  name: string;
  /** account_members.role — owner/admin/editor/viewer (Day 20, 브랜드 한 줄 role 게이팅용) */
  role: 'owner' | 'admin' | 'editor' | 'viewer';
}

/**
 * 로그인 세션에서 현재 사용자를 확인하고, 그 사용자가 속한(status='active')
 * 워크스페이스를 반환한다. 로그인 안 했거나 아직 어느 워크스페이스에도
 * 속하지 않았으면(예: 방금 로그인만 하고 계정 시딩 전) null.
 *
 * 지금은 사용자당 워크스페이스가 항상 1개뿐이라 첫 번째 것만 반환한다 —
 * 여러 워크스페이스에 속하는 사용자가 생기면 이 함수가 선택 로직의
 * 확장 지점이 된다(작업지시서 4-3 원안 그대로).
 *
 * client를 안 넘기면 이 함수가 직접 세션 클라이언트를 만든다. 같은
 * 요청 안에서 fetchTargetBrands처럼 세션 클라이언트가 또 필요한 호출이
 * 있으면, 호출부에서 하나 만들어서 같이 넘기는 쪽이 쿠키 파싱을
 * 중복하지 않아 더 낫다.
 */
export async function fetchCurrentAccount(
  client?: SupabaseClient
): Promise<CurrentAccount | null> {
  const sessionClient = client ?? (await createServerSupabaseClient());

  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user) return null;

  const { data, error } = await sessionClient
    .from('account_members')
    .select('role, accounts(id, name)')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('현재 계정 조회 실패:', error);
    return null;
  }
  if (!data?.accounts) return null;

  // supabase-js는 조인 결과를 배열로 줄 수도, 객체로 줄 수도 있어서 방어적으로 처리한다.
  const account = Array.isArray(data.accounts) ? data.accounts[0] : data.accounts;
  if (!account) return null;

  return { id: account.id, name: account.name, role: data.role };
}

// ── DB에서 브랜드 목록 가져오기 ──

import type { KnownBrand } from './parser';

/**
 * Supabase brands 테이블에서 브랜드 목록을 읽어온다.
 * parser.ts의 KNOWN_BRANDS 하드코딩을 대체하는 함수.
 *
 * 왜 async(비동기)인가:
 *   DB 조회는 네트워크를 타야 하니까 시간이 걸린다.
 *   "주문하고 기다렸다가 받는" 구조라서 await를 써야 한다.
 *
 * ⚠️ anon이 아니라 supabaseAdmin을 쓴다 (Day 19, 계정 격리 RLS 도입 후 수정).
 *    이 함수는 lib/collector.ts·aggregator.ts·alerts.ts가 cron으로 도는
 *    수집/집계/알림 파이프라인 전체에서 쓴다 — 로그인한 사용자 세션이
 *    아니라 서버가 혼자 도는 배치 작업이라 anon 키로는 auth.uid()가 항상
 *    null이다. RLS가 계정 소속만 허용하도록 걸리면(day19-step7 SQL 이후)
 *    anon으로는 브랜드를 하나도 못 읽어와서 브랜드 매칭 자체가 멈춘다.
 *    fetchSnapshotsForAggregation과 같은 이유(Day 17 결정)로 admin을 쓴다.
 */
export async function fetchKnownBrands(): Promise<KnownBrand[]> {
  const { data, error } = await supabaseAdmin
    .from('brands')
    .select('id, name, aliases, is_target, domain');

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
    domain: row.domain || null,
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

  /**
   * '인지' | '자리' | null (Day 20 이전에 만들어진 뒤 확정 12개 세트에
   * 안 들어가서 비활성화된 옛 쿼리는 null).
   * (2026-09-01, 브랜드 한 줄 로직 추가) — aggregator.ts가 "이 쿼리가
   * 인지 질문인가"를 판단해서 표현 추출을 붙일지 결정하는 데 쓴다.
   */
  queryType: string | null;
}

/**
 * Supabase queries 테이블에서 활성화된(is_active=true) 쿼리 목록을 읽어온다.
 * 하드코딩된 testQuery 문자열을 대체하는 함수.
 *
 * ⚠️ anon이 아니라 supabaseAdmin을 쓴다 — fetchKnownBrands와 같은 이유
 *    (Day 19). 이 함수도 수집/집계/알림 파이프라인이 세션 없이 호출한다.
 *
 * queryTypes를 주면(Day 20 — 인지/자리 이원화 수집) 그 타입만 걸러서
 * 가져온다. 안 주면 필터 없이 전부 가져온다 — aggregator.ts·alerts.ts는
 * 타입 구분 없이 전체를 집계/점검해야 하므로 필터를 안 넘기고 그대로
 * 호출한다. lib/collector.ts만 이 필터를 실제로 쓴다.
 */
export async function fetchActiveQueries(queryTypes?: string[]): Promise<StoredQuery[]> {
  let query = supabaseAdmin
    .from('queries')
    .select('id, query_text, intent, brand_id, query_type')
    .eq('is_active', true);

  if (queryTypes && queryTypes.length > 0) {
    query = query.in('query_type', queryTypes);
  }

  const { data, error } = await query;

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
    queryType: row.query_type,
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
  batchId: string;        
  retrievedSources: RetrievedSource[] | null;   
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
    .select('id, status, search_performed, executed_at, batch_id,retrieved_sources')
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
    retrievedSources: row.retrieved_sources,   
  }));
}

export interface MentionForAggregation {
  snapshotId: string;
  brandId: string | null;
  rank: number;
  sourceDomains: string[] | null;   
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
    .select('snapshot_id, brand_id, rank, source_domains')
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
    sourceDomains: row.source_domains,
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
      'id, query_id, brand_id, engine, period_start, period_end, aggregation_level, batch_id, total_runs, mention_count, visibility_rate, avg_rank, rank_stddev, competitor_data, failed_count, skipped_count, top_keywords, keyword_extraction_status, batch_count, time_slots, has_source, has_citation'
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
    hasSource: row.has_source,
    hasCitation: row.has_citation,
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

  /**
   * S(소스)/C(인용) 판정 — Day 17.x, M/S/C 뱃지용.
   * hasSource: true=자기 도메인이 참고 목록에 있었음 / false=참고 목록은 있는데 없었음 /
   *            null=이 엔진이 참고 목록 자체를 안 줌(확인 불가, 예: ChatGPT)
   * hasCitation: true=자기 도메인이 실제 각주로 인용됨 / false=인용 안 됨
   *              (retrievedSources 유무와 무관하게 항상 true/false로 판정 가능)
   */
  hasSource: boolean | null;
  hasCitation: boolean;

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
        has_source: m.hasSource,       // ← 추가
        has_citation: m.hasCitation,   // ← 추가
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
/**
 * is_target=true인 브랜드 목록을 이름순으로 가져온다.
 *
 * accountId를 주면(Day 19 — 로그인한 워크스페이스 기준) 그 워크스페이스
 * 소속 브랜드만 필터링한다. 안 주면 필터 없이 예전 그대로 동작한다 —
 * `/`(기존 데모 홈페이지)는 로그인을 안 하는 페이지라 accountId를 못
 * 구하므로, 이 함수를 그대로 anon 키로 계속 호출한다(2026-08-31: RLS가
 * 켜지면 `/`는 브랜드가 하나도 안 보이게 되는데, 이건 알고 있는 상태로
 * 방치하기로 결정됨 — 곧 새 대시보드로 대체될 임시 화면이라 손 안 댐).
 *
 * ⚠️ client를 안 넘기면 anon 키를 쓴다. accountId를 넘길 거면(로그인한
 * 화면에서 호출할 거면) createServerSupabaseClient()로 만든 세션 인식
 * 클라이언트도 같이 넘겨야 한다 — 실측으로 확인된 함정(2026-08-31):
 * anon 키는 로그인 여부와 무관하게 auth.uid()가 항상 null이라, RLS가
 * "계정 소속만" 정책 하나만 남은 상태에서는 accountId로 필터링해도
 * anon 클라이언트로는 아예 0건이 나온다(day19-step7 SQL로 예전 "누구나
 * 읽기" 정책을 지운 뒤 (dashboard) 사이드바가 빈 화면으로 나온 원인).
 */
export async function fetchTargetBrands(accountId?: string, client: SupabaseClient = supabase) {
  let query = client
    .from('brands')
    .select('id, name')
    .eq('is_target', true)
    .order('name');

  if (accountId) {
    query = query.eq('account_id', accountId);
  }

  const { data, error } = await query;

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
  hasSource: boolean | null;   
  hasCitation: boolean | null; 
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
    .select('query_id, engine, visibility_rate, avg_rank, total_runs, mention_count, top_keywords, period_start, has_source, has_citation')
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
    hasSource: row.has_source,       // ← 추가
    hasCitation: row.has_citation,   // ← 추가
  }));
}

// ══════════════════════════════════════════════════════════
// 브랜드 한 줄 생성 로직 (2026-09-01, 작업지시서_브랜드한줄로직_v1.1.md)
// ══════════════════════════════════════════════════════════

// ── 진단 회차 (diagnoses) ──

export interface StoredDiagnosis {
  id: string;
  brandId: string;
  startedAt: string; // 'YYYY-MM-DD'
  endedAt: string | null;
  status: 'collecting' | 'completed';
}

/** 이 브랜드의 진행 중인(collecting) 진단 회차를 가져온다. 없으면 null. */
export async function fetchOpenDiagnosis(brandId: string): Promise<StoredDiagnosis | null> {
  const { data, error } = await supabaseAdmin
    .from('diagnoses')
    .select('id, brand_id, started_at, ended_at, status')
    .eq('brand_id', brandId)
    .eq('status', 'collecting')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('진행 중인 진단 조회 실패:', error);
    return null;
  }
  if (!data) return null;

  return {
    id: data.id,
    brandId: data.brand_id,
    startedAt: data.started_at,
    endedAt: data.ended_at,
    status: data.status,
  };
}

/**
 * status='collecting'인 진단 중, dateKST 기준으로 시작일 포함 minDays일이
 * 이미 다 채워진 것들을 찾는다. 매일 밤 집계 크론이 그날(dateKST) 집계를
 * 끝낸 직후 이 함수로 "오늘 종료 처리할 진단이 있는지"를 확인한다
 * (2026-09-01 확정 — 별도 트리거 없이 야간 크론에 편입).
 *
 * ⚠️ dateKST는 실행 시각의 "오늘"이 아니라 aggregateAllQueriesForDay가
 * 방금 집계한 날짜다(보통 어제 — yesterdayKST()). started_at이 9/1이고
 * minDays=7이면, 9/1~9/7 7일치가 다 채워진 시점인 dateKST=9/7에 만료로
 * 잡혀야 한다 — startedAt + (minDays-1)일을 커트라인으로 계산한다
 * (minDays를 그대로 빼면 하루 늦게(9/8) 잡히는 버그가 됨, 실제로 걸림).
 */
export async function fetchExpiredDiagnoses(
  dateKST: string,
  minDays = 7
): Promise<StoredDiagnosis[]> {
  // ⚠️ 'Z'(UTC)로 파싱해야 한다. '+09:00'로 만들면 이 Date의 UTC 캘린더
  // 날짜가 하루 전으로 밀려서(KST 자정 = UTC 전날 15시), 뒤이은
  // setUTCDate/getUTCDate 계산이 하루씩 어긋난다 — 실제로 이 버그로
  // 만료 판정이 하루 늦게(9/7이 아니라 9/8에) 걸리는 걸 확인하고 고쳤다
  // (2026-09-01). 여기서는 실제 타임존 변환이 필요 없고 "달력 날짜"끼리의
  // 순수한 덧뺄셈만 하면 되므로, 처음부터 UTC로 취급하는 게 맞다.
  const cutoff = new Date(`${dateKST}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (minDays - 1));
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin
    .from('diagnoses')
    .select('id, brand_id, started_at, ended_at, status')
    .eq('status', 'collecting')
    .lte('started_at', cutoffDate);

  if (error) {
    console.error('만료된 진단 조회 실패:', error);
    return [];
  }
  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    brandId: row.brand_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
  }));
}

/** 진단을 종료 처리한다 (collecting → completed). */
export async function completeDiagnosis(diagnosisId: string, endedAt: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('diagnoses')
    .update({ status: 'completed', ended_at: endedAt })
    .eq('id', diagnosisId);

  if (error) {
    console.error('진단 종료 처리 실패:', error);
    return false;
  }
  return true;
}

// ── 브랜드 사실 정보 ──

/** brands.brand_facts를 읽어온다. 없으면 null(충돌판정은 건너뛴다는 신호). */
export async function fetchBrandFacts(brandId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('brands')
    .select('brand_facts')
    .eq('id', brandId)
    .maybeSingle();

  if (error) {
    console.error('brand_facts 조회 실패:', error);
    return null;
  }
  return data?.brand_facts ?? null;
}

// ── 추출된 개별 표현 (brand_expressions) ──

export interface BrandExpressionToSave {
  snapshotId: string;
  queryId: string;
  brandId: string;
  engine: string;
  observedDate: string; // 'YYYY-MM-DD', KST 기준
  expression: string;
  sourceSentence: string;
  sentiment: '긍정' | '중립' | '부정' | null;
  isInduced: boolean;
  conflictsWithBrandFacts: boolean;
}

export async function saveBrandExpressions(expressions: BrandExpressionToSave[]): Promise<boolean> {
  if (expressions.length === 0) return true;

  const { error } = await supabaseAdmin.from('brand_expressions').insert(
    expressions.map((e) => ({
      snapshot_id: e.snapshotId,
      query_id: e.queryId,
      brand_id: e.brandId,
      engine: e.engine,
      observed_date: e.observedDate,
      expression: e.expression,
      source_sentence: e.sourceSentence,
      sentiment: e.sentiment,
      is_induced: e.isInduced,
      conflicts_with_brand_facts: e.conflictsWithBrandFacts,
    }))
  );

  if (error) {
    console.error('brand_expressions 저장 실패:', error);
    return false;
  }
  return true;
}

export interface StoredBrandExpression {
  id: string;
  snapshotId: string;
  queryId: string;
  brandId: string;
  engine: string;
  observedDate: string;
  expression: string;
  sourceSentence: string;
  sentiment: '긍정' | '중립' | '부정' | null;
  isInduced: boolean;
  conflictsWithBrandFacts: boolean;
}

/** 진단 기간(관측일 기준, 양끝 포함) 동안 쌓인 brand_expressions 전부를 가져온다. */
export async function fetchBrandExpressionsForBrand(
  brandId: string,
  periodStartDate: string,
  periodEndDate: string
): Promise<StoredBrandExpression[]> {
  const { data, error } = await supabaseAdmin
    .from('brand_expressions')
    .select(
      'id, snapshot_id, query_id, brand_id, engine, observed_date, expression, source_sentence, sentiment, is_induced, conflicts_with_brand_facts'
    )
    .eq('brand_id', brandId)
    .gte('observed_date', periodStartDate)
    .lte('observed_date', periodEndDate);

  if (error) {
    console.error('brand_expressions 조회 실패:', error);
    return [];
  }
  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    snapshotId: row.snapshot_id,
    queryId: row.query_id,
    brandId: row.brand_id,
    engine: row.engine,
    observedDate: row.observed_date,
    expression: row.expression,
    sourceSentence: row.source_sentence,
    sentiment: row.sentiment,
    isInduced: row.is_induced,
    conflictsWithBrandFacts: row.conflicts_with_brand_facts,
  }));
}

/**
 * 주어진 쿼리들에 대해, 기간 안에 유효 응답(status='success')을 1번이라도
 * 낸 적 있는 엔진 목록을 돌려준다. v1.1 ④ — 강도 계산(AI 범위)의 분모.
 * ⚠️ 최소기준 필터(5번, "AI 3개 이상")에는 안 쓴다 — 그건 절대값 고정으로
 * 확정됨(2026-09-01, 9/7~8 첫 진단 종료 후 재검토 예정).
 */
export async function fetchValidEnginesForQueriesInPeriod(
  queryIds: string[],
  periodStartUtc: string,
  periodEndUtc: string
): Promise<string[]> {
  if (queryIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('snapshots')
    .select('engine')
    .in('query_id', queryIds)
    .eq('status', 'success')
    .gte('executed_at', periodStartUtc)
    .lt('executed_at', periodEndUtc);

  if (error) {
    console.error('유효 엔진 목록 조회 실패:', error);
    return [];
  }
  if (!data) return [];

  return Array.from(new Set(data.map((row) => row.engine)));
}

// ── 특징 후보 (brand_feature_candidates, v1.2 결정 1) ──

/**
 * ⚠️ 값 철자가 정확히 DB CHECK 제약과 같아야 한다 — '지역_조건'은 언더스코어
 * 있음, '일반적표현'은 없음(작업지시서 v1.2 원문 그대로, 일관성 없어 보여도
 * 스키마와 정확히 맞춰야 insert가 안 막힌다).
 */
export type FeatureCategory =
  | '치료분야'
  | '진료체계'
  | '의료역량'
  | '환자상황'
  | '이용편의성'
  | '지역_조건'
  | '일반적표현';

/**
 * 3개 조건(질문 2+/AI 3+/날짜 3+)을 각각 독립 판정한 뒤 몇 개를 충족했는지로
 * 정해진다(v1.2 결정 1) — 하나만 보고 판단하지 않음.
 *   3개 전부 → 확정(=반복확인됨) / 2개 → 가능성있음 / 0~1개 → 관찰중
 */
export type FeatureTier = '확정' | '가능성있음' | '관찰중';

export interface BrandFeatureCandidateToSave {
  diagnosisId: string;
  brandId: string;
  featureName: string;
  category: FeatureCategory;
  questionCount: number;
  questionTotal: number;
  engineCount: number;
  engineTotal: number; // v1.1 ④ 동적 분모(유효 관측 엔진 수)
  dayCount: number;
  dayTotal: number;
  passedMinCriteria: boolean;
  tier: FeatureTier;
  intensityScore: number; // 정렬용, 화면 비노출
  evidenceExpressionIds: string[];
}

/**
 * 여러 건을 한 INSERT로 저장하고 생성된 id를 같은 순서로 돌려준다.
 * ⚠️ 호출부(lib/brand-one-liner.ts)가 이 반환 배열의 순서가 입력 배열
 * 순서와 같다고 가정한다 — 단일 INSERT 문의 RETURNING은 실제로 입력 순서를
 * 보존하지만, 방어적으로 개수가 안 맞으면 에러 로그를 남긴다.
 */
export async function saveBrandFeatureCandidates(
  candidates: BrandFeatureCandidateToSave[]
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('brand_feature_candidates')
    .insert(
      candidates.map((c) => ({
        diagnosis_id: c.diagnosisId,
        brand_id: c.brandId,
        feature_name: c.featureName,
        category: c.category,
        question_count: c.questionCount,
        question_total: c.questionTotal,
        engine_count: c.engineCount,
        engine_total: c.engineTotal,
        day_count: c.dayCount,
        day_total: c.dayTotal,
        passed_min_criteria: c.passedMinCriteria,
        tier: c.tier,
        intensity_score: c.intensityScore,
        evidence_expression_ids: c.evidenceExpressionIds,
      }))
    )
    .select('id');

  if (error) {
    console.error('brand_feature_candidates 저장 실패:', error);
    return [];
  }
  if (data.length !== candidates.length) {
    console.error(
      `brand_feature_candidates 저장 개수 불일치: 입력 ${candidates.length}건, 반환 ${data.length}건`
    );
  }
  return data.map((row) => row.id);
}

export interface StoredBrandFeatureCandidate {
  id: string;
  diagnosisId: string;
  brandId: string;
  featureName: string;
  category: FeatureCategory;
  questionCount: number;
  questionTotal: number;
  engineCount: number;
  engineTotal: number;
  dayCount: number;
  dayTotal: number;
  passedMinCriteria: boolean;
  tier: FeatureTier | null;
  evidenceExpressionIds: string[];
}

/** 화면의 "특징 목록"(전체 후보, tier 배지용, v1.2 결정 1)이 쓴다. */
export async function fetchBrandFeatureCandidatesForDiagnosis(
  diagnosisId: string,
  client: SupabaseClient
): Promise<StoredBrandFeatureCandidate[]> {
  const { data, error } = await client
    .from('brand_feature_candidates')
    .select(
      'id, diagnosis_id, brand_id, feature_name, category, question_count, question_total, engine_count, engine_total, day_count, day_total, passed_min_criteria, tier, evidence_expression_ids'
    )
    .eq('diagnosis_id', diagnosisId);

  if (error) {
    console.error('brand_feature_candidates 조회 실패:', error);
    return [];
  }
  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    diagnosisId: row.diagnosis_id,
    brandId: row.brand_id,
    featureName: row.feature_name,
    category: row.category,
    questionCount: row.question_count,
    questionTotal: row.question_total,
    engineCount: row.engine_count,
    engineTotal: row.engine_total,
    dayCount: row.day_count,
    dayTotal: row.day_total,
    passedMinCriteria: row.passed_min_criteria,
    tier: row.tier,
    evidenceExpressionIds: row.evidence_expression_ids,
  }));
}

// ── 생성된 브랜드 한 줄 (brand_one_liners) ──

/**
 * 자동검수 재시도 과정을 남기는 디버깅용 로그(2026-09-01, 루아 제안).
 * 화면엔 안 보여주고 "왜 이 한 줄은 근거가 약하지?"를 나중에 추적하는 용도.
 * jsonb인 이유: 검수 로직이 정교해지면(예: 제외 사유까지) 컬럼 스키마
 * 안 바꾸고 필드만 늘릴 수 있게.
 */
export interface GenerationLog {
  originalFeatureCount: number;
  retryCount: number;
  excludedByReview: string[]; // 검수에서 걸려서 빠진 특징 label 목록
}

/**
 * ⚠️ oneLiner는 반드시 status와 같이 봐야 한다(2026-09-01, 루아 지적).
 * DB 컬럼에도 같은 내용의 COMMENT ON COLUMN을 걸어뒀다
 * (docs/day-brandoneliner-column-comment.sql).
 *   - '반복확인': 완성된 브랜드 한 줄 — 화면에 확정형으로 인용해도 됨
 *   - '초기한줄': lib/brand-one-liner.ts가 원안 9번 문구를 코드로 조합한
 *     것 — 완성된 "브랜드 한 줄"이 아니다. 확정형처럼 인용하지 말 것
 *     (Day22/23에서 이 필드를 다시 쓸 때 특히 주의)
 *   - '근거부족'·'잘못된인지'는 각각 null / 별도 정의된 경고 문구
 */
export interface BrandOneLinerToSave {
  diagnosisId: string;
  brandId: string;
  status: '반복확인' | '초기한줄' | '근거부족' | '잘못된인지';
  oneLiner: string | null; // 근거부족이면 null — 위 주석 참고
  /**
   * brand_feature_candidates.id 목록, 최대 3개, category≠'지역_조건'
   * (v1.2 결정 2). '잘못된인지' 행은 여기에 충돌 후보 id 1개만 넣는다 —
   * brand_feature_candidates 자체에 충돌 여부 컬럼이 없어서, 일반 특징
   * 목록에서 이 행을 빼는 건 화면(BrandOneLinerView)이 "잘못된인지 행의
   * selectedFeatureIds에 들어있으면 일반 목록에서 제외"로 처리한다.
   */
  selectedFeatureIds: string[] | null;
  /** brand_feature_candidates.id, category='지역_조건'인 것 중 1개(v1.2 결정 3). */
  locationContextId: string | null;
  questionIds: string[];
  engineList: string[];
  generationLog?: GenerationLog | null;
}

export async function saveBrandOneLiner(input: BrandOneLinerToSave): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('brand_one_liners')
    .insert({
      diagnosis_id: input.diagnosisId,
      brand_id: input.brandId,
      status: input.status,
      one_liner: input.oneLiner,
      selected_feature_ids: input.selectedFeatureIds,
      location_context_id: input.locationContextId,
      question_ids: input.questionIds,
      engine_list: input.engineList,
      logic_version: 'v1.2',
      reviewed_by_human: false, // MVP: 루아가 Supabase 대시보드에서 직접 true로 변경
      generation_log: input.generationLog
        ? {
            original_feature_count: input.generationLog.originalFeatureCount,
            retry_count: input.generationLog.retryCount,
            excluded_by_review: input.generationLog.excludedByReview,
          }
        : null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('brand_one_liners 저장 실패:', error);
    return null;
  }
  return data.id;
}

// ── 화면용 조회: 브랜드 한 줄 최신 상태 (Day 20, 브랜드 인지 화면) ──

/** diagnoses.id로 특정 진단 회차 하나를 가져온다. */
export async function fetchDiagnosisById(
  diagnosisId: string,
  client: SupabaseClient
): Promise<StoredDiagnosis | null> {
  const { data, error } = await client
    .from('diagnoses')
    .select('id, brand_id, started_at, ended_at, status')
    .eq('id', diagnosisId)
    .maybeSingle();

  if (error) {
    console.error('진단 조회 실패:', error);
    return null;
  }
  if (!data) return null;

  return {
    id: data.id,
    brandId: data.brand_id,
    startedAt: data.started_at,
    endedAt: data.ended_at,
    status: data.status,
  };
}

/** 이 브랜드의 가장 최근 진단 회차(상태 무관)를 가져온다. */
export async function fetchLatestDiagnosis(
  brandId: string,
  client: SupabaseClient
): Promise<StoredDiagnosis | null> {
  const { data, error } = await client
    .from('diagnoses')
    .select('id, brand_id, started_at, ended_at, status')
    .eq('brand_id', brandId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('최신 진단 조회 실패:', error);
    return null;
  }
  if (!data) return null;

  return {
    id: data.id,
    brandId: data.brand_id,
    startedAt: data.started_at,
    endedAt: data.ended_at,
    status: data.status,
  };
}

/**
 * 오늘(KST) 기준으로 진단이 시작된 지 며칠째인지. 시작일을 1일째로 센다.
 * ⚠️ fetchExpiredDiagnoses에서 잡았던 것과 같은 종류의 timezone 함정을
 * 피하려고, 여기서도 전부 'Z'(UTC 취급)로 파싱한다 — '+09:00'로 만든
 * Date에 UTC 메서드를 섞어 쓰면 날짜가 하루 밀린다.
 */
function daysElapsedSince(startedAt: string): number {
  const start = new Date(`${startedAt}T00:00:00Z`);
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const nowKstDateStr = nowKst.toISOString().slice(0, 10);
  const now = new Date(`${nowKstDateStr}T00:00:00Z`);
  const diffDays = Math.round((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(diffDays + 1, 1);
}

interface StoredBrandOneLinerRow {
  id: string;
  diagnosisId: string;
  status: '반복확인' | '초기한줄' | '근거부족' | '잘못된인지';
  oneLiner: string | null;
  selectedFeatureIds: string[] | null;
  locationContextId: string | null;
  questionIds: string[];
  engineList: string[];
  reviewedByHuman: boolean;
}

export interface BrandOneLinerConflict {
  oneLiner: string;
  /** brand_feature_candidates.id 목록 — 화면이 일반 특징 목록에서 이걸
   *  제외해야 한다(v1.2, "잘못된인지"는 일반 목록에 안 섞임). */
  featureCandidateIds: string[];
}

export type BrandOneLinerMain =
  | { state: '진단중'; daysElapsed: number | null }
  | {
      state: '완료';
      diagnosis: { id: string; startedAt: string; endedAt: string | null };
      status: '반복확인' | '초기한줄' | '근거부족';
      /** ⚠️ status와 같이 봐야 함 — '초기한줄'일 때는 확정된 브랜드 한 줄이
       *  아니다(BrandOneLinerToSave 위 주석 참고). 그대로 표시는 해도 되지만
       *  "완성된 한 줄"인 것처럼 다른 곳에 재인용하지 말 것. */
      oneLiner: string | null;
      /** brand_feature_candidates.id 목록(최대 3, category≠'지역_조건').
       *  실제 특징 데이터는 fetchBrandFeatureCandidatesForDiagnosis로
       *  diagnosis.id 기준 한 번에 불러와서 이 id들로 매칭한다(v1.2). */
      selectedFeatureIds: string[];
      locationContextId: string | null;
      /** owner/admin에게만 의미 있는 플래그 — editor/viewer는 이 값이 false인
       *  콘텐츠 자체를 절대 못 받으므로(항상 '진단중'으로 폴백), 여기까지
       *  왔다는 건 owner/admin이거나 이미 검토된 콘텐츠라는 뜻. */
      reviewed: boolean;
      questionIds: string[];
      engineList: string[];
    };

export interface BrandOneLinerView {
  main: BrandOneLinerMain;
  /** "잘못된 인지" — 본문(main)과 별개 채널. main이 '진단중'으로 가려진
   *  상태에서도, 이 conflicting 자체가 검토·role 조건을 통과했으면 노출될
   *  수 있다(작업지시서: "위 상태와 별개로... 노출 조건은 본문과 동일 적용"
   *  — "본문과 동일한 규칙을 독립적으로 적용"으로 해석함). */
  conflicting: BrandOneLinerConflict | null;
}

/**
 * 브랜드 인지 화면(Day 20)이 쓰는 단일 진입점.
 *
 * viewerRole이 'editor'|'viewer'면 reviewed_by_human=false인 콘텐츠는
 * 존재 자체를 숨긴다(그런 콘텐츠가 있다는 사실도 안 알려준다 — "검토
 * 대기 배지"조차 안 보여주고 그냥 '진단중'과 구분 안 되게 만든다).
 * owner/admin은 검토 여부와 무관하게 항상 다 보고, reviewed 플래그로
 * "아직 검토 전"임을 알 수 있다.
 *
 * diagnosisId를 주면 "최신 진단"이 아니라 그 특정 진단을 조회한다 —
 * Day23(변화 추이)에서 과거 회차를 순회할 때 이 함수를 그대로 재사용하기
 * 위한 확장 지점(작업지시서 3-1 설계 원칙).
 */
export async function fetchLatestBrandOneLiner(
  brandId: string,
  viewerRole: string,
  client: SupabaseClient,
  diagnosisId?: string
): Promise<BrandOneLinerView> {
  const diagnosis = diagnosisId
    ? await fetchDiagnosisById(diagnosisId, client)
    : await fetchLatestDiagnosis(brandId, client);

  if (!diagnosis || diagnosis.status === 'collecting') {
    return {
      main: { state: '진단중', daysElapsed: diagnosis ? daysElapsedSince(diagnosis.startedAt) : null },
      conflicting: null,
    };
  }

  const { data, error } = await client
    .from('brand_one_liners')
    .select(
      'id, diagnosis_id, status, one_liner, selected_feature_ids, location_context_id, question_ids, engine_list, reviewed_by_human'
    )
    .eq('diagnosis_id', diagnosis.id);

  if (error) {
    console.error('brand_one_liners 조회 실패:', error);
    return { main: { state: '진단중', daysElapsed: daysElapsedSince(diagnosis.startedAt) }, conflicting: null };
  }

  const rows: StoredBrandOneLinerRow[] = (data ?? []).map((row) => ({
    id: row.id,
    diagnosisId: row.diagnosis_id,
    status: row.status,
    oneLiner: row.one_liner,
    selectedFeatureIds: row.selected_feature_ids,
    locationContextId: row.location_context_id,
    questionIds: row.question_ids,
    engineList: row.engine_list,
    reviewedByHuman: row.reviewed_by_human,
  }));

  const isRestrictedRole = viewerRole === 'editor' || viewerRole === 'viewer';

  const mainRow = rows.find((r) => r.status !== '잘못된인지') ?? null;
  const conflictRow = rows.find((r) => r.status === '잘못된인지') ?? null;

  let main: BrandOneLinerMain;
  if (!mainRow) {
    // completed인데 brand_one_liners 행 자체가 없음 — 합성 실패 상황 대비 방어적 처리
    main = { state: '진단중', daysElapsed: daysElapsedSince(diagnosis.startedAt) };
  } else if (isRestrictedRole && !mainRow.reviewedByHuman) {
    main = { state: '진단중', daysElapsed: daysElapsedSince(diagnosis.startedAt) };
  } else {
    main = {
      state: '완료',
      diagnosis: { id: diagnosis.id, startedAt: diagnosis.startedAt, endedAt: diagnosis.endedAt },
      status: mainRow.status as '반복확인' | '초기한줄' | '근거부족',
      oneLiner: mainRow.oneLiner,
      selectedFeatureIds: mainRow.selectedFeatureIds ?? [],
      locationContextId: mainRow.locationContextId,
      reviewed: mainRow.reviewedByHuman,
      questionIds: mainRow.questionIds,
      engineList: mainRow.engineList,
    };
  }

  const conflicting: BrandOneLinerConflict | null =
    conflictRow && conflictRow.oneLiner && (!isRestrictedRole || conflictRow.reviewedByHuman)
      ? { oneLiner: conflictRow.oneLiner, featureCandidateIds: conflictRow.selectedFeatureIds ?? [] }
      : null;

  return { main, conflicting };
}

// ── 특징 카드를 펼쳤을 때 보여줄 실제 근거 (Day 20) ──

export interface EvidenceItem {
  id: string;
  queryId: string;
  queryText: string;
  engine: string;
  observedDate: string;
  sourceSentence: string;
}

/**
 * selected_features[].evidence(brand_expressions.id 배열)로 실제 근거
 * 행을 가져온다. 질문 원문(query_text)까지 같이 보여주려고 queries를
 * 조인한다 — brand_expressions엔 query_id만 있어서 그것만으론 화면에
 * "어떤 질문에서 나온 근거인지" 문장으로 못 보여준다.
 */
export async function fetchBrandExpressionsByIds(
  ids: string[],
  client: SupabaseClient
): Promise<EvidenceItem[]> {
  if (ids.length === 0) return [];

  const { data, error } = await client
    .from('brand_expressions')
    .select('id, query_id, engine, observed_date, source_sentence, queries(query_text)')
    .in('id', ids);

  if (error) {
    console.error('근거(brand_expressions) 조회 실패:', error);
    return [];
  }
  if (!data) return [];

  return data.map((row) => {
    const queryRel = Array.isArray(row.queries) ? row.queries[0] : row.queries;
    return {
      id: row.id,
      queryId: row.query_id,
      queryText: queryRel?.query_text ?? '(질문 원문을 찾을 수 없음)',
      engine: row.engine,
      observedDate: row.observed_date,
      sourceSentence: row.source_sentence,
    };
  });
}