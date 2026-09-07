'use client';

import { useState } from 'react';

/**
 * "인지와 추천 사이, 무엇을 점검할까?" 모달(간극 화면, Day22).
 * PositionTipsModal.tsx와 같은 구조, 콘텐츠만 다르다.
 *
 * 작업지시서(Day22_작업지시서_간극화면.md §3-5) 지시대로 3번째 팁만
 * "선택된 이유" → "함께 언급된 특징"으로 바꾸고, 1·2·4번과 마무리 문구는
 * 프로토타입 원문 그대로 유지하기로 했었다(2026-09-04 확정). ⚠️ 그런데
 * 그 "원문 그대로"라는 지시 자체에 금지 언어("선택")가 섞여 있던 걸
 * 2026-09-08 검수에서 재확인 — 1번 팁 설명과 모달 제목의 "선택" 표현을
 * "추천 근거"로 고쳤다(지시서 쪽 오류였고 구현은 지시받은 그대로
 * 정확했음). 2·4번 팁과 마무리 문구("단정하지 않는 것도 판단이에요")는
 * 재확인 결과 문제없어서 그대로 유지.
 */

const TIPS = [
  {
    title: '강점을 뒷받침하는 근거가 있는지 보기',
    desc: 'AI가 특징을 알고 있어도, 추천 답변에서 참고할 구체적인 근거가 부족하면 추천 근거로 연결되지 않을 수 있어요. 해당 특징의 실제 답변과 출처부터 확인해보세요.',
  },
  {
    title: '강점과 고객의 상황이 연결돼 있는지 보기',
    desc: "'전문의 협진 체계'라는 사실만 알리는 것과, 어떤 상황에서 협진이 필요한지 설명하는 것은 달라요. 강점이 고객의 질문과 어떻게 연결되는지 점검해보세요.",
  },
  {
    title: '같은 자리에서 경쟁 브랜드에 함께 언급된 특징 보기',
    desc: '우리 브랜드의 강점만 보지 말고, 같은 질문에서 경쟁 브랜드에 어떤 특징이 함께 언급됐는지 확인하세요. 그 차이가 현재 간극을 이해하는 단서가 될 수 있어요.',
  },
  {
    title: '여러 AI와 날짜에서 반복되는지 보기',
    desc: '한두 번의 답변만으로 간극의 원인을 확정할 수는 없어요. 여러 AI와 날짜에서 같은 현상이 반복되는지 확인한 뒤 판단하세요.',
  },
] as const;

export function GapTipsModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="tip-btn" onClick={() => setOpen(true)}>
        간극이 보일 때 먼저 확인할 것 <span className="tip-arrow">↗</span>
      </button>

      {open && (
        <div
          className="tips-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="tips-modal-box" role="dialog" aria-modal="true" aria-label="인지와 추천 사이, 무엇을 점검할까?">
            <div className="tips-modal-header">
              <div className="tips-modal-header-left">
                <span className="modal-mark">
                  <i className="ti ti-bulb" />
                </span>
                <h2>인지와 추천 사이, 무엇을 점검할까?</h2>
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
                <i className="ti ti-scale" />
              </span>
              <div>
                <p className="mc-title">단정하지 않는 것도 판단이에요</p>
                <p className="mc-desc">
                  현재 관측만으로 이유를 확인하기 어렵다면,{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>엔슬은 원인을 억지로 단정하지 않아요.</strong>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
