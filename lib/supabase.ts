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
 *    이 키는 RLS를 통과하는 마스터키라, 노출되면 누구나 DB를 마음대로 조작할 수 있다.
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
}

/**
 * Supabase queries 테이블에서 활성화된(is_active=true) 쿼리 목록을 읽어온다.
 * 하드코딩된 testQuery 문자열을 대체하는 함수.
 */
export async function fetchActiveQueries(): Promise<StoredQuery[]> {
  const { data, error } = await supabase
    .from('queries')
    .select('id, query_text, intent')
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
  }));
}
// ── 수집 결과를 DB에 저장하기 ──

import { ENGINE_CONFIG } from './engine-config';
import type { ParseResult, OverallMention } from './parser';

export interface SnapshotToSave {
  queryId: string;
  engine: string;         // 어댑터가 돌려준 실제 engine 값 (예: 'claude', 'chatgpt')
  rawResponse: string;
  modelVersion: string;
  batchId: string;
  runIndex: number;
  status: 'success' | 'failed';
  errorMessage: string | null;
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
  sourceUrls: string[];
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
    }))
  );

  if (error) {
    console.error('mentions 저장 실패:', error);
    return false;
  }

  return true;
}