import type { TipContentData } from '@/lib/supabase';

/**
 * "엔슬의 팁" 박스(Day21) — 항상 100% 노출(작업지시서 3-1 확정 원칙).
 * 데이터 기반 인사이트(tipContent)가 있으면 그걸 템플릿으로 조립하고,
 * 없으면(조건 미충족 or 진단중이라 아직 브랜드 한 줄 자체가 없음) 일반
 * AEO 지식 팁 5개 중 하나를 렌더링 시점에 랜덤으로 고른다 — 저장 대상
 * 아님(작업지시서 3-3), 매 방문마다 달라져도 무방.
 *
 * "AI의 기억 다루는 법" 링크(프로토타입에 있던 .tip-btn)는 목적지
 * 콘텐츠 페이지가 아직 없어서 뺐다 — 갈 곳 없는 링크는 안 만든다.
 */

const GENERIC_TIPS = [
  {
    title: 'AI마다 기억하는 정보량이 다를 수 있어요.',
    desc: 'AI마다 학습 시점·검색 연동 방식이 달라서, 같은 브랜드도 AI별로 아는 정보의 양과 깊이가 갈려요.',
  },
  {
    title: '직접 물어봐야 나오는 정보가 있어요.',
    desc: '"이 브랜드 어때?"처럼 직접 묻는 질문과 "이 지역 좋은 곳 추천해줘"처럼 간접적으로 묻는 질문은, AI가 같은 브랜드를 서로 다른 방식으로 답할 수 있어요.',
  },
  {
    title: 'AI의 기억은 고정돼 있지 않아요.',
    desc: '같은 질문도 AI 모델이 업데이트되거나 검색 결과가 바뀌면 답변이 달라질 수 있어서, 한 번의 관측보다 반복된 관측이 더 믿을 만해요.',
  },
  {
    title: 'AI는 브랜드가 스스로 말한 것만 보지 않아요.',
    desc: '브랜드 홈페이지뿐 아니라 리뷰, 지역 커뮤니티, 제3자 콘텐츠까지 참고해서 답변을 만들어요.',
  },
  {
    title: '짧고 반복되는 표현이 AI 기억에 잘 남아요.',
    desc: '여러 채널에서 같은 표현이 일관되게 반복될수록, AI가 그 표현을 브랜드의 특징으로 더 쉽게 기억해요.',
  },
] as const;

function pickRandomGenericTip() {
  return GENERIC_TIPS[Math.floor(Math.random() * GENERIC_TIPS.length)];
}

export function TipBox({ tipContent }: { tipContent: TipContentData | null }) {
  const title = tipContent
    ? `'${tipContent.wideFeature}'은(는) ${tipContent.n}개 AI 모두가 기억했지만,`
    : null;
  const desc = tipContent
    ? `${tipContent.narrowEngine}은(는) 브랜드 한 줄을 만든 ${tipContent.totalFeatures}개 특징 중 '${tipContent.narrowFeature}'만 언급했어요. 같은 브랜드라도 AI마다 기억하는 정보의 폭은 달라질 수 있어요.`
    : null;

  const generic = tipContent ? null : pickRandomGenericTip();

  return (
    <div className="tip-box">
      <span className="tip-badge">TIP</span>
      <p className="tip-title">{title ?? generic!.title}</p>
      <p className="tip-desc">{desc ?? generic!.desc}</p>
    </div>
  );
}
