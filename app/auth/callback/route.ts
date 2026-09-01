import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * 매직링크가 최종적으로 도착하는 곳. 두 가지 형태를 모두 받는다.
 *
 * 1) `?code=...` — PKCE flow. 로그인 폼에서 signInWithOtp를 부를 때 심어둔
 *    code_verifier 쿠키가 같은 브라우저에 있어야 교환된다(=링크를 요청한 것과
 *    같은 브라우저에서 눌러야 함).
 *
 * 2) `?token_hash=...&type=magiclink` — 서버 측 verifyOtp flow. code_verifier
 *    쿠키가 필요 없어서, 다른 브라우저에서 눌러도 되고 관리자가
 *    generate_link로 만든 링크로도 로그인할 수 있다. (2026-09-01 추가:
 *    Supabase 기본 SMTP의 시간당 발송 한도에 걸려 메일 자체가 안 나갈 때
 *    로그인할 방법이 아예 없어지는 문제를 겪고, 우회 경로로 함께 지원)
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = searchParams.get('next') ?? '/brand-awareness';

  if (code || (tokenHash && type)) {
    const response = NextResponse.redirect(`${origin}${next}`);

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type! });

    if (!error) {
      return response;
    }
    console.error('로그인 링크 처리 실패:', error);
  }

  const errorUrl = new URL('/login', origin);
  errorUrl.searchParams.set(
    'error',
    '로그인 링크가 만료됐거나 잘못됐어요. 다시 시도해주세요.'
  );
  return NextResponse.redirect(errorUrl);
}
