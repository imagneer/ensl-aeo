// lib/llm-usage.ts

/**
 * LLM 호출 usage(입력/출력 토큰) 구조화 로깅 — 단일 진실 소스.
 * (2026-09-04, 9/3 예산 소진 사고 후속 작업지시서 "작업 1")
 *
 * ─────────────────────────────────────────────────────────
 * 왜 만들었나
 * ─────────────────────────────────────────────────────────
 * 9/3 사고의 원인 중 하나가 "lib/keyword-extractor.ts가 data.usage를
 * 로그로 안 남겨서, 사고 이후 정확한 비용을 사후 복원할 수 없었다"는
 * 것이었다(에일 확인, 작업지시서 확인된 사실 5번). ANTHROPIC_API_URL로
 * fetch하는 곳마다 각자 로그를 찍으면 형식이 제각각이라 나중에 grep으로
 * 집계할 때 또 놓친다 — "같은 개념은 같은 기준"(매니페스토 5번)과 같은
 * 이유로 이 파일 하나에서만 로그 형식을 정의한다.
 *
 * 성공/실패 둘 다 남긴다 — 실패를 조용히 삼키지 않는다(CLAUDE.md 절대
 * 원칙 4번). 실패해도 어떤 사이트가 몇 번 시도했는지는 알아야 한다.
 */

export type LlmCallKind = 'target' | 'competitor' | 'expression' | 'retry' | 'oneLiner';
export type LlmRunKind = 'cron' | 'backfill' | 'retry' | 'manual';

export interface LlmCallContext {
  /** 호출부 식별자 — 어느 파일/함수에서 불렀는지. 예: 'keyword-extractor', 'brand-one-liner:writeOneLiner' */
  site: string;
  model: string;
  kind: LlmCallKind;
  brandName?: string | null;
  brandId?: string | null;
  queryId?: string | null;
  engine?: string | null;
  /** 예산 사고 재발 시 "크론이었나 백필이었나 수동이었나"를 바로 구분하기 위함. */
  runKind?: LlmRunKind;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ── 실행 단위 누적 집계 (작업지시서 "작업 2" — 크론 1회 실행당 요약용) ──
//
// aggregateAllQueriesForDay() 같은 "실행 1회" 단위 함수가 시작할 때
// startUsageRun()을 부르고, 끝날 때 getUsageRunSummary()로 읽어서
// 결과 요약(summary)에 얹는다.
//
// ⚠️ 모듈 전역 변수를 쓰는 이유: attemptKeywordExtraction처럼 깊이 있는
// 호출부까지 누적기를 매 함수 시그니처에 관통시키면 변경 범위가 너무
// 커진다. Vercel 서버리스 함수는 요청 1건당 격리된 프로세스라 이 정도
// 전역 상태는 안전하다(코난 판단, 2026-09-04) — 단, 로컬 dev 서버에서
// 크론성 요청 여러 개를 "동시에" 겹쳐서 테스트하면 이 전제가 깨지고
// 집계가 섞인다. 항상 순차로만 테스트할 것.
interface UsageRunSummary {
  llmCalls: number;
  llmCallsByKind: Partial<Record<LlmCallKind, number>>;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmFailedCalls: number;
}

function emptyRunSummary(): UsageRunSummary {
  return { llmCalls: 0, llmCallsByKind: {}, llmInputTokens: 0, llmOutputTokens: 0, llmFailedCalls: 0 };
}

let currentRun: UsageRunSummary | null = null;

/** 크론/백필처럼 "실행 1회"의 시작점에서 부른다. 그 이전 실행 값은 버려진다. */
export function startUsageRun(): void {
  currentRun = emptyRunSummary();
}

/** 추적 중인 실행이 없으면(startUsageRun 안 부른 컨텍스트, 예: 단발 테스트 라우트) 빈 값을 돌려준다. */
export function getUsageRunSummary(): UsageRunSummary {
  return currentRun ? { ...currentRun, llmCallsByKind: { ...currentRun.llmCallsByKind } } : emptyRunSummary();
}

function recordToRun(kind: LlmCallKind, usage: LlmUsage | null, failed: boolean): void {
  if (!currentRun) return; // startUsageRun을 안 부른 컨텍스트 — 조용히 무시(로그 자체는 이미 찍힘)
  currentRun.llmCalls += 1;
  currentRun.llmCallsByKind[kind] = (currentRun.llmCallsByKind[kind] ?? 0) + 1;
  if (failed) {
    currentRun.llmFailedCalls += 1;
    return;
  }
  if (usage) {
    currentRun.llmInputTokens += usage.input_tokens;
    currentRun.llmOutputTokens += usage.output_tokens;
  }
}

// ── 호출 1건 로깅 (작업지시서 "작업 1") ──

export function logLlmCallSuccess(ctx: LlmCallContext, usage: LlmUsage): void {
  recordToRun(ctx.kind, usage, false);
  console.log(
    JSON.stringify({
      llm_call: 1,
      status: 'success',
      site: ctx.site,
      model: ctx.model,
      kind: ctx.kind,
      in: usage.input_tokens,
      out: usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
      brand: ctx.brandName ?? null,
      brandId: ctx.brandId ?? null,
      queryId: ctx.queryId ?? null,
      engine: ctx.engine ?? null,
      runKind: ctx.runKind ?? null,
    })
  );
}

/** !response.ok일 때도 반드시 부른다 — 실패도 "시도"였다는 사실은 남아야 한다. */
export function logLlmCallFailure(ctx: LlmCallContext, httpStatus: number, errorBody: string): void {
  recordToRun(ctx.kind, null, true);
  console.error(
    JSON.stringify({
      llm_call: 1,
      status: 'failed',
      httpStatus,
      site: ctx.site,
      model: ctx.model,
      kind: ctx.kind,
      brand: ctx.brandName ?? null,
      brandId: ctx.brandId ?? null,
      queryId: ctx.queryId ?? null,
      engine: ctx.engine ?? null,
      runKind: ctx.runKind ?? null,
      error: errorBody.slice(0, 500),
    })
  );
}
