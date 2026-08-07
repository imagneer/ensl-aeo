// lib/adapters/gemini.ts

import type { EngineAdapter, AdapterResponse } from '../types';

/**
 * Google Gemini API 어댑터 — "Grounding with Google Search" 기능 사용
 *
 * ⚠️ 인증 방식이 다른 세 엔진과 다름: 헤더가 아니라 URL 쿼리 파라미터로 API 키 전달.
 * ⚠️ citations 위치도 또 다름: data.candidates[0].groundingMetadata 안에 있음.
 *    정확한 하위 구조는 실측 후 확정 필요 — 1차 시도는 넓게 잡아서 콘솔로 확인.
 * ⚠️ Anthropic처럼 검색 여부를 모델이 판단하는 구조일 수 있음(확인 필요).
 *    이번 첫 테스트에서 검색을 안 하면, Anthropic 때처럼 강제 옵션을 찾아야 함.
 */

const MODEL = 'gemini-3.6-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export const geminiAdapter: EngineAdapter = {
  engineName: 'gemini',

  async ask(query: string): Promise<AdapterResponse> {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY 환경변수가 설정되지 않았습니다.');
    }

    const timestamp = new Date().toISOString();

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: query }],
          },
        ],
        tools: [
          {
            google_search: {},
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Gemini API 오류 (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();

    // 디버깅용: 전체 응답 구조를 한 번 찍어봄 (groundingMetadata 정확한 위치 확인용)
    console.log('=== Gemini 원본 응답 구조 (디버깅) ===');
    console.log(JSON.stringify(data, null, 2));

    const candidate = data.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text ?? '';

    // groundingMetadata에서 citations 추출 시도
    // (grounding chunks 안에 web.uri 형태로 있을 것으로 예상 — 실측으로 확정 필요)
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const citations: string[] = groundingChunks
      .map((chunk: any) => chunk?.web?.uri)
      .filter((uri: string | undefined): uri is string => !!uri);

    const modelUsed: string = MODEL;

    return {
      engine: 'gemini',
      query,
      rawText,
      citations,
      timestamp,
      model: modelUsed,
      searchPerformed: citations.length > 0, // Gemini는 모델이 검색 여부를 스스로 판단하므로 citations 유무로 추정
    };
  },
};