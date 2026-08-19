// lib/collector.ts
import type { EngineName } from './engine-config';
import type { EngineAdapter } from './types';
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

const ADAPTERS: { engine: EngineName; adapter: EngineAdapter }[] = [
  { engine: 'perplexity', adapter: perplexityAdapter },
  { engine: 'claude', adapter: anthropicAdapter },
  { engine: 'chatgpt', adapter: openaiAdapter },
  { engine: 'gemini', adapter: geminiAdapter },
  { engine: 'naver_ai_briefing', adapter: naverAiOverviewAdapter },
  { engine: 'google_aio', adapter: googleAiOverviewAdapter },
];


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
 * 전체 파이프라인: DB에서 쿼리·브랜드 목록을 가져와 → 6개 엔진에 물어보고
 * → 결과를 파싱해서 → snapshots·mentions 테이블에 저장한다.
 * 한 번의 수집·파싱·저장 묶음(run 하나)을 처리한다.
 *
 * batchId/runIndex를 함수 밖에서 받는 이유: 같은 시간대 안에서 여러 번 반복할 때
 * (Day 4 설계: 시간대당 2회) 모든 반복이 같은 batchId를 공유해야 하기 때문이다.
 * 이 함수는 "번호표를 누가, 언제 만드는지" 몰라도 되게 설계해서,
 * 나중에 크론 구조가 바뀌어도(예: 반복마다 별도 트리거) 이 함수는 그대로 재사용한다.
 */

export async function collectAndSaveOnce(
  batchId: string,
  runIndex: number
): Promise<{
  batchId: string;
  totalSnapshots: number;
  savedSnapshots: number;
  savedMentions: number;
}> {
  console.log(`=== collectAndSaveOnce 시작 (batchId: ${batchId}, runIndex: ${runIndex}) ===`);


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

/**
 * A안 껍데기: 하나의 batchId로 2회 반복(run 1, run 2)을 순차 실행하고 합산한다.
 * Day 4 설계("시간대 내 2회 반복")를 한 번의 함수 실행 안에서 구현하는 방식.
 *
 * 판단: run 1이 예상치 못한 에러로 죽어도 run 2는 시도한다(각각 try/catch로 감쌈).
 * 이유: 한쪽이 죽었다고 나머지까지 포기하면 그날 그 시간대 데이터가 통째로 0이
 * 되어버린다. 대신 어느 run이 실패했는지는 runErrors에 명시적으로 남긴다.
 */
export async function collectAndSaveAll(): Promise<{
  batchId: string;
  totalSnapshots: number;
  savedSnapshots: number;
  savedMentions: number;
  runErrors: string[]; // 비어있으면 둘 다 정상
}> {
  const batchId = randomUUID();

  let totalSnapshots = 0;
  let savedSnapshots = 0;
  let savedMentions = 0;
  const runErrors: string[] = [];

  for (let runIndex = 1; runIndex <= 2; runIndex++) {
    try {
      const result = await collectAndSaveOnce(batchId, runIndex);
      totalSnapshots += result.totalSnapshots;
      savedSnapshots += result.savedSnapshots;
      savedMentions += result.savedMentions;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`=== run ${runIndex} 실패: ${msg} ===`);
      runErrors.push(`run ${runIndex}: ${msg}`);
    }
  }

  console.log(
    `=== collectAndSaveAll 완료 (batchId: ${batchId}) — snapshot ${savedSnapshots}개, mentions ${savedMentions}개, 에러 ${runErrors.length}건 ===`
  );

  return { batchId, totalSnapshots, savedSnapshots, savedMentions, runErrors };
}
