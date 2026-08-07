// lib/engine-config.ts

/**
 * 엔진-티어 매핑 상수
 * ─────────────────
 * Tier 1 = 검색엔진 AI (SerpApi로 수집)
 * Tier 2 = 독립형 AI 엔진 (각 사 API 직접 호출)
 *
 * 이 파일이 "이 엔진은 몇 번 티어"의 유일한 진실(single source of truth).
 * 다른 파일에서 티어를 하드코딩하지 말 것.
 */

export const ENGINE_CONFIG = {
  google_aio:        { tier: 1 as const, label: '구글 AI Overviews' },
  naver_ai_briefing: { tier: 1 as const, label: '네이버 AI브리핑' },
  chatgpt:           { tier: 2 as const, label: 'ChatGPT' },
  gemini:            { tier: 2 as const, label: 'Gemini' },
  claude:            { tier: 2 as const, label: 'Claude' },
  perplexity:        { tier: 2 as const, label: 'Perplexity' },
} as const;

// 엔진 이름 타입 — DB의 engine 컬럼에 들어갈 수 있는 값 6개
export type EngineName = keyof typeof ENGINE_CONFIG;

// 전체 엔진 이름 목록 (배열로 꺼내 쓸 때)
export const ENGINE_NAMES = Object.keys(ENGINE_CONFIG) as EngineName[];

// 헬퍼 함수: 엔진 이름 → 티어 번호
export function getEngineTier(engine: EngineName): 1 | 2 {
  return ENGINE_CONFIG[engine].tier;
}