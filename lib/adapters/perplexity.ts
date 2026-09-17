// lib/adapters/perplexity.ts

import type { EngineAdapter, AdapterResponse, RetrievedSource } from '../types';
import { normalizeUrl, extractDomain } from '../types';

/**
 * Perplexity Agent API 어댑터
 *
 * ⚠️ 2026-09-14 마이그레이션: 옛 Sonar Chat Completions(`/chat/completions`)가
 * 2026-09-27부로 지원 종료되어 Agent API(`POST /v1/agent`)로 전환함.
 * 판정 규칙 결정 기록: docs/claude_day8-decision-citation-linking.md
 * "2026-09-14 갱신" 절. 예산 점검 작업지시서: claude/tasks/done/2026-09-14-budget-check-actions.md
 *
 * `model: 'perplexity/sonar'`로 고정한다(루아 확정, 2026-09-14) — Agent API는
 * `preset` 파라미터를 쓰면 OpenAI/Anthropic/Google 등 다른 회사 모델로 자동
 * 라우팅되는데, 그러면 "Perplexity" 엔진 이름으로 저장되는 데이터가 실제로는
 * 다른 회사 모델의 응답이 되어(실측 확인) 이미 별도 수집 중인 그 엔진 데이터와
 * 사실상 중복·오분류된다(CLAUDE.md 절대원칙 1 위반).
 *
 * 이 엔진의 특징 (2026-09-14 실측 확인, 4회 테스트):
 *   - `output[]` 중 type='search_results'인 항목의 `.results[]`  = 본 것(retrieved)
 *   - `output[]` 중 type='message'인 항목의 `.content[0].text`  = 답변 텍스트
 *
 * ⚠️ **"사용한 것"(cited)을 이 엔진에서 구할 수 없다.** 옛 Sonar는 본문에
 *    `[n]` 인용 마커를 붙여줬는데, `model=perplexity/sonar`로 Agent API를
 *    쓰면 web_search 도구가 정상 작동하고 검색 결과도 정상 수신되는데도
 *    답변 본문에 `[n]` 마커가 4/4 테스트 전부 하나도 없었다. 응답 전체를
 *    재귀 검색해도 대체 필드(`citations`, `annotations` 등)가 없다 —
 *    `annotations`는 항상 빈 배열, `results[].source`는 "web" 고정값일 뿐
 *    실제 인용 여부와 무관. 필드 누락이 아니라 이 모델/API 조합의 구조적
 *    한계로 확인됨(문서에 없던 사실 — "문서보다 실측" 원칙대로 4번 재현해서
 *    확정함). 그래서 citedSpans는 항상 빈 배열, citationTrackingUnavailable을
 *    true로 명시해서 "AI가 근거를 안 댔다"(정상적 개별 관측)와 "이 엔진에서
 *    측정 자체가 불가능하다"(엔진 차원의 구조적 한계)를 섞지 않는다.
 *
 * ⚠️ 이 갭은 Perplexity 서비스 자체의 한계가 아니라 API 경로의 한계로
 *    추정된다 — 실제 perplexity.ai 웹 UI에는 각주가 표시된다. Agent API가
 *    신생 API라 향후 지원이 추가될 수 있으니 수개월 뒤 재확인 권장.
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/v1/agent';

const MODEL = 'perplexity/sonar';

interface AgentSearchResult {
  id?: number;
  url?: string;
  title?: string;
  snippet?: string;
}

interface AgentOutputItem {
  type: string;
  // type === 'search_results'
  results?: AgentSearchResult[];
  // type === 'message'
  content?: Array<{ type: string; text?: string }>;
}

interface AgentResponse {
  status?: string;
  error?: unknown;
  model?: string;
  output?: AgentOutputItem[];
}

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
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: query,
        tools: [{ type: 'web_search' }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Perplexity API 오류 (${response.status}): ${errorBody}`);
    }

    const data: AgentResponse = await response.json();

    // Agent API는 HTTP 200이어도 내부적으로 실패/미완료 상태를 돌려줄 수 있다
    // (에이전틱 API라 비동기 진행 상태 개념이 있음 — 이번엔 항상 동기 완료였지만
    // 방어적으로 확인한다).
    if (data.status && data.status !== 'completed') {
      throw new Error(
        `Perplexity Agent API 미완료 상태 (status=${data.status}): ${JSON.stringify(data.error)}`
      );
    }

    const output = Array.isArray(data.output) ? data.output : [];
    const searchResultsBlock = output.find((o) => o.type === 'search_results');
    const messageBlock = output.find((o) => o.type === 'message');

    const rawText: string =
      messageBlock?.content?.find((c) => c.type === 'output_text')?.text ?? '';
    const modelUsed: string = data.model ?? MODEL;

    // ── 본 것 (retrieved) ──────────────────────────────────────
    // Perplexity는 후보 목록을 항상 제공하므로 null이 아니다.
    // ⚠️ search_results 블록 자체가 없으면(스펙 변경·오류) []가 되는데,
    //    이건 "검색 결과 0건"과 구분되지 않는다. null로 바꾸면 "이 엔진은
    //    후보를 제공 안 함"이라는 다른 거짓말이 되므로 []를 택했다.
    // ⚠️ date/last_updated/source는 RetrievedSource에 자리가 없어 현재 버려진다.
    const rawResults = searchResultsBlock?.results ?? [];

    const retrievedSources: RetrievedSource[] = rawResults
      .filter((item) => typeof item?.url === 'string')
      .map((item) => ({
        url: normalizeUrl(item.url as string),
        rawUrl: item.url as string, // 정규화로 잃는 원본(추적 파라미터 등) 보존
        domain: extractDomain(item.url as string),
        ...(item.title ? { title: item.title } : {}),
        ...(item.snippet ? { snippet: item.snippet } : {}),
      }));

    return {
      engine: 'perplexity',
      query,
      rawText,
      retrievedSources,
      // ── 사용한 것 (cited) ──────────────────────────────────────
      // 위 파일 상단 설명대로 이 엔진에서는 구할 수 없다. 빈 배열 + 명시적
      // 플래그로, "근거 없이 말함"(none)과 "측정 불가"(unavailable)를 구분한다.
      citedSpans: [],
      citationTrackingUnavailable: true,
      citations: [], // @deprecated 필드 — citedSpans에서 파생, 여기선 항상 빈 배열
      timestamp,
      model: modelUsed,
      searchPerformed: true, // Perplexity는 모델 자체가 항상 검색하는 구조
      overviewShown: null, // Tier 2 엔진 - 이 개념 자체가 해당 없음
    };
  },
};
