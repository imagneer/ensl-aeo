'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * 상단바(Day21) — "진단 N일차 · 7일 중" / "HH:MM 기준 업데이트".
 * layout.tsx(공통 레이아웃)는 searchParams를 못 읽는 Next.js 구조라서,
 * Sidebar.tsx와 같은 방식으로 클라이언트에서 ?brand=를 읽고
 * /api/dashboard-status를 호출해 채운다.
 *
 * 브랜드가 없거나(온보딩 전) 아직 진단이 하나도 없으면 조용히 빈 상태로
 * 둔다 — 억지로 문구를 채우지 않는다(매니페스토 3원칙).
 */
export function DashboardTopbar() {
  const searchParams = useSearchParams();
  const brandId = searchParams.get('brand');
  const [status, setStatus] = useState<{ dayLabel: string | null; updatedLabel: string | null }>({
    dayLabel: null,
    updatedLabel: null,
  });

  useEffect(() => {
    if (!brandId) {
      // setState를 effect 본문에서 동기 호출하면 안 된다는 린트 규칙 때문에
      // 콜백 안으로 옮김 — 브랜드가 사라진 경우(?brand= 없어짐) 이전 브랜드의
      // 값이 화면에 남아있지 않도록 비워준다.
      const timeoutId = setTimeout(() => setStatus({ dayLabel: null, updatedLabel: null }), 0);
      return () => clearTimeout(timeoutId);
    }
    let cancelled = false;
    fetch(`/api/dashboard-status?brand=${brandId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setStatus({ dayLabel: data.dayLabel ?? null, updatedLabel: data.updatedLabel ?? null });
        }
      })
      .catch(() => {
        // 조용히 무시 — 상단바는 보조 정보라 실패해도 나머지 화면을 막지 않는다.
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  return (
    <>
      <span className="status">{status.dayLabel}</span>
      <span className="updated">
        {status.updatedLabel && <i className="ti ti-clock" />}
        {status.updatedLabel}
      </span>
    </>
  );
}
