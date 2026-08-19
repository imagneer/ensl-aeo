// lib/cron-auth.ts

/**
 * Cron 전용 라우트 인증 확인.
 * Vercel Cron이 보내는 요청엔 Authorization: Bearer {CRON_SECRET} 헤더가
 * 자동으로 붙는다. 이 값이 우리가 정한 CRON_SECRET과 일치해야만 통과시킨다.
 *
 * 판단(방식 A, 2026-08-19 확정): CRON_SECRET 환경변수가 아예 없어도 통과시키지
 * 않는다. 로컬 개발 중에도 항상 강제해서, "설정을 깜빡해서 조용히 뚫려있는"
 * 상황 자체를 원천 차단한다 — 편의보다 안전을 우선한다는 판단.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // 설정 자체가 없으면 무조건 거부

  const authHeader = request.headers.get('authorization');
  return authHeader === `Bearer ${expected}`;
}
