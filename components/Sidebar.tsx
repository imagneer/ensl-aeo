'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

interface BrandOption {
  id: string;
  name: string;
}

const NAV_ITEMS = [
  { href: '/brand-awareness', label: '브랜드 인지', icon: 'ti-message-2' },
  { href: '/brand-position', label: '브랜드 현 위치', icon: 'ti-target-arrow' },
  { href: '/gap', label: '인지와 위치의 간극', icon: 'ti-git-compare' },
  { href: '/trend', label: '변화 추이', icon: 'ti-trending-up' },
] as const;

export function Sidebar({ brands }: { brands: BrandOption[] }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 아직 ?brand=가 없으면(첫 진입) 첫 번째 브랜드를 기본값으로 쓴다.
  const selectedId = searchParams.get('brand') ?? brands[0]?.id ?? null;
  const selectedBrand = brands.find((b) => b.id === selectedId) ?? brands[0] ?? null;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  function selectBrand(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('brand', id);
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  // 네비게이션 링크에 항상 현재 선택된 브랜드를 붙인다.
  // ⚠️ searchParams.toString()을 그대로 쓰지 않는 이유: 아직 URL에 ?brand=가
  // 없는 첫 진입 상태에서는 그대로 붙이면 브랜드값이 안 붙는다 — 화면을
  // 옮기자마자 기본 브랜드 선택이 사라지는 버그가 생긴다.
  const navQuery = new URLSearchParams(searchParams.toString());
  if (selectedId) navQuery.set('brand', selectedId);
  const navQueryString = navQuery.toString();

  return (
    <aside className="sidebar">
      <div className="logo-row">
        <div className="logo-mark" />
        <span className="logo-text">ensl</span>
      </div>

      <div
        className={`brand-box${open ? ' open' : ''}`}
        ref={boxRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <p className="label">진단 중인 브랜드</p>
        <div className="row">
          <p className="name">{selectedBrand?.name ?? '등록된 브랜드 없음'}</p>
          <i className="ti ti-chevron-down" />
        </div>
        <div className="brand-dropdown">
          {brands.map((brand) => (
            <div
              key={brand.id}
              className={`brand-item${brand.id === selectedId ? ' active' : ''}`}
              onClick={() => selectBrand(brand.id)}
            >
              {brand.name}
              {brand.id === selectedId && <i className="ti ti-check" />}
            </div>
          ))}
          <div className="brand-add">
            <i className="ti ti-plus" />
            새 브랜드 추가
          </div>
        </div>
      </div>

      <nav>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={`${item.href}?${navQueryString}`}
            className={pathname === item.href ? 'active' : undefined}
          >
            <i className={`ti ${item.icon}`} />
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
