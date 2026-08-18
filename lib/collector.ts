// lib/collector.ts

import { perplexityAdapter } from './adapters/perplexity';
import { anthropicAdapter } from './adapters/anthropic';
import { openaiAdapter } from './adapters/openai';
import { geminiAdapter } from './adapters/gemini';
import { fetchKnownBrands } from './supabase';
import { parseBrandMentions, findUnregisteredBrands, buildOverallRanking } from './parser';
import { linkCitationsToMentions } from './citation-linker';
import type { AdapterResponse } from './types';
import { retryWithBackoff } from './retry';
import { naverAiOverviewAdapter } from './adapters/naver-ai-briefing';
import { googleAiOverviewAdapter } from './adapters/google-ai-overview';

// 엔진 이름과 어댑터를 짝지어주는 목록.
// 나중에 새 엔진 추가하고 싶으면 이 배열에 한 줄만 추가하면 됨.
const ADAPTERS = [
  { engine: 'perplexity', adapter: perplexityAdapter },
  { engine: 'claude', adapter: anthropicAdapter },   // engine-config.ts와 이름 통일
  { engine: 'chatgpt', adapter: openaiAdapter },      // engine-config.ts와 이름 통일
  { engine: 'gemini', adapter: geminiAdapter },
  { engine: 'naver-ai-briefing', adapter: naverAiOverviewAdapter },
  { engine: 'google-ai-overview', adapter: googleAiOverviewAdapter },
] as const;

export interface CollectedResult {
  engine: string;
  success: boolean;
  response?: AdapterResponse;
  error?: string;
}

/**
 * 쿼리 하나를 4개 엔진 전부에 물어보고, 각 결과를 모아서 배열로 돌려준다.
 *
 * 왜 Promise.allSettled를 쓰는가:
 *   4개 중 하나(예: Gemini)가 에러가 나도, 나머지 3개는 계속 진행되어야 한다.
 *   Promise.all은 하나만 실패해도 전체가 즉시 실패로 끝나버리므로 부적합하다.
 *   allSettled는 각각의 성공/실패를 개별로 기록해서 돌려준다.
 */
