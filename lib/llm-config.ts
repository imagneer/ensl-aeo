// lib/llm-config.ts

/**
 * 여러 파일이 공통으로 쓰는 Anthropic API 연결 정보를 한 곳에 모은다.
 *
 * 왜 필요해졌는가 (2026-08-18, Day 12):
 *   lib/adapters/anthropic.ts(수집용)와 lib/keyword-extractor.ts(분석용)가
 *   모델명·API 버전·URL을 각자 따로 하드코딩하려던 참이었다. 이 값들은
 *   "가끔 바뀌는" 값이다 — 특히 모델명은 Anthropic이 새 모델을 내면 업그레이드
 *   해야 하는데, 두 곳에 따로 있으면 한쪽만 고치고 한쪽을 깜빡할 위험이 있다.
 *   틀려도 에러가 안 나고 그냥 조용히 예전 모델을 계속 쓰게 되는 게 문제다
 *   (CLAUDE.md "실패를 조용히 삼키지 않는다" 원칙과 같은 종류의 위험).
 *
 * ⚠️ 부채: lib/adapters/anthropic.ts는 아직 이 파일을 안 보고 자기 값을 따로
 *    들고 있다. Day 12 작업과 무관한 파일이라 이번엔 안 건드리고, 새로 만드는
 *    keyword-extractor.ts만 이 설정을 쓰게 한다. anthropic.ts를 옮기는 건
 *    별도 커밋으로 — 지금은 이 파일이 "새 진실"이고 anthropic.ts는 아직
 *    "옛 사본"인 과도기 상태다.
 */

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 브랜드 한 줄 합성(묶기·문장작성·자동검수, 2026-09-01)용 모델.
 * 최종 사용자가 보는 문장을 만드는 단계라, 단순 표현 추출(Haiku)보다
 * 더 강한 모델을 쓰기로 루아와 확인함.
 */
export const ANTHROPIC_MODEL_SONNET = 'claude-sonnet-5';

/**
 * 크론 1회 실행(aggregateAllQueriesForDay)당 LLM 호출 상한 (2026-09-04,
 * 9/3 예산 소진 사고 후속 안전장치 "작업 3"). 배지 임계값(badge-thresholds.ts)과
 * 같은 원칙 — "숫자 하나를 화면/함수마다 따로 정의하지 않는다".
 *
 * 산정 근거: 지금 규모(질문 12개 × 엔진 6개 = 72조합, 브랜드 타겟+경쟁사3 =
 * 조합당 최대 4회)면 정상적인 하루치는 최대 288회다. 400으로 두면 정상
 * 실행은 절대 안 걸리고, 재시도 누적분이 쌓여서 폭주하는 비정상 상황만
 * 걸러낸다. 브랜드·쿼리 수가 늘면 이 숫자도 같이 올려야 한다 — 그 전에는
 * 이 상수에 걸려서 실행이 중단되는 게 정상 동작이다.
 */
export const MAX_LLM_CALLS_PER_RUN = 400;

/**
 * dry-run 비용 추정용 대략치 (2026-09-04, 예산 사고 후속 안전장치 "작업 3").
 *
 * ⚠️ 이 값은 "최근 실측 평균"이 아니라 **역산 추정치**다 — lib/llm-usage.ts의
 * 구조화 로그는 Vercel 로그 스트림에만 남고 조회 가능한 곳(DB 등)에 아직
 * 저장 안 해서(작업지시서의 llm_calls 표는 이번엔 선택 항목이라 스킵함,
 * 2026-09-04 코난 판단), "최근 평균"을 코드가 직접 계산할 방법이 없다.
 * 대신 9/3 사고 조사 때 실제 저장된 문단으로 역산한 값(500~3,300자 프롬프트,
 * 평균 약 900 입력 토큰)을 그대로 썼다. llm_calls 표가 생기면 그 실측
 * 평균으로 교체할 것 — 그 전까지 dry-run 추정치는 "대략의 자릿수"로만 믿을 것.
 */
export const ESTIMATED_TOKENS_PER_KEYWORD_CALL = { input: 900, output: 150 } as const;

/** Haiku 4.5 공식 단가($/1M 토큰, 2026-09 기준) — dry-run 비용 추정에만 쓴다. */
export const HAIKU_PRICE_PER_MILLION_TOKENS = { input: 1.0, output: 5.0 } as const;