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

  // ⚠️ ?brand= 없이 대시보드 경로로 들어온 경우(가장 흔한 예: 로그인 직후
  // /auth/callback의 기본 next="/brand-awareness"가 brand 파라미터를 안
  // 붙임) 첫 번째 타겟 브랜드로 리다이렉트한다. 4개 화면 전부를 한 곳에서
  // 처리하려고 했는데, layout.tsx는 searchParams를 못 받는 구조라서
  // (Next.js 공식 문서: "Layouts... cannot access search params") 이미
  // 이 4개 경로를 전부 보호하고 있는 proxy.ts로 옮겨서 구현함(2026-09-01,
  // 루아 요청).
  if (isProtected && user && !request.nextUrl.searchParams.has('brand')) {
    const { data: member } = await supabase
      .from('account_members')
      .select('account_id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (member?.account_id) {
      const { data: brand } = await supabase
        .from('brands')
        .select('id')
        .eq('account_id', member.account_id)
        .eq('is_target', true)
        .order('name')
        .limit(1)
        .maybeSingle();

      if (brand?.id) {
        const redirectUrl = new URL(request.nextUrl.pathname, request.url);
        redirectUrl.search = request.nextUrl.searchParams.toString();
        redirectUrl.searchParams.set('brand', brand.id);
        return NextResponse.redirect(redirectUrl);
      }
    }
    // 계정/브랜드를 못 찾으면(시딩 전 등) 그냥 통과 — 각 페이지가 이미
    // "브랜드를 선택해주세요" 같은 빈 상태를 처리하고 있다.
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
