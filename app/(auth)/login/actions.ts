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
    console.error('매직링크 발송 실패:', error);
    redirect(
      '/login?error=' +
        encodeURIComponent('로그인 링크 발송에 실패했어요. 잠시 후 다시 시도해주세요.')
    );
  }

  redirect('/login?sent=' + encodeURIComponent(email));
}
