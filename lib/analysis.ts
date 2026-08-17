// lib/analysis.ts

/**
 * 분석 로직 (Day 11) — 이미 집계된 데이터(aggregated_metrics)를 가지고
 * 추가로 계산하는 지표를 담는다.
 *
 * aggregator.ts와 책임을 분리하는 이유(CLAUDE.md "어댑터의 책임" 원칙과 같은 이유):
 *   aggregator.ts는 "원시 관측치를 모아서 저장한다"는 책임만 진다.
 *   이 파일은 "이미 저장된(또는 저장 직전) 집계 데이터를 가지고 또 다른 값을
 *   유도한다"는 책임을 진다. 두 책임을 한 파일에 섞으면, 나중에 분석 지표가
 *   늘어날 때마다 aggregator.ts가 계속 커져서 "집계"와 "분석"의 경계가 흐려진다.
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (2026-08-17 루아 확인, Day 11)
 * ─────────────────────────────────────────────────────────
 *  A. shareOfVoice = target.mentionCount / (target.mentionCount + competitorData의
 *     모든 mentionCount 합). "전체"는 등록된 브랜드(타겟+경쟁사)들의 총 언급량이지,
 *     AI 답변에 실제 등장하는 모든 브랜드(미등록 포함) 기준이 아니다.
 *     ⚠️ 클라이언트에게: "추적 중인 경쟁사 대비 우리 브랜드 언급 비중"이라고는
 *     말할 수 있다. "AI 답변에 등장하는 모든 병원 중 우리 비중"이라고는 말하면 안 된다.
 *
 *  B. grain은 aggregated_metrics 1행(쿼리·엔진·기간·aggregation_level 조합)과
 *     동일하다. 여러 쿼리를 합친 "포트폴리오 전체 SOV"는 이 함수의 범위 밖이다.
 *
 *  C. DB에 저장하지 않는다. mentionCount + competitorData로 100% 유도 가능한
 *     값이라 중복 저장하지 않고, 읽을 때마다 계산한다.
 *
 *  D. 분모(target.mentionCount + 경쟁사 mentionCount 합)가 0이면 null을 돌려준다.
 *     "0%(아무도 언급 안 됐는데 우리 비중만 0)"과 "계산 불가(비교 자체가 성립
 *     안 함)"는 다른 사실이라 0으로 채우면 안 된다.
 *
 * ⚠️ 엣지케이스: 등록된 경쟁사가 하나도 없으면(competitorData가 null이거나 빈
 *    객체) 분모에 타겟 것만 남아서, 언급만 되면 SOV가 항상 100%로 나온다. 이건
 *    "시장 점유율 100%"가 아니라 "비교 대상이 없다"는 뜻이다. 이 함수를 호출하는
 *    쪽(API·대시보드)이 competitorData가 비어있는 경우를 구분해서 표시해야 한다 —
 *    이 함수 자체는 그 구분을 하지 않고 계산된 숫자만 돌려준다.
 *
 * ⚠️ 입력 타입: AggregatedMetricToSave는 aggregator.ts가 DB에 저장하기 "직전"에
 *    만드는 camelCase 형태다. 나중에 대시보드가 DB에서 이미 저장된 행을 다시
 *    읽어와서(snake_case로) 이 함수에 넣으려면, supabase.ts에 그 형태를 이
 *    타입으로 매핑해주는 조회 함수가 따로 필요하다 — 이번 범위에는 없음.
 *
 *  F. (2026-08-17 실측 발견, 루아 확인) 위 엣지케이스는 "경쟁사 미등록"뿐 아니라
 *     "경쟁사는 등록돼 있는데 이 라운드엔 하나도 안 나옴"에서도 똑같이 100%로
 *     찍힌다. 실측 20행 중 3행(15%)이 이 케이스였다 — 드문 일이 아니다.
 *     그래서 shareOfVoice 하나만으론 "진짜 우세"와 "무경쟁 라운드"를 구분할 수
 *     없다. computeShareOfVoice의 반환 타입(숫자 하나)은 그대로 두고, 구분이
 *     필요한 호출부가 같이 쓸 수 있도록 competitorParticipation()을 별도 함수로
 *     추가한다 — 한 함수 이름이 "비율 하나"보다 많은 걸 돌려주면 이름이 내용을
 *     못 따라가게 되므로(CLAUDE.md 절대원칙 1) 합쳐서 반환하지 않는다.
 */

import type { AggregatedMetricToSave } from './supabase';

/**
 * 등록된 브랜드(타겟+경쟁사) 안에서 타겟 브랜드가 차지하는 언급 비중을 계산한다.
 *
 * @param metric aggregator.ts가 만든(또는 저장 직전 형태와 동일한) 집계 행 하나
 * @returns 0~1 사이 비율. 분모가 0이면 null (규칙 D)
 */
export function computeShareOfVoice(metric: AggregatedMetricToSave): number | null {
  const competitorMentionTotal = metric.competitorData
    ? Object.values(metric.competitorData).reduce((sum, c) => sum + c.mentionCount, 0)
    : 0;

  const denominator = metric.mentionCount + competitorMentionTotal;

  // 규칙 D: 분모 0 → 계산 불가. 0으로 채우지 않는다.
  if (denominator === 0) return null;

  return metric.mentionCount / denominator;
}

/**
 * 이 라운드에 등록된 경쟁사가 몇 곳이고, 그중 몇 곳이 실제로 언급됐는지 (규칙 F).
 *
 * shareOfVoice가 100%로 나왔을 때, registered와 appeared를 같이 보면
 * "경쟁사 3곳 다 나왔는데 우리가 이김"(registered=3, appeared=3)인지
 * "경쟁사가 이 라운드엔 하나도 안 나옴"(registered=3, appeared=0)인지 구분된다.
 *
 * @param metric aggregator.ts가 만든(또는 저장 직전 형태와 동일한) 집계 행 하나
 */
export function competitorParticipation(
  metric: AggregatedMetricToSave
): { registered: number; appeared: number } {
  if (!metric.competitorData) return { registered: 0, appeared: 0 };

  const competitors = Object.values(metric.competitorData);
  return {
    registered: competitors.length,
    appeared: competitors.filter((c) => c.mentionCount > 0).length,
  };
}
