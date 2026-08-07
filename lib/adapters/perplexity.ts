// lib/adapters/perplexity.ts

import type { EngineAdapter, AdapterResponse } from '../types';

/**
 * Perplexity Sonar API 어댑터
 *
 * Perplexity API는 OpenAI와 동일한 형식(chat completions)을 쓰기 때문에
 * 별도 SDK 없이 fetch만으로 호출 가능.
 * 장점: citations(인용 출처 URL)을 기본 제공.
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

// 사용할 모델 — sonar는 웹 검색을 포함한 응답을 줌
const MODEL = 'sonar';

export const perplexityAdapter: EngineAdapter = {
  engineName: 'perplexity',

  async ask(query: string): Promise<AdapterResponse> {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error('PERPLEXITY_API_KEY 환경변수가 설정되지 않았습니다.');
    }

    const timestamp = new Date().toISOString();

    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: query,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Perplexity API 오류 (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();

    // Perplexity 응답 구조:
    // data.choices[0].message.content = 답변 텍스트
    // data.citations = 인용 출처 URL 배열 (Perplexity 고유 기능)
    const rawText = data.choices?.[0]?.message?.content ?? '';
    const citations: string[] = data.citations ?? [];
    const modelUsed: string = data.model ?? MODEL;

    return {
      engine: 'perplexity',
      query,
      rawText,
      citations,
      timestamp,
      model: modelUsed,
      searchPerformed: true, // Perplexity는 모델 자체가 항상 검색하는 구조
    };
  },
};