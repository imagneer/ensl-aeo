// lib/query-detail.ts

/**
 * 질문상세 화면(Day21, /query/[id]) — 순수 계산 로직만 모아둔 파일.
 * DB 접근은 전부 lib/supabase.ts의 fetchQuerySnapshotsWithMentions
 * 한 번으로 끝내고, 이 파일의 함수들은 그 결과 배열을 입력으로 받아
 * 5개 섹션(상단 통계·엔진별 그리드·매트릭스·함께 등장한 브랜드·근거 카드)에
 * 필요한 값을 각각 파생시킨다 — "판단 로직을 화면 컴포넌트에 넣지 않기"
 * 원칙(2026-08-31 합의)에 따라 여기서 전부 끝내고 컴포넌트는 표시만 한다.
 *
 * ⚠️ query_type('인지'|'자리')에 따라 같은 섹션도 단위가 다르다 — 자리는
 * "관측 횟수"(run) 기준, 인지는 "관측 일수"(day) 기준. 이건 Day21
 * 질문별근거 섹션에서 이미 확정된 단위(날짜 단위)를 인지 쪽에 그대로
 * 맞춘 것 — 화면마다 다른 단위를 쓰면 같은 데이터가 다른 숫자로 보이는
 * 정합성 문제가 생기기 때문(2026-09-02, 루아 확인 사항과 같은 원칙).
 *
 * "유효 관측" 정의는 프로젝트 전체와 동일: status='success' &&
 * search_performed=true (lib/aggregator.ts 규칙 C).
 */

import { executedAtToKstDate, type QuerySnapshotRecord } from './supabase';
import { ENGINE_NAMES } from './engine-config';

export function isValidRecord(r: QuerySnapshotRecord): boolean {
  return r.status === 'success' && r.searchPerformed === true;
}

function enginesAttempted(records: QuerySnapshotRecord[]): string[] {
  return ENGINE_NAMES.filter((e) => records.some((r) => r.engine === e));
}

// ── 3-1 상단 통계 ──

export interface AppearanceHeaderStats {
  kind: 'appearance';
  rate: number;
  totalValidRuns: number;
  appearedRuns: number;
  engineCount: number;
}

export interface ResponseHeaderStats {
  kind: 'response';
  rate: number;
  totalDays: number;
  respondedDays: number;
  engineCount: number;
}

export type HeaderStats = AppearanceHeaderStats | ResponseHeaderStats;

/** 자리 질문 — "등장률 75% · 24회 관측 중 18회 등장 · AI 5개에서 확인" */
export function computeAppearanceHeaderStats(records: QuerySnapshotRecord[]): AppearanceHeaderStats {
  const valid = records.filter(isValidRecord);
  const appeared = valid.filter((r) => r.mentions.some((m) => m.isTarget));
  const engines = new Set(valid.map((r) => r.engine));
  return {
    kind: 'appearance',
    totalValidRuns: valid.length,
    appearedRuns: appeared.length,
    rate: valid.length > 0 ? appeared.length / valid.length : 0,
    engineCount: engines.size,
  };
}

/** 인지 질문 — "응답률 71% · N일 중 M일 응답 · AI 5개에서 확인" */
export function computeResponseHeaderStats(
  records: QuerySnapshotRecord[],
  totalDiagnosisDays: number
): ResponseHeaderStats {
  const valid = records.filter(isValidRecord);
  const days = new Set(valid.map((r) => executedAtToKstDate(r.executedAt)));
  const engines = new Set(valid.map((r) => r.engine));
  return {
    kind: 'response',
    totalDays: totalDiagnosisDays,
    respondedDays: days.size,
    rate: totalDiagnosisDays > 0 ? days.size / totalDiagnosisDays : 0,
    engineCount: engines.size,
  };
}

// ── 3-3 "AI마다 얼마나 다른가" ──

export interface EngineBreakdownRow {
  engine: string;
  rate: number;
  /** 자리: 유효 관측 횟수(분모) / 인지: 진단 전체 일수(분모) */
  total: number;
  /** 자리: 등장 횟수(분자) / 인지: 응답일수(분자) */
  success: number;
}

/**
 * 이 질문 기간에 한 번이라도 시도(성공이든 실패든)된 엔진만 그리드에 넣는다
 * — 시도 자체가 아예 없었던 엔진(0/0)까지 넣으면 "0%"와 구분이 안 되고,
 * 시도했지만 매번 실패한 엔진은 반대로 "0%"로 정직하게 보여주는 게 맞다
 * (안 보인다고 곧바로 실패로 규정하지 않되, 시도한 건 시도한 대로 보여줌).
 */
export function computeEngineAppearance(records: QuerySnapshotRecord[]): EngineBreakdownRow[] {
  return enginesAttempted(records).map((engine) => {
    const valid = records.filter(isValidRecord).filter((r) => r.engine === engine);
    const appeared = valid.filter((r) => r.mentions.some((m) => m.isTarget));
    return {
      engine,
      total: valid.length,
      success: appeared.length,
      rate: valid.length > 0 ? appeared.length / valid.length : 0,
    };
  });
}

