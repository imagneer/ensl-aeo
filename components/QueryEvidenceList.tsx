'use client';

import { useState } from 'react';

/**
 * "실제 답변 일부와 출처" 섹션(질문상세, Day21). 판단(어떤 걸 보여줄지,
 * 어떻게 자를지)은 서버(app/(dashboard)/query/[id]/page.tsx)에서 이미
 * 끝났다 — 여기는 펼치기/더 보기 같은 순수 UI 상태만 다룬다.
 *
 * "이전 회차 더 보기" 페이지네이션은 서버 재조회가 아니라 클라이언트에서
 * 이미 받아온 배열을 몇 개씩 더 보여주는 방식으로 구현했다 — 질문 하나의
 * 전체 관측 기록이 진단 기간(최대 7일) 안에서는 많아야 수십 건이라
 * (자리: 최대 42회, 인지: 최대 84회) 한 번에 다 받아둬도 무리가 없고,
 * 매 클릭마다 서버 왕복하는 것보다 단순하다(2026-09-02, 코난 판단).
 */

export interface EvidenceCardData {
  id: string;
  engineLabel: string;
  dateTimeLabel: string;
  /** 자리 질문에서만 의미 있음 — 인지 질문이면 null(등장 개념 자체가 없음). */
  appeared: boolean | null;
  appearedBrands: { name: string; isTarget: boolean }[];
  shortQuote: string;
  fullQuote: string;
  sources: { domain: string; url: string }[];
}

function EvidenceCard({ card }: { card: EvidenceCardData }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = card.fullQuote.length > card.shortQuote.length;

  return (
    <div className="evidence-box" id={`snapshot-${card.id}`}>
      <p className="src">
        {card.engineLabel} · {card.dateTimeLabel}
        {card.appeared !== null && <> · {card.appeared ? '등장함' : '등장하지 않음'}</>}
      </p>
      {card.appearedBrands.length > 0 && (
        <div className="appeared">
          {card.appearedBrands.map((b) => (
            <span key={b.name} className={`tag ${b.isTarget ? 'ours' : 'comp'}`}>
              {b.name}
            </span>
          ))}
        </div>
      )}
      <p className="quote" style={{ whiteSpace: 'pre-wrap' }}>
        {expanded ? card.fullQuote : card.shortQuote}
      </p>
      {card.sources.length > 0 && (
        <p className="src-links">
          출처
          {card.sources.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
              {s.domain} ↗
            </a>
          ))}
        </p>
      )}
      {canExpand && (
        <button className="expand-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '접기 ↑' : '답변 전체 보기 ↓'}
        </button>
      )}
    </div>
  );
}

export function QueryEvidenceList({ cards }: { cards: EvidenceCardData[] }) {
  const PAGE_SIZE = 5;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  if (cards.length === 0) {
    return <p className="es-text">이 기간엔 유효한 응답 기록이 없어요.</p>;
  }

  const visible = cards.slice(0, visibleCount);
  const remaining = cards.length - visibleCount;

  return (
    <>
      {visible.map((c) => (
        <EvidenceCard key={c.id} card={c} />
      ))}
      {remaining > 0 && (
        <button
          style={{ width: '100%', marginTop: 12, fontSize: 13 }}
          onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
        >
          이전 회차 더 보기 ({remaining}건)
        </button>
      )}
    </>
  );
}
