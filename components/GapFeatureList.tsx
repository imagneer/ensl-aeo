'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * 특징 목록 아코디언(간극 화면, Day22) — 클릭한 항목 강조 배경
 * (`.frow.selected`) 복원용으로 서버 컴포넌트에서 분리했다(2026-09-08).
 *
 * ⚠️ 설계를 한 번 바꿨다 — 처음엔 `<GapFeatureList items={[{..., detail:
 * ReactNode}]} />`처럼 서버에서 렌더링한 detail을 배열 프로퍼티 안에
 * 담아 넘겼는데, 이 구조에서 React가 하이드레이션 시점에 "key가 없다"는
 * 경고를 냈다(items 배열 자체엔 키를 줄 수 없고, 각 detail 엘리먼트에
 * key를 줘도 배열의 "직접 하위 항목"이 아니라서 인식이 안 됨 — 실측
 * 확인, 2026-09-08). Next.js가 권장하는 대로 "서버 컴포넌트 트리를
 * children으로 직접 넘기고, .map() 호출부(서버 컴포넌트, gap/page.tsx)에서
 * 바로 key를 준다"는 형태로 바꾸니 경고가 사라졌다 — 그래서 지금은
 * GapFeatureList(컨테이너)+GapFeatureRow(행) 두 컴포넌트로 나뉘어 있다.
 *
 * ⚠️ "열림/닫힘"과 "selected"는 다른 개념이다 — <details>는 여러 개
 * 동시에 열릴 수 있고(다중 펼침 유지, 프로토타입의 "한 번에 하나만" 제약을
 * 그대로 따를 필요는 없다고 판단, 2026-09-08), selected는 "가장 최근에
 * 연 항목" 하나에만 붙는 별도 표시다.
 */

interface GapFeatureListContextValue {
  selectedId: string | null;
  select: (featureId: string) => void;
}

const GapFeatureListContext = createContext<GapFeatureListContextValue | null>(null);

export function GapFeatureList({
  children,
  defaultSelectedId,
}: {
  children: ReactNode;
  defaultSelectedId: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(defaultSelectedId);

  return (
    <GapFeatureListContext.Provider value={{ selectedId, select: setSelectedId }}>
      <div className="flist">{children}</div>
    </GapFeatureListContext.Provider>
  );
}

export function GapFeatureRow({
  featureId,
  featureName,
  fsub,
  pillClassName,
  pillLabel,
  defaultOpen,
  children,
}: {
  featureId: string;
  featureName: string;
  fsub: string;
  pillClassName: string;
  pillLabel: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const ctx = useContext(GapFeatureListContext);
  if (!ctx) throw new Error('GapFeatureRow는 GapFeatureList 안에서만 쓸 수 있어요.');

  return (
    <details
      className={`frow${ctx.selectedId === featureId ? ' selected' : ''}`}
      open={defaultOpen}
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) ctx.select(featureId);
      }}
    >
      <summary className="frow-head">
        <div>
          <p className="fname">{featureName}</p>
          <p className="fsub">{fsub}</p>
        </div>
        <div className="right">
          <span className={`pill ${pillClassName}`}>{pillLabel}</span>
          <span className="chev">▾</span>
        </div>
      </summary>
      {children}
    </details>
  );
}
