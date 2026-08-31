import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// 매직링크 이메일의 링크가 최종적으로 도착하는 곳.
// PKCE flow라 code_verifier가 로그인 요청 당시 브라우저 쿠키에 이미
// 저장돼 있어야 한다(app/(auth)/login/actions.ts가 서버 클라이언트로
// signInWithOtp를 부를 때 setAll이 그 쿠키를 심는다) — 그래서 링크를
// 요청한 것과 같은 브라우저에서 눌러야 정상 동작한다.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/brand-awareness';

  if (code) {
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

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return response;
    }
    console.error('로그인 링크 교환 실패:', error);
  }

  const errorUrl = new URL('/login', origin);
  errorUrl.searchParams.set(
    'error',
    '로그인 링크가 만료됐거나 잘못됐어요. 다시 시도해주세요.'
  );
  return NextResponse.redirect(errorUrl);
}
