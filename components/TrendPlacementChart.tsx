'use client';

import { useState } from 'react';

/**
 * 변화 추이 화면(Day23) — "자리 질문, 이번 주 흐름" 그래프.
 * docs/prototypes/ensl_trend_screen.html의 chartB를 그대로 옮기되, 데이터는
 * 전부 서버(app/(dashboard)/trend/page.tsx)에서 계산해 props로 받는다 —
 * 이 컴포넌트는 "어떤 선을 켜고 끌지"(범례 체크박스)만 상태로 갖는다.
 *
 * ⚠️ 프로토타입에는 그래프 점을 누르면 그날의 실제 답변 근거가 뜨는
 * 기능이 있는데, 이번 조립 단계에서는 아직 안 넣었다(2026-09-14) —
 * 아코디언 상세 패널에 초반/후반 실제 답변을 이미 보여주고 있어서
 * "결론 먼저, 클릭 2번 안에 실제 답변까지" 원칙은 만족하지만, 그래프
 * 점 단위 근거는 별도 작업으로 남겨뒀다.
 */

export interface TrendChartSeries {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
  /** 하루 노출률(0~1). 판정 불가(그날 관측 자체가 없음)면 null — 선을 끊는다. */
  points: (number | null)[];
}

const CHART_WIDTH = 700;
const CHART_LEFT = 44;
const CHART_RIGHT = 656;
const CHART_TOP = 16;
const CHART_BOTTOM = 176;
const CHART_HEIGHT = 200;

function xForIndex(index: number, count: number): number {
  if (count <= 1) return CHART_LEFT;
  return CHART_LEFT + (index * (CHART_RIGHT - CHART_LEFT)) / (count - 1);
}

function yForValue(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return CHART_BOTTOM - clamped * (CHART_BOTTOM - CHART_TOP);
}

/** null(판정 불가)로 끊긴 구간은 각각 별도 polyline으로 그린다 — 이어 그리면
 *  "못 쟀다"가 "그 사이 값을 부드럽게 이었다"처럼 보여서 오독을 만든다. */
function buildSegments(points: (number | null)[]): { x: number; y: number }[][] {
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  points.forEach((value, i) => {
    if (value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: xForIndex(i, points.length), y: yForValue(value) });
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

export function TrendPlacementChart({
  dayLabels,
  series,
}: {
  dayLabels: string[];
  series: TrendChartSeries[];
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="chart-card">
      <div className="chart-legend">
        {series.map((s) => (
          <label
            key={s.key}
            className={`leg-item${hidden.has(s.key) ? ' off' : ''}`}
            onClick={() => toggle(s.key)}
          >
            <span className="leg-swatch" style={{ background: s.color }} />
            {s.label}
          </label>
        ))}
      </div>
      <div className="chart-svg-wrap">
        <svg width={CHART_WIDTH} height={CHART_HEIGHT} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}>
          <line className="gridline" x1={CHART_LEFT} y1={CHART_TOP} x2={CHART_RIGHT} y2={CHART_TOP} />
          <line
            className="gridline"
            x1={CHART_LEFT}
            y1={(CHART_TOP + CHART_BOTTOM) / 2}
            x2={CHART_RIGHT}
            y2={(CHART_TOP + CHART_BOTTOM) / 2}
          />
          <line className="gridline" x1={CHART_LEFT} y1={CHART_BOTTOM} x2={CHART_RIGHT} y2={CHART_BOTTOM} />
          <text className="axis-label" x={10} y={CHART_TOP + 4}>100%</text>
          <text className="axis-label" x={18} y={(CHART_TOP + CHART_BOTTOM) / 2 + 4}>50%</text>
          <text className="axis-label" x={22} y={CHART_BOTTOM + 4}>0%</text>

          {series.map((s) => {
            if (hidden.has(s.key)) return null;
            const segments = buildSegments(s.points);
            return (
              <g key={s.key}>
                {segments.map((seg, segIdx) => (
                  <polyline
                    key={segIdx}
                    className="chart-line"
                    stroke={s.color}
                    strokeDasharray={s.dashed ? '4 3' : undefined}
                    points={seg.map((p) => `${p.x},${p.y}`).join(' ')}
                  />
                ))}
                {s.points.map((value, i) =>
                  value === null ? null : (
                    <circle
                      key={i}
                      className="chart-point"
                      cx={xForIndex(i, s.points.length)}
                      cy={yForValue(value)}
                      r={4}
                      fill={s.color}
                    />
                  )
                )}
              </g>
            );
          })}

          {dayLabels.map((label, i) => (
            <text key={label} className="day-label" x={xForIndex(i, dayLabels.length) - 14} y={196}>
              {label}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
