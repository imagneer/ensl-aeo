// lib/diagnosis-display-state.ts

/**
 * 대시보드 표시 상태 — 단일 진실 소스
 * (작업지시서_사람검증_인프라_2026-09-08 §5-1)
 *
 * 왜 이 파일이 생겼나 (2026-09-08):
 *   "수집 중"과 "검토 대기"는 서로 다른 상태인데, 처음 구현에서 후자를
 *   Day20의 기존 "진단중" UI로 재활용했다. 그 결과 완료된 진단(9/1~9/7)에
 *   대고 "AI가 아직 관측 중이에요 / 관측 8일째 (최소 3일 필요)"라는
 *   자기모순 문구가 클라이언트에게 떴고, 문장 자리만 가려야 할 것이
 *   화면 전체(특징 목록·AI 일치도 등 관측 층까지)를 가렸다.
 *   → 상태를 먼저 정의하지 않고 기존 UI를 재사용해서 생긴 문제라,
 *     상태 판정을 여기 한 곳에만 두고 화면들이 이걸 import해서 쓴다.
 *
 * ⚠️ 두 축을 헷갈리지 말 것 (지시서 §3-1 vs §5-1):
 *   - 이 파일: **진단/문장 표시** 상태 (화면이 무엇을 보여줄지)
 *   - review_items.status: **개별 검토 항목** 상태 (승인 워크플로)
 *   전자는 후자로부터 파생되지만 같은 것이 아니다.
 */

export type DiagnosisDisplayState =
  | 'collecting' // 1. 수집 중 — diagnoses.status='collecting'
  | 'preparing' // 2. 분석 준비 중 — 완료됐는데 해당 item_type의 review_items 행이 없음(생성 실패/대기)
  | 'pendingReview' // 3. 검토 대기 — review_items 있고 pending(반려 후 재생성 포함)
  | 'reviewed' // 4. 검토 완료 — approved
  | 'manualNeeded'; // 5. 수동 처리 필요 — 회차 상한 초과로 rejected인 채 후속 재생성이 없음

/** 재생성 회차 상한 (지시서 §4). 이 횟수를 넘기면 자동 재생성을 멈추고 수동 처리로 넘긴다. */
export const MAX_GENERATION_ROUNDS = 3;

/**
 * 문장 하나(item_type 하나)의 표시 상태.
 *
 * @param diagnosisStatus diagnoses.status
 * @param reviewItemStatus 그 item_type의 **최신 회차** review_items.status.
 *   행 자체가 없으면 null. 'rejected'가 최신 회차라는 건 뒤이은 재생성 행이
 *   없다는 뜻이므로(=상한 초과) 수동 처리 대상으로 본다.
 */
export function getDiagnosisDisplayState(
  diagnosisStatus: string,
  reviewItemStatus: 'pending' | 'approved' | 'rejected' | null
): DiagnosisDisplayState {
  if (diagnosisStatus !== 'completed') return 'collecting';
  if (reviewItemStatus === null) return 'preparing';
  if (reviewItemStatus === 'approved') return 'reviewed';
  if (reviewItemStatus === 'rejected') return 'manualNeeded';
  return 'pendingReview';
}

/**
 * 헤더 라벨은 문장 단위가 아니라 **진단(브랜드) 단위**다(지시서 §5-1 마지막 항목) —
 * 한 브랜드 안에 승인된 문장과 대기 중인 문장이 섞일 수 있으므로, 화면 전체를
 * 대표하는 상태를 따로 계산한다. 하나라도 검토가 안 끝났으면 "검토 중"으로 본다.
 */
export function aggregateHeaderState(
  diagnosisStatus: string,
  itemStates: DiagnosisDisplayState[]
): DiagnosisDisplayState {
  if (diagnosisStatus !== 'completed') return 'collecting';
  if (itemStates.length === 0) return 'preparing';
  if (itemStates.some((s) => s === 'preparing')) return 'preparing';
  if (itemStates.some((s) => s === 'pendingReview')) return 'pendingReview';
  // 상태 5(수동 처리 필요)는 클라이언트 헤더에선 4와 구분하지 않는다(§5-1 표).
  return 'reviewed';
}

/**
 * 상단바 라벨.
 *
 * ⚠️ 일수 카운터는 7에서 멈추고, 완료된 진단에는 "N일차" 문구 자체를 안 쓴다
 * (지시서 §5-1 필수 수정 사항) — "8일째 (최소 3일 필요)" 같은 자기모순 문구가
 * 나오던 원인이 이 규칙이 없었기 때문이다.
 */
export function getDiagnosisHeaderLabel(
  state: DiagnosisDisplayState,
  dayCount: number,
  totalDays = 7
): string {
  switch (state) {
    case 'collecting':
      return `진단 ${Math.min(Math.max(dayCount, 1), totalDays)}일차 · ${totalDays}일 중`;
    case 'preparing':
      return '진단 완료 · 분석 준비 중';
    case 'pendingReview':
      return '진단 완료 · 검토 중';
    case 'reviewed':
    case 'manualNeeded':
      return '진단 완료';
  }
}

/**
 * editor/viewer(클라이언트)에게 문장 자리에 대신 보여줄 문구.
 * null이면 그 상태에선 자리표시자를 쓰지 않는다(수집 중은 기존 Day20 UI 유지,
 * 검토 완료는 실제 문장을 보여줌).
 *
 * ⚠️ 상태 5(수동 처리 필요)는 클라이언트에게 상태 3과 똑같이 보인다 — 내부
 * 처리 사정을 클라이언트에게 노출하지 않기 위함(§5-1 표).
 */
export function getClientPlaceholderText(state: DiagnosisDisplayState): string | null {
  switch (state) {
    case 'preparing':
      return '분석을 준비하고 있어요';
    case 'pendingReview':
    case 'manualNeeded':
      return '분석 검토 중';
    case 'collecting':
    case 'reviewed':
      return null;
  }
}
