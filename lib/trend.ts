// lib/trend.ts
//
// "변화 추이" 화면(Day23, /trend) — 판정 로직만 모아둔 파일.
// DB 접근은 app/(dashboard)/trend/page.tsx가 lib/supabase.ts로 끝내고,
// 이 파일은 그 결과를 입력으로 받아 파생시킨다 (lib/gap.ts와 같은 구조).
//
// ⚠️ 여기의 "3일 연속 같은 방향" 판정(classifyDailyTrend)은 lib/alerts.ts의
// "3일 연속 미노출"(checkConsecutiveMissDays) 규칙을 일반화한 것이다
// (작업지시서_변화추이화면_2026-09-10_V1.0.md §3, "새 규칙 만들지 말 것" —
// 2026-09-10 루아 확인). 판정 대상이 "미노출 여부"(상태)에서 "상승/하락
// 방향"(전일 대비 비교)으로 바뀌었기 때문에 함수 자체를 그대로 재사용하지는
// 못했다 — 미노출 판정은 그날 값(mentionCount)만 보면 되지만, 방향 판정은
// 반드시 전날과 비교해야 해서 입력 형태가 다르다. 그래서 "daily 집계를
// 최신순으로 훑으며 연속 구간을 센다"는 판정 *방식*만 그대로 가져오고
// 함수는 새로 짰다 — lib/alerts.ts 쪽 함수를 억지로 재사용하면 오히려
// "미노출 판정 함수가 방향까지 판정한다"는 이름-내용 불일치가 생긴다
// (CLAUDE.md 절대 원칙 1번).
//
// "방향이 같다"는 순수 부호(+/-/0)만 본다 — 등락 폭 기준(예: ±5%p 이상만
// 신호로 침)은 일부러 안 넣었다 (2026-09-10 루아 확인, 매니페스토 3원칙
// "계산법 설명 못하는 숫자는 미게시"와도 맞음 — 임계값을 넣으면 "왜 하필
// 5%p인지"를 화면에서 설명해야 하는데 아직 근거가 없다).

import type { StoredDiagnosis } from './supabase';
import { kstDayBoundsUtc, todayKST } from './aggregator';

// ── 진단 차수 ──

/**
 * diagnosesForBrand(시작일 오름차순 전체 목록, lib/supabase.ts
 * fetchDiagnosesForBrand) 안에서 이 진단이 몇 번째인지 찾는다.
 * (Day21 상단바의 "N차 진단" 표시와 동일한 방식 — diagnoses 테이블에
 * 회차 번호 컬럼이 없어서 정렬 순서로 매긴다.)
 *
 * 못 찾으면(정상 상태라면 있을 수 없음 — diagnosis가 diagnosesForBrand
 * 목록에서 빠졌다는 뜻) 1로 방어한다. sequence 계산 실패로 화면 전체가
 * 죽는 것보다, 비교 기준을 "1차 진단"(진단 내 비교)으로 보수적으로
 * 잡는 게 낫다고 판단했다 — 콘솔에는 남긴다.
 */
export function getDiagnosisSequence(
  diagnosisId: string,
  diagnosesForBrand: StoredDiagnosis[]
): number {
  const index = diagnosesForBrand.findIndex((d) => d.id === diagnosisId);
  if (index === -1) {
    console.error(`diagnosesForBrand 목록에서 diagnosisId=${diagnosisId}를 못 찾음`);
    return 1;
  }
  return index + 1;
}

// ── 비교 기준 (작업지시서 §2) ──

export type ComparisonBasis = 'within_diagnosis' | 'diagnosis_over_diagnosis';

export interface TrendComparisonWindow {
  basis: ComparisonBasis;
  basisLabel: string; // 예: "8/19~8/21 → 8/23~8/25 비교 · 같은 진단 안"
  periodA: { label: string; start: string; end: string }; // UTC ISO, end 미포함
  periodB: { label: string; start: string; end: string };
  /** 이번 진단이 아직 진행 중(ended_at=null)이라 periodB가 오늘까지만 채워졌는지 */
  periodBInProgress: boolean;
}

