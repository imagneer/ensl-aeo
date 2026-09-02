import { Suspense } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { DashboardTopbar } from '@/components/DashboardTopbar';
import { createServerSupabaseClient, fetchCurrentAccount, fetchTargetBrands } from '@/lib/supabase';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // ⚠️ 브랜드 조회에 반드시 이 세션 클라이언트를 넘겨야 한다. anon 키로
  // 부르면(fetchTargetBrands의 기본값) RLS의 "계정 소속만" 정책을
  // auth.uid()가 없어서 무조건 못 통과한다 — accountId로 필터링해도
  // 소용없다(2026-08-31 실측으로 확인된 함정, day19-step7 SQL 이후
  // 사이드바가 빈 화면으로 나온 원인이었음).
  const sessionClient = await createServerSupabaseClient();

  // proxy.ts가 로그인 안 한 요청은 이미 /login으로 돌려보내지만, 로그인은
  // 했는데 아직 어느 워크스페이스에도 안 속한 상태(계정 시딩 전)일 수
  // 있어서 account가 null일 수 있다 — 이때는 그냥 빈 브랜드 목록으로 둔다.
  const account = await fetchCurrentAccount(sessionClient);
  const brands = account ? await fetchTargetBrands(account.id, sessionClient) : [];

  return (
    <div className="app-shell">
      {/* Sidebar는 useSearchParams를 쓰는 클라이언트 컴포넌트라 Suspense로 감싼다
          (안 감싸면 next build에서 "Missing Suspense boundary" 에러가 난다). */}
      <Suspense fallback={<aside className="sidebar" />}>
        <Sidebar brands={brands} />
      </Suspense>
      <div className="main">
        <div className="topbar">
          {/* DashboardTopbar도 useSearchParams를 쓰는 클라이언트 컴포넌트라
              Suspense로 감싼다(Day21) — Sidebar와 같은 이유. */}
          <Suspense fallback={<span className="status" />}>
            <DashboardTopbar />
          </Suspense>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
