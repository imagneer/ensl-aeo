'use client';

import { useState } from 'react';

/**
 * "확인된 추세와 일시적 흔들림 구분하는 법" 모달(변화 추이 화면, Day23 V1.1).
 * components/PositionTipsModal.tsx·MemoryTipsModal.tsx와 완전히 같은 구조 —
 * 콘텐츠는 브랜드와 무관하게 고정(원본: docs/prototypes/ensl_trend_screen.html
 * #tips-modal), DB 저장 대상 아님.
 */

const TIPS = [
  {
    title: '방향이 며칠간 유지되는지 보기',
    desc: '하루 오르고 다음 날 내리는 건 흔들림이에요. 같은 방향이 최소 며칠 이상 이어지는지부터 확인하세요.',
  },
  {
    title: '여러 AI에서 반복되는지 보기',
    desc: '특정 AI 한 곳에서만 튄 값이라면, 그 AI의 그날그날 응답 차이일 가능성이 커요. 다른 AI에서도 같은 변화가 보이는지 확인하세요.',
  },
  {
    title: '튄 지점의 실제 답변을 먼저 열어보기',
    desc: '숫자만 보지 말고 그래프의 점을 눌러 그날 실제로 어떤 답변이 나왔는지 확인하세요. 우연히 겹친 문구인지, 근거가 있는 변화인지 구분할 수 있어요.',
  },
  {
    title: '다음 진단에서도 같은 방향인지 확인하기',
    desc: '한 번의 7일 관측만으로는 확정하기 어려운 변화도 있어요. 다음 진단에서도 같은 흐름이 이어지면 그때 확인된 추세로 올릴 수 있어요.',
  },
] as const;

export function TrendTipsModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="tip-btn" onClick={() => setOpen(true)}>
        확인된 추세와 일시적 흔들림 구분하는 법 <span className="tip-arrow">↗</span>
      </button>
      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(26,26,24,0.4)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            style={{
              background: 'var(--surface-2)',
              borderRadius: 12,
              maxWidth: 520,
              width: '100%',
              maxHeight: '80vh',
              overflowY: 'auto',
              padding: 28,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="modal-mark">
                  <i className="ti ti-bulb" />
                </span>
                <h2 style={{ fontSize: 19, fontWeight: 500, margin: 0 }}>확인된 추세는 어떻게 가려낼까?</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                style={{ border: 'none', padding: 4, fontSize: 18, lineHeight: 1, color: 'var(--text-muted)' }}
              >
                ✕
              </button>
            </div>

            {TIPS.map((tip, i) => (
              <div className="modal-tip" key={tip.title} style={i === TIPS.length - 1 ? { marginBottom: 20 } : undefined}>
                <span className="mt-num">{i + 1}</span>
                <div>
                  <p className="mt-title">{tip.title}</p>
                  <p className="mt-desc">{tip.desc}</p>
                </div>
              </div>
            ))}

            <div className="modal-closing">
              <span className="mc-icon">
                <i className="ti ti-repeat" />
              </span>
              <div>
                <p className="mc-title">질문이 같아야 추세를 비교할 수 있어요</p>
                <p className="mc-desc">
                  진단마다 질문이 달라지면 이번 흐름과 다음 흐름을 같은 기준으로 겹쳐볼 수 없어요.{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>같은 질문·같은 AI 구성을 유지</strong>해야 진짜
                  추세인지 판단할 수 있어요.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
