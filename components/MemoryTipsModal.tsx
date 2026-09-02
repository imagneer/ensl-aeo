'use client';

import { useState } from 'react';

/**
 * "AI의 기억 다루는 법" 모달(Day21). 팁 박스 하단 버튼의 목적지 —
 * 별도 페이지가 아니라 모달이라는 게 프로토타입 확인으로 밝혀져서(이전엔
 * "갈 곳 없는 링크"로 판단해 버튼 자체를 뺐었음), 라우팅 없이 여기서
 * 바로 구현한다.
 *
 * 콘텐츠는 브랜드와 무관하게 고정 — DB 저장 대상 아님, 코드 상수로 관리
 * (작업지시서 2번 명시).
 */

const TIPS = [
  {
    title: '핵심 표현 맞추기',
    desc: '홈페이지에서는 "자체 기공소", 블로그에서는 "기공 시스템", 보도자료에서는 "인하우스 랩"이라고 쓰면 하나의 특징으로 안정적으로 반복되지 않을 수 있어요. 기억되고 싶은 표현 하나를 정해서 어디서나 같은 말로 쓰세요.',
  },
  {
    title: '확인 가능한 사실 남기기',
    desc: '"최고의 임플란트"는 AI가 인용하기 어려운 주장이에요. "원내 기공소에서 보철물을 직접 제작"처럼 확인 가능한 사실이 답변에 실려요.',
  },
  {
    title: '채널별 소개 정리하기',
    desc: 'AI마다 답변에 사용하는 출처가 다를 수 있어요. 채널마다 소개 문구가 다르면 AI별 기억도 따로 갈라질 수 있으니, 홈페이지·플레이스·보도자료의 브랜드 소개를 한 번 맞춰보세요.',
  },
  {
    title: '상반된 표현의 우선순위 정하기',
    desc: '"종합 치과"와 "임플란트 전문"을 동시에 강조하면 AI마다 다른 쪽을 골라 기억해요. 둘 중 무엇이 먼저 떠오르길 원하는지 정하고, 나머지는 뒤에 놓으세요.',
  },
] as const;

export function MemoryTipsModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="tip-btn" onClick={() => setOpen(true)}>
        AI의 기억 다루는 법 <span className="tip-arrow">↗</span>
      </button>

      {open && (
        <div
          className="tips-modal-overlay"
          onClick={(e) => {
            // 바깥(오버레이 자체) 클릭일 때만 닫는다 — 박스 안 클릭은
            // target이 박스나 그 자식이라 currentTarget(오버레이)과 달라서
            // 안 닫힌다(프로토타입 tips-modal의 onclick 판정 그대로).
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="tips-modal-box" role="dialog" aria-modal="true" aria-label="AI의 기억 다루는 법">
            <div className="tips-modal-header">
              <div className="tips-modal-header-left">
                <span className="modal-mark">
                  <i className="ti ti-bulb" />
                </span>
                <h2>AI의 기억 다루는 법</h2>
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
                <i className="ti ti-clock-play" />
              </span>
              <div>
                <p className="mc-title">바꾼 효과는 다음 진단에서 확인돼요</p>
                <p className="mc-desc">
                  AI가 새 정보를 반영하는 데는 시간이 걸려요. 진단 질문은 그대로 두고 브랜드가
                  남기는 정보만 바꿔야,{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>
                    변화 추이에서 무엇 때문에 달라졌는지 비교할 수 있어요.
                  </strong>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
