'use client';

import { useState } from 'react';

/**
 * "좋은 자리 질문 만드는 법" 모달(브랜드 현 위치, 2026-09-03). 팁 박스
 * 하단 버튼의 목적지 — components/MemoryTipsModal.tsx(브랜드 인지 화면)와
 * 완전히 같은 구조, 콘텐츠만 다르다.
 *
 * 콘텐츠는 브랜드와 무관하게 고정 — DB 저장 대상 아님, 코드 상수로 관리
 * (원본: docs/prototypes/ensl_brand_position.html의 #tips-modal).
 */

const TIPS = [
  {
    title: '고객이 실제로 묻는 말로 쓰기',
    desc: "'임플란트 의료기관 경쟁력'보다 '강서구에서 임플란트 잘하는 치과는?'처럼 실제 대화에서 사용할 법한 문장이 좋아요.",
  },
  {
    title: '한 질문에는 하나의 상황만 담기',
    desc: "'가격이 합리적이고 야간 진료도 하며 임플란트도 잘하는 치과'처럼 여러 조건을 한꺼번에 넣으면 무엇 때문에 등장했는지 해석하기 어려워요.",
  },
  {
    title: '넓은 질문과 구체적인 질문을 함께 보기',
    desc: "'강서구 치과 추천해줘'처럼 넓은 질문과 '자체 기공소가 있는 임플란트 치과는?'처럼 구체적인 질문을 함께 관찰하면 브랜드가 어느 범위에서 강한지 확인할 수 있어요.",
  },
  {
    title: '질문 안에 브랜드 이름을 넣지 않기',
    desc: "'365서울원탑치과는 임플란트를 잘해?'는 브랜드에 대한 인지를 묻는 질문이에요. 자리 질문은 브랜드 이름 없이 물어야, 실제 추천 상황에서 등장하는지 확인할 수 있어요.",
  },
] as const;

export function PositionTipsModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="tip-btn" onClick={() => setOpen(true)}>
        좋은 자리 질문 만드는 법 <span className="tip-arrow">↗</span>
      </button>

      {open && (
        <div
          className="tips-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="tips-modal-box" role="dialog" aria-modal="true" aria-label="좋은 자리 질문은 어떻게 만들까?">
            <div className="tips-modal-header">
              <div className="tips-modal-header-left">
                <span className="modal-mark">
                  <i className="ti ti-bulb" />
                </span>
                <h2>좋은 자리 질문은 어떻게 만들까?</h2>
              </div>
              <button className="tips-modal-close" onClick={() => setOpen(false)} aria-label="닫기">
                ✕
              </button>
            </div>

            {TIPS.map((tip, i) => (
              <div
                className="modal-tip"
                key={tip.title}
                style={i === TIPS.length - 1 ? { marginBottom: 20 } : undefined}
              >
                <span className="mt-num">{i + 1}</span>
                <div>
                  <p className="mt-title">{tip.title}</p>
                  <p className="mt-desc">{tip.desc}</p>
                </div>
              </div>
            ))}

            <div className="modal-closing">
              <span className="mc-icon">
                <i className="ti ti-refresh" />
              </span>
              <div>
                <p className="mc-title">같은 질문을 유지해야 변화가 보여요</p>
                <p className="mc-desc">
                  진단마다 질문을 바꾸면 이전 결과와 직접 비교하기 어려워요. 질문을 수정했다면{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>새로운 비교 기준으로 기록</strong>하고,
                  같은 조건으로 다시 관찰해야 해요.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