export function computeEngineResponse(
  records: QuerySnapshotRecord[],
  totalDiagnosisDays: number
): EngineBreakdownRow[] {
  return enginesAttempted(records).map((engine) => {
    const valid = records.filter(isValidRecord).filter((r) => r.engine === engine);
    const days = new Set(valid.map((r) => executedAtToKstDate(r.executedAt)));
    return {
      engine,
      total: totalDiagnosisDays,
      success: days.size,
      rate: totalDiagnosisDays > 0 ? days.size / totalDiagnosisDays : 0,
    };
  });
}

// ── 3-4 "언제 등장했나" 매트릭스 ──

export type MatrixCellState = 'yes' | 'no' | 'na';

export interface MatrixRow {
  engine: string;
  cells: MatrixCellState[];
}

export interface MatrixResult {
  /** KST 'YYYY-MM-DD', 오름차순 — 진단 시작일부터 diagnosisDurationDays일. */
  dates: string[];
  rows: MatrixRow[];
}

/**
 * 셀 판정(2026-09-02 확정):
 *  - na: 그 날 그 엔진의 관측 자체가 없거나(시도 안 함), 시도했지만
 *    유효하지 않음(실패 또는 search_performed 불충족) — "신뢰할 관측 없음"을
 *    하나로 묶는다. 실패를 "등장 안 함"(no)으로 잘못 표시하면 거짓
 *    음성이 되기 때문(실패와 무등장은 다른 사실).
 *  - 인지: 유효 응답이 있으면 그 자체로 yes(질문마다 "등장" 개념이 없음).
 *  - 자리: 유효 응답 중 타겟 브랜드 멘션이 있으면 yes, 없으면 no.
 */
export function computeMatrix(
  records: QuerySnapshotRecord[],
  diagnosisStartedAt: string,
  totalDiagnosisDays: number,
  queryType: '인지' | '자리'
): MatrixResult {
  const dates: string[] = [];
  const start = new Date(`${diagnosisStartedAt}T00:00:00Z`);
  for (let i = 0; i < totalDiagnosisDays; i++) {
    dates.push(new Date(start.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }

  const engines = enginesAttempted(records);
  const rows: MatrixRow[] = engines.map((engine) => {
    const cells = dates.map((date): MatrixCellState => {
      const matching = records.filter(
        (r) => r.engine === engine && executedAtToKstDate(r.executedAt) === date
      );
      if (matching.length === 0) return 'na';
      const valid = matching.filter(isValidRecord);
      if (valid.length === 0) return 'na';
      if (queryType === '인지') return 'yes';
      return valid.some((r) => r.mentions.some((m) => m.isTarget)) ? 'yes' : 'no';
    });
    return { engine, cells };
  });

  return { dates, rows };
}

// ── 3-2 "함께 등장한 브랜드" (자리 질문 전용) ──

export interface CompetitorBrandRow {
  key: string;
  name: string;
  isTarget: boolean;
  appearedRuns: number;
  rate: number;
}

/**
 * (2026-09-02, 루아 확인) 미등록 브랜드(brand_id=null)도 brand_name_raw
 * 기준으로 포함한다 — parser.ts의 normalizeClinicName이 "치과의원/치과병원
 * → 치과" 정도는 이미 표기를 통일해주지만, 그 밖의 표기 흔들림(띄어쓰기,
 * 약칭 등)까지 정리해주진 않는다는 걸 알고 포함하기로 한 선택.
 */
export function computeCompetitorBrands(
  records: QuerySnapshotRecord[],
  brandNameById: Map<string, string>
): CompetitorBrandRow[] {
  const valid = records.filter(isValidRecord);
  const totalValidRuns = valid.length;
  if (totalValidRuns === 0) return [];

  const counts = new Map<string, { name: string; isTarget: boolean; count: number }>();
  for (const r of valid) {
    const seenInThisSnapshot = new Set<string>(); // 같은 관측에서 같은 브랜드 중복 집계 방지(방어적)
    for (const m of r.mentions) {
      const key = m.brandId ?? `raw:${m.brandNameRaw}`;
      if (seenInThisSnapshot.has(key)) continue;
      seenInThisSnapshot.add(key);
      const name = m.brandId ? (brandNameById.get(m.brandId) ?? m.brandNameRaw) : m.brandNameRaw;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { name, isTarget: m.isTarget, count: 1 });
    }
  }

  return Array.from(counts.values())
    .map((v) => ({
      key: v.name,
      name: v.name,
      isTarget: v.isTarget,
      appearedRuns: v.count,
      rate: v.count / totalValidRuns,
    }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * 등장률 상위 N개만 화면에 보여주되(2026-09-02 확정, N=3), 타겟 브랜드는
 * 순위와 무관하게 항상 포함한다 — 이 화면의 목적 자체가 "우리 브랜드가
 * 어디에 있는지" 확인이라, 타겟이 3위 밖으로 밀려도 자기 비교 기준을
 * 안 보여줄 순 없다고 판단(작업지시서에 명시는 없음, 코난 판단).
 */
export function selectTopCompetitors(rows: CompetitorBrandRow[], limit = 3): CompetitorBrandRow[] {
  const target = rows.find((r) => r.isTarget);
  const others = rows.filter((r) => !r.isTarget);
  const result: CompetitorBrandRow[] = target ? [target] : [];
  for (const o of others) {
    if (result.length >= limit) break;
    result.push(o);
  }
  return result.sort((a, b) => b.rate - a.rate);
}
