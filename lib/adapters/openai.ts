// lib/adapters/openai.ts

import type { EngineAdapter, AdapterResponse } from '../types';

/**
 * OpenAI (ChatGPT) API 어댑터
 *
 * ⚠️ 중요: gpt-4o-search-preview는 일반 gpt-4o와 다른 "검색 전용 모델"이다.
 * 공식 문서에 따르면 이 모델은 질문에 답하기 전에 "항상(consistently)" 웹 정보를
 * 먼저 가져온다. Anthropic처럼 검색 여부를 모델이 판단하는 구조가 아니라서,
 * tool_choice 같은 강제 옵션이 필요 없다.
 *
 * ⚠️ 확인 필요(추정): 이 모델이 일반 ChatGPT 웹 UI 사용자가 겪는 검색 경험과
 * 완전히 같은지는 불확실하다. API 전용 검색 모델이라 실제 서비스와 미묘하게
 * 다를 가능성이 있음 — "API ≠ 웹 제품"이라는 기존 원칙이 여기도 적용됨.
 */

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-5-search-api';

interface Annotation {
  type: string;
  url_citation?: {
    url: string;
    title?: string;
  };
}

export const openaiAdapter: EngineAdapter = {
  engineName: 'chatgpt',

  async ask(query: string): Promise<AdapterResponse> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY 환경변수가 설정되지 않았습니다.');
    }

    const timestamp = new Date().toISOString();

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        web_search_options: {}, // 빈 객체만 넣어도 검색 기능이 켜짐
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
        `OpenAI API 오류 (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();

    // OpenAI 응답 구조:
    // data.choices[0].message.content = 답변 텍스트
    // data.choices[0].message.annotations = [{ type: 'url_citation', url_citation: { url, title } }, ...]
    const rawText = data.choices?.[0]?.message?.content ?? '';
    const annotations: Annotation[] = data.choices?.[0]?.message?.annotations ?? [];

    const citations: string[] = annotations
      .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
      .map((a) => a.url_citation!.url);

    const modelUsed: string = data.model ?? MODEL;

    return {
      engine: 'chatgpt',
      query,
      rawText,
      citations,
      timestamp,
      model: modelUsed,
      searchPerformed: true, // gpt-5-search-api는 검색 전용 모델이라 항상 검색함
    };
  },
};