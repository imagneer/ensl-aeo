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
    // 시도해주세요"로 덮었는데, 그러면 사용자가 "몇 번 더 눌러보면 되겠지"로
    // 오해해서 오히려 한도를 더 태운다(실제로 13초 안에 4번 재시도한 기록이
    // 남았다).
    //
    // ⚠️⚠️ 더 중요한 함정(같은 날 실측으로 확인): Supabase는 성격이 완전히
    // 다른 두 상황에 **똑같은 error_code(over_email_send_rate_limit)와
    // 똑같은 429**를 쓴다.
    //   (a) 사용자당 최소 간격 — 대기 시간 60초 (SMTP 설정의 Minimum
    //       interval per user). msg 예: "For security purposes, you can only
    //       request this after 51 seconds"
    //   (b) 시간당 총 발송량 한도 — 대기 시간 1시간 단위.
    //       msg 예: "email rate limit exceeded"
    // 코드만 보고 하나로 뭉뚱그리면 60초만 기다리면 될 사람에게 "1시간
    // 기다리라"고 잘못 안내하게 된다(실제로 그렇게 안내해서 루아를 헛되이
    // 기다리게 만들었다). 그래서 대기 시간은 추측하지 않고 Supabase가 준
    // 메시지에서 실제 초를 뽑아 쓴다.
    const isRateLimited = error.status === 429 || error.code === 'over_email_send_rate_limit';
    const waitSeconds = error.message?.match(/after (\d+) seconds?/i)?.[1];

    let message: string;
    if (waitSeconds) {
      message = `연속 요청을 막기 위해 ${waitSeconds}초 후에 다시 보낼 수 있어요. 잠깐 기다렸다 다시 눌러주세요.`;
    } else if (isRateLimited) {
      message =
        '메일 발송 한도에 걸렸어요. 지금은 다시 눌러도 발송되지 않으니 1시간쯤 뒤에 시도해주세요.';
    } else {
      message = `로그인 링크를 보내지 못했어요. (오류: ${error.code ?? error.status ?? '알 수 없음'})`;
    }

    redirect('/login?error=' + encodeURIComponent(message));
  }

  redirect('/login?sent=' + encodeURIComponent(email));
}
