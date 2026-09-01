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