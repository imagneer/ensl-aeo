// lib/retry.ts

/**
 * 실패할 수 있는 비동기 함수를 재시도해주는 범용 헬퍼.
 *
 * 동작 방식(지수 백오프):
 *   1번째 실패 → 2초 대기 후 재시도
 *   2번째 실패 → 4초 대기 후 재시도
 *   3번째 실패 → 8초 대기 후 재시도
 *   그래도 실패하면 포기하고 에러를 던짐
 *
 * 왜 모든 에러를 재시도하지 않는가:
 *   예를 들어 API 키가 틀렸다면(401 에러), 아무리 기다려도 절대 성공 못 함.
 *   그런 에러까지 재시도하면 시간만 낭비하고 결국 실패하니,
 *   "재시도하면 나아질 수 있는 에러"만 재시도한다.
 *
 * isRetryableError를 밖에서 넘길 수 있게 한 이유(2026-08-19, Day15):
 *   기존엔 "429만 재시도"가 함수 안에 하드코딩돼 있었다. 근데 호출부마다
 *   "뭘 재시도할지"가 다를 수 있다 — 수집 어댑터는 429만 봐도 충분했지만,
 *   키워드 추출은 네트워크 순간 끊김·서버 5xx도 재시도 대상에 넣어야 한다.
 *   기본값(defaultIsRetryableError)은 기존 동작(429만)을 그대로 유지해서,
 *   이미 이 함수를 쓰던 어댑터들은 아무것도 안 바꿔도 그대로 동작한다.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  isRetryableError: (error: unknown) => boolean = defaultIsRetryableError
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 재시도 대상이 아니거나, 이미 최대 재시도 횟수를 다 썼으면 포기
      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }

      const waitMs = 2000 * Math.pow(2, attempt); // 2초, 4초, 8초
      console.log(
        `⚠️ 재시도 가능한 에러 감지, ${waitMs}ms 대기 후 재시도 (${attempt + 1}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

function defaultIsRetryableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('429');
}

/**
 * 키워드 추출(LLM 호출)용 재시도 조건. 429뿐 아니라 네트워크 순간 끊김·
 * 서버 5xx도 재시도 대상에 포함한다. 401/403(인증 실패)은 기다려도
 * 안 풀리는 문제라 재시도 대상에서 뺀다.
 */
export function isRetryableLLMError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message;
  const isRateLimit = msg.includes('429');
  const isServerError = /\b5\d\d\b/.test(msg); // 500~599
  const isNetworkError =
    msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');

  return isRateLimit || isServerError || isNetworkError;
}