'use client';

import { useState } from 'react';

/**
 * "무엇을 근거로 판단했을까?" 섹션(Day21). 판단(응답일수 계산, 유효 응답
 * 기준, 대표 근거 선정)은 전부 데이터 레이어(lib/supabase.ts
 * fetchQuestionEvidenceSummary)에서 끝났다 — 여기는 결과를 그대로 그린다.
 *
 * ⚠️ "전체 답변과 출처 보기" 링크(프로토타입 원본에 있음)는 이번엔 뺐다 —
 * 그 링크가 가리키는 질문·답변 상세 페이지가 아직 Next.js 쪽에 없어서,
 * 존재하지 않는 곳으로 가는 버튼을 보여주는 게 더 정직하지 않다고 판단
 * (2026-09-02, 코난 판단 — 그 페이지가 만들어지면 이 자리에 다시 붙일 것).
 * 마찬가지 이유로 "출처: ..." 줄도 뺐다 — snapshots에는 출처 URL이 없고
 * (mentions 테이블에 있음), 이번 작업지시서 범위가 "snapshots/queries
 * 조회만"으로 명시돼 있어서 mentions 조인은 별도 작업으로 미룸.
 */

export interface QuestionEvidenceRow {
  queryId: string;
  queryText: string;
  respondedDays: number;
  totalDays: number;
  respondedEngineLabels: string[];
  representative: { engineLabel: string; dateLabel: string; excerpt: string } | null;
}

function EvidenceRow({ row }: { row: QuestionEvidenceRow }) {
  const [open, setOpen] = useState(false);
  const ratio = row.totalDays > 0 ? row.respondedDays / row.totalDays : 0;
  const isHigh = ratio >= 0.7; // 루아 확정(2026-09-02): 70% 이상 초록, 미만 노랑

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
          </div>
        ) : (
          <p className="note">이 기간엔 유효 응답이 없었어요.</p>
        )}
      </div>
    </div>
  );
}

export function QuestionEvidenceSection({ rows }: { rows: QuestionEvidenceRow[] }) {
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
            <EvidenceRow key={row.queryId} row={row} />
          ))}
        </div>
      )}
    </>
  );
}
