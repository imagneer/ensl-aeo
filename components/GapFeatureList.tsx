'use client';

import { Children, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

/**
 * 특징 목록(.flist) + 공유 판정 근거 패널(.detail-panel) — 간극 화면
 * (Day22). 프로토타입(docs/prototypes/ensl_gap_screen.html) 원본 구조를
 * 그대로 따른다: `select()` 함수를 직접 읽어서 확인한 동작은 —
 *   1. 목록과 패널이 완전히 분리된 별개 블록
 *   2. 항목 클릭 → 클릭한 행에만 .selected, 나머지는 전부 해제(단일 선택)
 *   3. 그 아래 패널 하나의 내용이 클릭한 항목 걸로 바뀜
 *   4. 패널로 scrollIntoView({behavior:'smooth', block:'nearest'})
 *
 * ⚠️ 2026-09-08 재설계 — 처음엔 GapFeatureRow가 <details>로 자기 상세
 * 패널을 품고 있어서(행마다 독립 아코디언), 여러 개를 펼치면 같은
 * 특징명이 접힌 헤더와 펼친 내용 맨 위에 중복 표시되는 문제가 있었다
 * (스크린샷으로 확인). 프로토타입처럼 "목록 따로, 공유 패널 하나 따로"
 * 구조로 되돌렸다 — 다만 프로토타입은 특징 4개짜리 정적 HTML이라 패널
 * 4개를 전부 만들어두고 display로 숨기는 방식을 썼는데, 우리는 11개고
 * React 앱이라 그 방식을 그대로 따를 필요는 없다(코난 판단, 2026-09-08
 * 작업지시 반영) — 서버에서 이미 렌더링해둔 11개 패널 중 selectedId에
 * 해당하는 것 하나만 조건부로 고른다.
 *
 * 패널 선택 매칭에 React의 `.key`(Children.toArray가 내부적으로 접두사를
 * 붙이는 등 형식이 안정적이지 않음)를 안 쓰고, 명시적으로 준
 * `data-feature-id` prop으로 매칭한다 — 더 예측 가능하고 디버깅하기 쉽다.
 */

interface GapFeatureListContextValue {
  selectedId: string | null;
  select: (featureId: string) => void;
}

const GapFeatureListContext = createContext<GapFeatureListContextValue | null>(null);

function useGapFeatureListContext(componentName: string): GapFeatureListContextValue {
  const ctx = useContext(GapFeatureListContext);
  if (!ctx) throw new Error(`${componentName}는 GapFeatureList 안에서만 쓸 수 있어요.`);
  return ctx;
}

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
      {children}
    </GapFeatureListContext.Provider>
  );
}

/** 목록 한 줄 — 클릭하면 이 특징이 selected(목록 강조)되고, 아래 공유 패널 내용도 이걸로 바뀐다. */
export function GapFeatureRow({
  featureId,
  featureName,
  fsub,
  pillClassName,
  pillLabel,
}: {
  featureId: string;
  featureName: string;
  fsub: string;
  pillClassName: string;
  pillLabel: string;
}) {
  const ctx = useGapFeatureListContext('GapFeatureRow');
  const isSelected = ctx.selectedId === featureId;

  return (
    <div
      className={`frow${isSelected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => ctx.select(featureId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ctx.select(featureId);
        }
      }}
    >
      <div className="frow-head">
        <div>
          <p className="fname">{featureName}</p>
          <p className="fsub">{fsub}</p>
        </div>
        <div className="right">
          <span className={`pill ${pillClassName}`}>{pillLabel}</span>
          <span className="chev">›</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 공유 판정 근거 패널 — 자식으로 "특징마다 하나씩, data-feature-id를 붙인"
 * 사전 렌더링된 패널들을 전부 받아서, 그중 지금 selectedId와 일치하는
 * 것 하나만 보여준다. selectedId가 바뀔 때마다(=행을 클릭할 때마다)
 * 패널로 부드럽게 스크롤한다(프로토타입 select() 동작 그대로).
 */
export function GapFeatureDetailPanel({ children }: { children: ReactNode }) {
  const ctx = useGapFeatureListContext('GapFeatureDetailPanel');
  const ref = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    // 첫 렌더(페이지 로드 시 hero가 기본 선택된 상태)에는 스크롤하지 않는다 —
    // 프로토타입도 클릭했을 때만 스크롤하지, 처음 진입할 때 페이지 중간으로
    // 점프시키지 않는다.
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [ctx.selectedId]);

  const panels = Children.toArray(children) as ReactElement<{ 'data-feature-id'?: string }>[];
  const selectedPanel = panels.find(
    (child) => isValidElement(child) && child.props['data-feature-id'] === ctx.selectedId
  );

  // 스크롤 이동의 기준점만 잡는 얇은 래퍼 — 실제 .detail-panel 스타일
  // (테두리·패딩 등)은 renderFeatureDetail()이 이미 그 안에서 씌운다.
  // 여기서 또 .detail-panel 클래스를 붙이면 이중으로 감싸져서 패딩이
  // 두 번 겹친다.
  return <div ref={ref}>{selectedPanel ?? null}</div>;
}
