import type { CompetitorBrandRow } from '@/lib/query-detail';

/**
 * "이 질문에서 함께 등장한 브랜드" 섹션(질문상세, 자리 질문 전용, Day21).
 * ⚠️ 프로토타입에 있던 브랜드별 "특징" 서브텍스트(예: "고난도 임플란트 ·
 * 전문의 협진")는 뺐다 — 경쟁사 특징 추출 로직 자체가 아직 없어서
 * (CLAUDE.md 기술부채 트래커에 이미 있는 항목), 이 화면에서 새로 만들지
 * 않았다. 이름과 등장률만 보여준다.
 */
export function CompetitorBrandList({ rows }: { rows: CompetitorBrandRow[] }) {
  if (rows.length === 0) {
    return <p className="es-text">이 질문에서 등장한 브랜드가 아직 없어요.</p>;
  }

  return (
    <>
      {rows.map((r) => (
        <div className="brand-row" key={r.key}>
          <div>
            <p className="nm">
              {r.name} {r.isTarget && <span className="ours">(우리)</span>}
            </p>
          </div>
          <p className={`pc${r.isTarget ? '' : ' sec'}`}>{Math.round(r.rate * 100)}%</p>
        </div>
      ))}
    </>
  );
}
