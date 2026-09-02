import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';
import type { MatrixResult, MatrixCellState } from '@/lib/query-detail';

function engineLabel(engine: string): string {
  return ENGINE_CONFIG[engine as EngineName]?.label ?? engine;
}

function formatDateLabel(dateKST: string): string {
  const [, m, d] = dateKST.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

const CELL_SYMBOL: Record<MatrixCellState, string> = { yes: '✓', no: '−', na: '·' };

/**
 * "언제 등장했나" 매트릭스(질문상세, Day21). 셀 의미는 query_type에 따라
 * 다르다 — 자리는 3가지 상태(등장/관측했지만 미등장/미관측), 인지는
 * 2가지(응답/미응답)만 존재한다(lib/query-detail.ts computeMatrix 참고 —
 * 인지는 'no' 상태를 아예 안 만든다).
 *
 * ⚠️ 셀 클릭 시 근거 카드로 스크롤 이동하는 인터랙션(프로토타입에 있던
 * 기능)은 이번엔 안 넣었다 — 작업지시서 완료 기준(5번)에 없고, 근거
 * 목록이 "더 보기" 방식이라 클릭한 날짜의 카드가 아직 안 펼쳐져 있을 수
 * 있어 스크롤이 빈 곳으로 갈 수 있음(코난 판단, 2026-09-02).
 */
export function AppearanceMatrix({
  matrix,
  queryType,
}: {
  matrix: MatrixResult;
  queryType: '인지' | '자리';
}) {
  if (matrix.rows.length === 0) {
    return <p className="es-text">이 기간엔 관측 기록이 없어요.</p>;
  }

  const counts: Record<MatrixCellState, number> = { yes: 0, no: 0, na: 0 };
  for (const row of matrix.rows) {
    for (const cell of row.cells) counts[cell]++;
  }

  return (
    <>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="eng" />
              {matrix.dates.map((d) => (
                <th key={d}>{formatDateLabel(d)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.engine}>
                <th className="eng">{engineLabel(row.engine)}</th>
                {row.cells.map((cell, i) => (
                  <td key={i}>
                    <span className={`cell ${cell}`}>{CELL_SYMBOL[cell]}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="legend">
        <span>
          <span className="swatch" style={{ background: 'var(--bg-success)' }} />
          {queryType === '자리' ? `등장함 (${counts.yes}회)` : `응답함 (${counts.yes}일)`}
        </span>
        {queryType === '자리' && (
          <span>
            <span className="swatch" style={{ background: 'var(--surface-1)' }} />
            관측했지만 등장 안 함 ({counts.no}회)
          </span>
        )}
        <span>
          <span className="swatch" style={{ border: '0.5px solid var(--border-strong)' }} />
          이 날은 신뢰할 관측이 없음 ({counts.na}{queryType === '자리' ? '회' : '일'})
        </span>
      </div>
    </>
  );
}
