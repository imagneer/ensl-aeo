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
// ── 집계된 지표를 DB에 저장하기 (Day 9) ──

export interface AggregatedMetricToSave {
  queryId: string;
  brandId: string;
  engine: string;
  periodStart: string;   // ISO 문자열
  periodEnd: string;     // ISO 문자열
  aggregationLevel: 'batch' | 'daily';
  batchId: string | null; // daily 레벨은 여러 batch를 묶으므로 null

  /** 유효 관측치 개수 (분모). 규칙: status='success' AND search_performed=true만 센다 */
  totalRuns: number;

  /** 유효 관측치 중 이 브랜드가 언급된 횟수 (분자) */
  mentionCount: number;

  /** totalRuns가 0이면 계산 불가이므로 null (0으로 채우지 않음) */
  visibilityRate: number | null;

  /** 언급된 관측치가 0건이면 null */
  avgRank: number | null;

  /** 유효 관측치(정확히는 언급된 관측치)가 2개 미만이면 null */
  rankStddev: number | null;

  /** 같은 기간 다른 등록 브랜드들의 요약 지표. 없으면 null */
  competitorData: Record<string, { name: string; mentionCount: number; visibilityRate: number | null; avgRank: number | null }> | null;
}

/**
 * aggregated_metrics 표에 집계 결과 1줄을 저장한다.
 *
 * ⚠️ 전제조건: service_role이 이 표에 대한 권한을 가지고 있어야 한다.
 *    (2026-08-17 실측: 권한이 없어서 SELECT조차 안 되는 상태였음. 아래 SQL을
 *     Supabase SQL Editor에서 먼저 실행해야 함 — day9-decision-aggregation.md 참고)
 *      GRANT ALL ON public.aggregated_metrics TO service_role;
 */
export async function saveAggregatedMetric(m: AggregatedMetricToSave): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('aggregated_metrics')
    .insert({
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
    })
    .select('id')
    .single();

  if (error) {
    console.error('aggregated_metrics 저장 실패:', error);
    return null;
  }

  return data.id;
}

// ── 집계용 원시 데이터 읽어오기 (Day 9) ──

export interface SnapshotForAggregation {
  id: string;
  status: 'success' | 'failed';
  searchPerformed: boolean | null;
  executedAt: string;
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
    .select('id, status, search_performed, executed_at')
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
