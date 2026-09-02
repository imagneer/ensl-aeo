import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';
import type { EngineBreakdownRow } from '@/lib/query-detail';

function engineLabel(engine: string): string {
  return ENGINE_CONFIG[engine as EngineName]?.label ?? engine;
}

/**
 * "AI마다 얼마나 다른가" 섹션(질문상세, Day21). unit='등장'이면 자리 질문
 * (관측 횟수 기준), unit='응답'이면 인지 질문(관측 일수 기준) — 판단은
 * lib/query-detail.ts에서 이미 끝났고 여기는 단위 문구만 다르게 표시한다.
 */
export function EngineBreakdownGrid({
  rows,
  unit,
}: {
  rows: EngineBreakdownRow[];
  unit: '등장' | '응답';
}) {
  if (rows.length === 0) {
    return <p className="es-text">이 기간엔 관측 기록이 없어요.</p>;
  }

  const countUnit = unit === '등장' ? '회' : '일';

  return (
    <div className="engine-grid">
      {rows.map((r) => {
        const pct = Math.round(r.rate * 100);
        return (
          <div className="engine-cell" key={r.engine}>
            <p className="en">{engineLabel(r.engine)}</p>
            <p className={`er${pct === 0 ? ' zero' : ''}`}>{pct}%</p>
            <p className="ec">
              {r.total}{countUnit} 중 {r.success}{countUnit} {unit}
            </p>
          </div>
        );
      })}
    </div>
  );
}
