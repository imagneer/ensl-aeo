'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase';

export async function sendMagicLink(formData: FormData) {
  const email = formData.get('email');

  if (typeof email !== 'string' || !email.trim()) {
    redirect('/login?error=' + encodeURIComponent('이메일 주소를 입력해주세요.'));
  }

  const supabase = await createServerSupabaseClient();

  // ⚠️ headers().get('origin')을 썼었는데, Origin 헤더는 폼 제출 방식이나
  // 프록시 경로에 따라 안 실릴 수 있다(실측 확인, 2026-09-01) — 프로덕션에서
  // null이 나와서 emailRedirectTo가 "null/auth/callback"이라는 깨진 주소가
  // 됐고, Supabase가 이걸 허용 목록에 없다고 보고 Site URL(그냥 루트 "/")로
  // 조용히 대체해버렸다. 루트 페이지는 code 파라미터를 처리 안 해서 로그인이
  // 절대 안 끝나는데, 메일 발송 자체는 성공해서(에러 없이) 원인 파악이
  // 어려웠던 버그. Host 헤더는 HTTP 요청에 항상 실리므로 이걸로 바꾼다.
  const headersList = await headers();
  const host = headersList.get('host') ?? 'localhost:3000';
  const protocol = headersList.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const origin = `${protocol}://${host}`;

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    console.error('매직링크 발송 실패:', error.status, error.code, error.message);

    // ⚠️ 실패 사유를 뭉뚱그리지 않는다(2026-09-01). 예전엔 전부 "잠시 후 다시
    // 시도해주세요"로 덮었는데, 실제 원인이 발송 한도 초과(429
    // over_email_send_rate_limit)일 때는 다시 시도하는 게 오히려 한도를
    // 더 소진시켜서 상황을 악화시킨다. 사용자가 "몇 번 더 눌러보면 되겠지"로
    // 오해하게 만드는 문구였고, 실제로 13초 안에 4번 재시도한 기록이 남았다.
    // 원인별로 다르게 안내하고, 개발자가 나중에 추적할 수 있게 에러 코드도
    // 함께 남긴다(CLAUDE.md "실패를 조용히 삼키지 않는다").
    const isRateLimited = error.status === 429 || error.code === 'over_email_send_rate_limit';
    const message = isRateLimited
      ? '메일 발송 한도에 걸렸어요. 지금은 다시 눌러도 발송되지 않으니 1시간쯤 뒤에 시도해주세요.'
      : `로그인 링크를 보내지 못했어요. (오류: ${error.code ?? error.status ?? '알 수 없음'})`;

    redirect('/login?error=' + encodeURIComponent(message));
  }

  redirect('/login?sent=' + encodeURIComponent(email));
}