export async function collectAll(query: string): Promise<CollectedResult[]> {
  const results = await Promise.allSettled(
    ADAPTERS.map(async ({ engine, adapter }) => {
      const response = await retryWithBackoff(() => adapter.ask(query));
      return { engine, response };
    })
  );

  return results.map((result, index) => {
    const engine = ADAPTERS[index].engine;

    if (result.status === 'fulfilled') {
      return {
        engine,
        success: true,
        response: result.value.response,
      };
    } else {
      return {
        engine,
        success: false,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    }
  });
}
// ── 전체 쿼리 × 전체 엔진 수집 ──

import { fetchActiveQueries } from './supabase';

export interface FullCollectionResult extends CollectedResult {
  queryId: string;
  queryText: string;
}

/**
 * DB에 등록된 활성 쿼리 전부를 4개 엔진에 물어본다.
 * 쿼리 5개 × 엔진 4개 = 20번 호출.
 *
 * 왜 쿼리는 순차적으로(for...of), 엔진은 병렬로(collectAll) 처리하는가:
 *   엔진 4개를 병렬로 부르는 건 서로 다른 회사 API라 문제없다.
 *   하지만 쿼리 5개를 전부 한꺼번에 병렬로 부르면 총 20개 요청이 동시에 나가버려서,
 *   각 API의 rate limit(초당 요청 제한)에 걸릴 위험이 커진다.
 *   그래서 쿼리 단위로는 하나씩 순서대로 처리한다.
 */
export async function collectAllQueries(): Promise<FullCollectionResult[]> {
  const queries = await fetchActiveQueries();

  if (queries.length === 0) {
    console.error('활성 쿼리가 없습니다. queries 테이블을 확인하세요.');
    return [];
  }

  const allResults: FullCollectionResult[] = [];

  for (const query of queries) {
    console.log(`쿼리 처리 중: "${query.queryText}"`);
    const results = await collectAll(query.queryText);

    for (const r of results) {
      allResults.push({
        ...r,
        queryId: query.id,
        queryText: query.queryText,
      });
    }
  }

  return allResults;
}
// ── 수집 + 파싱 + 저장을 한 번에 ──

import { randomUUID } from 'crypto';
import { saveSnapshot, saveMentions } from './supabase';

/**
 * 전체 파이프라인: DB에서 쿼리·브랜드 목록을 가져와 → 4개 엔진에 물어보고
 * → 결과를 파싱해서 → snapshots·mentions 테이블에 저장한다.
 *
 * batchId: 이번 실행 전체를 하나로 묶는 식별자.
 *   Day 4 설계대로면 하루 3번(09/13/18시) 자동 실행될 때마다 새 batchId가 생겨야 한다.
 *   지금은 수동 실행이라 실행할 때마다 새로 하나 발급한다.
 */
export async function collectAndSaveAll(): Promise<{
  batchId: string;
  totalSnapshots: number;
  savedSnapshots: number;
  savedMentions: number;
}> {
  const batchId = randomUUID();
  const runIndex = 1; // 오늘은 반복 없이 1회만

  console.log(`=== collectAndSaveAll 시작 (batchId: ${batchId}) ===`);

  const knownBrands = await fetchKnownBrands();
  const results = await collectAllQueries();

  let savedSnapshots = 0;
  let savedMentions = 0;

  for (const r of results) {
    if (r.success && r.response) {
      // 성공한 경우: 파싱 후 snapshot + mentions 저장
      const parsed = parseBrandMentions(r.response.rawText, knownBrands);
      const unregistered = findUnregisteredBrands(r.response.rawText, parsed.mentions, knownBrands);
      const overallRanking = buildOverallRanking(parsed, unregistered);

      const snapshotId = await saveSnapshot({
        queryId: r.queryId,
        engine: r.response.engine, // 어댑터가 돌려준 실제 engine 값 사용
        rawResponse: r.response.rawText,
        modelVersion: r.response.model,
        batchId,
        runIndex,
        status: 'success',
        errorMessage: null,
        // 어댑터가 분리해서 돌려준 값을 그대로 보존한다.
        // retrievedSources가 null이면 "이 엔진은 후보 목록을 제공하지 않음"(ChatGPT)이라는 뜻이다.
        retrievedSources: r.response.retrievedSources,
        citedSpans: r.response.citedSpans,
        searchPerformed: r.response.searchPerformed,
        overviewShown: r.response.overviewShown,
      });

      if (snapshotId) {
        savedSnapshots++;

        // 브랜드별로 출처를 갈라 붙인다 (Day 8).
        // 이전에는 여기서 r.response.citations(답변 전체 출처)를 모든 브랜드에
        // 똑같이 복사했다. 판정 규칙은 lib/citation-linker.ts 참고.
        // linked는 overallRanking과 같은 순서·같은 길이라 인덱스로 짝짓는다.
        const linked = linkCitationsToMentions(
          r.response.rawText,
          overallRanking,
          r.response.citedSpans,
          knownBrands          
        );

        const mentionsToSave = overallRanking.map((m, i) => ({
          snapshotId,
          brandId: m.brandId,
          brandNameRaw: m.brandName,
          isTarget: m.isTarget,
          rank: m.overallRank,
          sourceUrls: linked[i].urls,
          sourceDomains: linked[i].domains,
          citationConfidence: linked[i].confidence,
        }));

        const ok = await saveMentions(mentionsToSave);
        if (ok) savedMentions += mentionsToSave.length;
      }
    } else {
      // 실패한 경우: 에러 내용을 status='failed'로 정직하게 저장 (mentions는 없음)
      const snapshotId = await saveSnapshot({
        queryId: r.queryId,
        engine: r.engine, // 실패 시엔 response가 없으므로 ADAPTERS 라벨 사용 (아래 참고)
        rawResponse: '',
        modelVersion: 'unknown',
        batchId,
        runIndex,
        status: 'failed',
        errorMessage: r.error ?? '알 수 없는 오류',
        // 실패한 호출은 답변 자체가 없다. 그래서 "0개"가 아니라 "모름"(null)이다.
        // searchPerformed를 false로 적으면 "검색 없이 답했다"는 없던 사실이 생긴다.
        retrievedSources: null,
        citedSpans: null,
        searchPerformed: null,
        overviewShown: null,
      });

      if (snapshotId) savedSnapshots++;
    }
  }

  console.log(`=== 저장 완료: snapshot ${savedSnapshots}개, mentions ${savedMentions}개 ===`);

  return {
    batchId,
    totalSnapshots: results.length,
    savedSnapshots,
    savedMentions,
  };
}