/** 'YYYY-MM-DD'(KST 달력 날짜)에 일수를 더한다. 순수 달력 계산이라 UTC로 취급한다
 *  (lib/supabase.ts fetchExpiredDiagnoses와 같은 이유 — 시간대 변환이 필요 없는
 *  달력 날짜 덧셈에 '+09:00'을 섞으면 자정 근처에서 하루씩 밀리는 함정이 있다). */
function addDaysKST(dateKST: string, days: number): string {
  const d = new Date(`${dateKST}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → "8/19" 형식 (프로토타입 라벨 그대로). */
function formatMD(dateKST: string): string {
  const d = new Date(`${dateKST}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * 비교 기준을 계산한다.
 *  - 1차 진단: 같은 진단 안에서 초반 3일(1~3일차) vs 후반 3일(5~7일차).
 *    4일차는 완충 구간으로 양쪽 다 안 넣는다(프로토타입 원안 그대로) —
 *    딱 절반으로 가르면 "막 변화가 시작된 날"이 양쪽에 걸쳐 비교가 흐려진다.
 *  - 2차 진단부터: 직전 진단 전체(7일) vs 이번 진단 전체(7일).
 *
 * ⚠️ 이번 진단이 진행 중(ended_at=null)이면 periodB의 끝을 오늘(KST)로
 *    둔다 — 아직 7일이 안 채워졌을 수 있어서, 지금까지 쌓인 만큼만 비교
 *    대상으로 삼는다. periodBInProgress=true를 같이 내려주니 화면에서
 *    "진행 중" 표시를 빠뜨리지 말 것(완료된 7일 vs 진행 중 N일을 대등하게
 *    그리면 오독을 만든다).
 */
export function buildComparisonWindow(
  diagnosis: StoredDiagnosis,
  diagnosesForBrand: StoredDiagnosis[]
): TrendComparisonWindow {
  const index = diagnosesForBrand.findIndex((d) => d.id === diagnosis.id);
  const sequence = index === -1 ? 1 : index + 1;

  if (sequence === 1) {
    return buildWithinDiagnosisWindow(diagnosis);
  }

  const previous = diagnosesForBrand[index - 1];
  if (!previous) {
    // 정상 상태라면 sequence>1일 때 직전 회차가 반드시 있어야 한다 — 데이터
    // 이상이므로 남기고, 화면이 죽지 않게 1차 진단 방식으로 폴백한다.
    console.error(
      `진단 차수 ${sequence}(diagnosisId=${diagnosis.id})인데 직전 진단을 못 찾음 — within_diagnosis로 폴백`
    );
    return buildWithinDiagnosisWindow(diagnosis);
  }

  return buildDiagnosisOverDiagnosisWindow(previous, diagnosis);
}

function buildWithinDiagnosisWindow(diagnosis: StoredDiagnosis): TrendComparisonWindow {
  const day1 = diagnosis.startedAt;
  const day3 = addDaysKST(day1, 2);
  const day5 = addDaysKST(day1, 4);
  const day7 = addDaysKST(day1, 6);

  return {
    basis: 'within_diagnosis',
    basisLabel: `${formatMD(day1)}~${formatMD(day3)} → ${formatMD(day5)}~${formatMD(day7)} 비교 · 같은 진단 안 · 질문·AI·관측 조건 동일`,
    periodA: {
      label: '초반(1~3일차)',
      start: kstDayBoundsUtc(day1).periodStart,
      end: kstDayBoundsUtc(day3).periodEnd,
    },
    periodB: {
      label: '후반(5~7일차)',
      start: kstDayBoundsUtc(day5).periodStart,
      end: kstDayBoundsUtc(day7).periodEnd,
    },
    periodBInProgress: false, // 1차 비교는 항상 같은(이미 지난) 진단 안에서만 계산
  };
}

function buildDiagnosisOverDiagnosisWindow(
  previous: StoredDiagnosis,
  current: StoredDiagnosis
): TrendComparisonWindow {
  const previousEnd = previous.endedAt ?? previous.startedAt;
  if (!previous.endedAt) {
    // 직전 진단은 이미 끝났어야 정상(현재 진단이 시작됐다는 것 자체가 그 증거) —
    // 있을 수 없는 상태라 남긴다.
    console.error(`직전 진단(id=${previous.id})의 ended_at이 비어있음`);
  }
  const currentEndDate = current.endedAt ?? todayKST();

  return {
    basis: 'diagnosis_over_diagnosis',
    basisLabel: `직전 진단(${formatMD(previous.startedAt)}~${formatMD(previousEnd)}) → 이번 진단(${formatMD(current.startedAt)}~${formatMD(currentEndDate)}) 비교 · 진단 회차 간 비교`,
    periodA: {
      label: '직전 진단',
      start: kstDayBoundsUtc(previous.startedAt).periodStart,
      end: kstDayBoundsUtc(previousEnd).periodEnd,
    },
    periodB: {
      label: '이번 진단',
      start: kstDayBoundsUtc(current.startedAt).periodStart,
      end: kstDayBoundsUtc(currentEndDate).periodEnd,
    },
    periodBInProgress: current.endedAt === null,
  };
}

// ── 방향 판정 (작업지시서 §3, 이상치 판정 로직) ──

export interface DailyValuePoint {
  periodStart: string; // ISO. 정렬 안 돼 있어도 됨 — 함수 내부에서 최신순 정렬한다
  value: number | null; // 그날 값(예: visibility_rate). 판정 불가(totalRuns=0)면 null
}

export type TrendConfidence = 'confirmed' | 'watching';
export type TrendDirection = 'up' | 'down' | 'unknown';

export interface TrendDirectionResult {
  confidence: TrendConfidence; // 'confirmed' = 확인된 추세, 'watching' = 관찰 중인 신호
  direction: TrendDirection;
  /** 이 방향이 유지된 날짜 수 (연속된 daily 값 기준, 최신 날짜부터 셈) */
  consecutiveDays: number;
}

/**
 * daily 값 시계열에서, 최근 날짜부터 거슬러 올라가며 "전일 대비 부호"가
 * 며칠 연속 같은 방향인지 센다. 3일 이상 연속이면 'confirmed', 아니면
 * 'watching'.
 *
 * 판정 불가(value=null, 보통 totalRuns=0)를 만나거나 날짜 간격이 하루가
 * 아니면(그 사이 행이 통째로 없음) 거기서 연속을 끊는다 —
 * checkConsecutiveMissDays(lib/alerts.ts)와 같은 이유: 못 잰 걸 방향
 * 신호로 세면 수집 인프라 장애를 실제 추세 변화로 오판하게 된다.
 *
 * 전일 대비 값이 완전히 같으면(delta===0) "무변화"로 보고 연속을 끊는다 —
 * 방향이 없는 날을 "이전 방향이 계속되고 있다"고 우기지 않는다.
 */
export function classifyDailyTrend(points: DailyValuePoint[]): TrendDirectionResult {
  const sorted = [...points].sort(
    (a, b) => new Date(b.periodStart).getTime() - new Date(a.periodStart).getTime()
  );

  let consecutiveDays = 0;
  let streakDirection: TrendDirection | null = null;

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const prev = sorted[i + 1]; // 하루 전

    if (current.value === null || prev.value === null) break; // 판정 불가

    const dayGap =
      (new Date(current.periodStart).getTime() - new Date(prev.periodStart).getTime()) /
      (24 * 60 * 60 * 1000);
    if (dayGap !== 1) break; // 그 사이 행이 통째로 없음

    const delta = current.value - prev.value;
    if (delta === 0) break; // 무변화 — 신호 아님

    const direction: TrendDirection = delta > 0 ? 'up' : 'down';

    if (streakDirection === null) {
      streakDirection = direction;
      consecutiveDays = 2; // 이 비교 한 번으로 current·prev 이틀이 같은 방향임을 확인
    } else if (direction === streakDirection) {
      consecutiveDays += 1;
    } else {
      break; // 방향이 바뀜 — 연속 끊김
    }
  }

  if (streakDirection === null) {
    return { confidence: 'watching', direction: 'unknown', consecutiveDays: 0 };
  }

  return {
    confidence: consecutiveDays >= 3 ? 'confirmed' : 'watching',
    direction: streakDirection,
    consecutiveDays,
  };
}
