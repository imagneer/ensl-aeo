'use client';

import { useState } from 'react';

/**
 * "무엇을 근거로 판단했을까?" 섹션(Day21). 판단(응답일수 계산, 유효 응답
 * 기준, 대표 근거 선정)은 전부 데이터 레이어(lib/supabase.ts
 * fetchQuestionEvidenceSummary)에서 끝났다 — 여기는 결과를 그대로 그린다.
 *
 * "전체 답변과 출처 보기" 링크는 질문상세 화면(/query/[id], Day21 후속
 * 작업지시서)이 생기면서 연결했다 — 그 전까진 존재하지 않는 페이지로
 * 가는 버튼이라 일부러 안 넣어뒀었다(2026-09-02). "출처: ..." 줄은
 * 여전히 이 섹션엔 없다 — 이제 그 정보는 질문상세 화면에 있으니, 여기서
 * 중복으로 보여줄 필요가 없다고 판단.
 */

export interface QuestionEvidenceRow {
  queryId: string;
  queryText: string;
  respondedDays: number;
  totalDays: number;
  respondedEngineLabels: string[];
  representative: { engineLabel: string; dateLabel: string; excerpt: string } | null;
}

function EvidenceRow({ row, brandId }: { row: QuestionEvidenceRow; brandId: string | null }) {
  const [open, setOpen] = useState(false);
  const ratio = row.totalDays > 0 ? row.respondedDays / row.totalDays : 0;
  const isHigh = ratio >= 0.7; // 루아 확정(2026-09-02): 70% 이상 초록, 미만 노랑
  const detailHref = `/query/${row.queryId}${brandId ? `?brand=${brandId}` : ''}`;

  return (
    <div className="list-row">
      <div className="row-main">
        <div className="row-left">
          <span className="row-name">&quot;{row.queryText}&quot;</span>
        </div>
        <div className="row-right">
          <span className={`rep-tag ${isHigh ? 'in-headline' : 'possible'}`}>
            {row.totalDays}일 중 {row.respondedDays}일 응답
          </span>
          <button
            className="row-toggle"
            aria-label="근거 보기"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <i className={`ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`} />
          </button>
        </div>
      </div>
      <div className="row-panel" hidden={!open}>
        {row.respondedEngineLabels.length > 0 && (
          <p className="ci-note" style={{ margin: '0 0 8px' }}>
            {row.respondedEngineLabels.join(' · ')}에서 응답
          </p>
        )}
        {row.representative ? (
          <div className="evidence-box">
            <p className="src">
              실제 근거 · {row.representative.engineLabel} · {row.representative.dateLabel}
            </p>
            <p className="quote">&quot;{row.representative.excerpt}&quot;</p>
            <a href={detailHref} className="expand-btn" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              전체 답변과 출처 보기 ↗
            </a>
          </div>
        ) : (
          <p className="note">이 기간엔 유효 응답이 없었어요.</p>
        )}
      </div>
    </div>
  );
}

export function QuestionEvidenceSection({
  rows,
  brandId,
}: {
  rows: QuestionEvidenceRow[];
  brandId?: string;
}) {
  return (
    <>
      <h2 className="section-title" style={{ marginBottom: 4, marginTop: 40 }}>
        무엇을 근거로 판단했을까?
      </h2>
      <p className="section-sub">
        위 결론의 바탕이 된 인지 질문 {rows.length}개예요. 항목을 열면 어떤 AI가 답했는지와 실제
        답변이 나와요.
      </p>
      {rows.length === 0 ? (
        <p className="es-text">아직 근거로 쓸 질문이 없어요.</p>
      ) : (
        <div className="full-list" style={{ marginBottom: 40 }}>
          {rows.map((row) => (
            <EvidenceRow key={row.queryId} row={row} brandId={brandId ?? null} />
          ))}
        </div>
      )}
    </>
  );
}
