import { Suspense } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { fetchTargetBrands } from '@/lib/supabase';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const brands = await fetchTargetBrands();

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
