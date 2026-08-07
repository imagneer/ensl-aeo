// lib/adapters/anthropic.ts

import type { EngineAdapter, AdapterResponse } from '../types';

/**
 * Anthropic (Claude) API 어댑터 — 웹검색 기능 활성화 버전
 *
 * ⚠️ 비용 안내: 웹검색은 1,000회당 $10 + 검색 결과에 대한 토큰 비용이 별도로 붙는다.
 * 이 프로젝트 측정 스케줄(하루 30회 기준)로는 월 약 $9 추가 예상 (2026-08-07 기준 계산,
 * 실제 토큰 비용까지 합치면 이보다 조금 더 나올 수 있음 — 추정치).
 *
 * ⚠️ 중요한 특성: Claude는 검색 여부를 "스스로 판단"한다. tools에 web_search를
 * 쥐여줬다고 매번 검색하는 게 아니라, "이 질문에 검색이 필요한가"를 판단해서
 * 결정한다.
 *
 * ⚠️ 텍스트 필터링 한계 (2026-08-07 실측 후 추가):
 * Claude가 검색 전에 "검색해드리겠습니다" 같은 안내 멘트를 text 블록으로 남기는
 * 경우가 있어, 이를 제외하기 위해 "마지막 web_search_tool_result 이후의 text만
 * 사용"하는 규칙을 적용함. 단, 검색을 여러 번 반복하며 중간 코멘트를 남기는
 * 경우까지는 완벽히 걸러내지 못함 (아직 실측된 적 없는 케이스, 발견 시 재검토 필요).
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

interface ContentBlock {
  type: string;
  text?: string;
  content?: Array<{
    type: string;
    url?: string;
    title?: string;
  }>;
}

export const anthropicAdapter: EngineAdapter = {
  engineName: 'claude',

  async ask(query: string): Promise<AdapterResponse> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    }

    const timestamp = new Date().toISOString();

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: query,
          },
        ],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
        ],
        // 검색을 "선택"이 아니라 "강제"로 만듦
        tool_choice: {
            type: 'tool',
            name: 'web_search',
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Anthropic API 오류 (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();
    const blocks: ContentBlock[] = data.content ?? [];

    // 마지막 검색 결과 블록의 위치를 찾음 (그 이후 text만 "진짜 답변"으로 간주)
    const lastSearchResultIndex = blocks
      .map((block, idx) => (block.type === 'web_search_tool_result' ? idx : -1))
      .filter((idx) => idx !== -1)
      .pop() ?? -1;

    const textBlocks =
      lastSearchResultIndex === -1
        ? blocks // 검색 결과가 없으면(검색 안 한 케이스) 전체 text 블록 사용
        : blocks.filter((_, idx) => idx > lastSearchResultIndex);

    const rawText = textBlocks
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n');

    const citations: string[] = [];
    for (const block of blocks) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item.url) citations.push(item.url);
        }
      }
    }

    const modelUsed: string = data.model ?? MODEL;

    return {
      engine: 'claude',
      query,
      rawText,
      citations,
      timestamp,
      model: modelUsed,
      searchPerformed: true, // tool_choice로 웹검색을 강제했으므로 항상 true
    };
  },
};