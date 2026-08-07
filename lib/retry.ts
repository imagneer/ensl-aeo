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
 *   "재시도하면 나아질 수 있는 에러"(429 rate limit)만 재시도한다.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isRateLimitError =
        error instanceof Error && error.message.includes('429');

      // rate limit 에러가 아니거나, 이미 최대 재시도 횟수를 다 썼으면 포기
      if (!isRateLimitError || attempt === maxRetries) {
        throw error;
      }

      const waitMs = 2000 * Math.pow(2, attempt); // 2초, 4초, 8초
      console.log(
        `⚠️ Rate limit 감지, ${waitMs}ms 대기 후 재시도 (${attempt + 1}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}