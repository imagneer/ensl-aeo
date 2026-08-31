import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// ⚠️ 이 Next.js 버전(16)에서는 `middleware.ts`가 폐기되고 `proxy.ts`로
// 바뀌었다(node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
// 확인, 2026-08-31). 파일명·export 이름 모두 `proxy`로 써야 한다.
//
// (dashboard) 라우트 그룹(브랜드 인지/현재위치/간극/변화추이)만 보호한다.
// `/`(기존 데모 홈페이지)는 의도적으로 보호 대상에서 뺐다 — 로그인 없이
// 계속 돌아가는 임시 화면으로 남기기로 함(2026-08-31 확인).
const PROTECTED_PATHS = ['/brand-awareness', '/brand-position', '/gap', '/trend'];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 세션 만료 임박 시 토큰을 갱신하고, 그 결과를 response 쿠키에 반영한다.
  // (Server Component에서는 쿠키를 못 써서 이 갱신을 못 하므로, 모든 요청이
  // 거치는 여기서 먼저 처리해야 함 — @supabase/ssr 자체 문서 경고)
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isProtected = PROTECTED_PATHS.some((path) =>
    request.nextUrl.pathname.startsWith(path)
  );

  if (isProtected && !user) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    '/brand-awareness/:path*',
    '/brand-position/:path*',
    '/gap/:path*',
    '/trend/:path*',
  ],
};
