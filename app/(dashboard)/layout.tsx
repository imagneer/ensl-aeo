import { Suspense } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { fetchCurrentAccount, fetchTargetBrands } from '@/lib/supabase';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // proxy.ts가 로그인 안 한 요청은 이미 /login으로 돌려보내지만, 로그인은
  // 했는데 아직 어느 워크스페이스에도 안 속한 상태(계정 시딩 전)일 수
  // 있어서 account가 null일 수 있다 — 이때는 그냥 빈 브랜드 목록으로 둔다.
  const account = await fetchCurrentAccount();
  const brands = account ? await fetchTargetBrands(account.id) : [];

  return (
    <div className="app-shell">
      {/* Sidebar는 useSearchParams를 쓰는 클라이언트 컴포넌트라 Suspense로 감싼다
          (안 감싸면 next build에서 "Missing Suspense boundary" 에러가 난다). */}
      <Suspense fallback={<aside className="sidebar" />}>
        <Sidebar brands={brands} />
      </Suspense>
      <div className="main">
        <div className="topbar">
          {/* 진단 일차·업데이트 시각은 Day20 이후 실데이터 연동 시 채운다 */}
          <span className="status" />
          <span className="updated" />
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
