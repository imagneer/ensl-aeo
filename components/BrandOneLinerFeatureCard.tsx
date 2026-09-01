'use client';

import { useState } from 'react';
import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';
import type { EvidenceItem } from '@/lib/supabase';

interface Props {
  label: string;
  coverage: { questions: number; engines: number; days: number };
  totalQuestions: number;
  totalEngines: number;
  totalDays: number;
  isRepresentative: boolean;
  evidence: EvidenceItem[];
}

function engineLabel(engine: string): string {
  return ENGINE_CONFIG[engine as EngineName]?.label ?? engine;
}

/**
 * 특징 카드 1개 — 클릭하면 근거(brand_expressions 원문)가 펼쳐진다.
 * 근거는 서버에서 이미 다 불러와 props로 받는다(펼칠 때 다시 조회 안 함) —
 * 화면 전체가 하나의 요청으로 서버 렌더되는 이 프로젝트 구조에서, 클릭할
 * 때마다 새로 fetch하는 것보다 이미 있는 데이터를 접었다 펼치는 쪽이 더
 * 단순하고 빠르다.
 */
export function BrandOneLinerFeatureCard({
  label,
  coverage,
  totalQuestions,
  totalEngines,
  totalDays,
  isRepresentative,
  evidence,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="list-row">
      <div className="row-main">
        <div className="row-left">
          <div className="row-title">
            <span className="row-name">{label}</span>
            {isRepresentative && <span className="rep-tag in-headline">브랜드 한 줄에 반영됨</span>}
          </div>
          <p className="row-stat">
            질문 {totalQuestions}개 중 {coverage.questions}개 · AI {totalEngines}개 중 {coverage.engines}개(유효 관측 기준)
            · {totalDays}일 중 {coverage.days}일
          </p>
        </div>
        <div className="row-right">
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
        {evidence.length === 0 ? (
          <p className="note">근거를 불러오지 못했습니다.</p>
        ) : (
          evidence.map((e) => (
            <div key={e.id} className="evidence-box">
              <p className="src">
                &quot;{e.queryText}&quot; · {engineLabel(e.engine)} · {e.observedDate}
              </p>
              <p className="quote">&quot;{e.sourceSentence}&quot;</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
