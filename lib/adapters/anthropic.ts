// lib/adapters/anthropic.ts

import { normalizeUrl, getCitedUrls, extractDomain } from '../types';
import type {
  EngineAdapter,
  AdapterResponse,
  RetrievedSource,
  CitedSpan,
} from '../types';

/**
 * Anthropic (Claude) API 어댑터 — 웹검색 기능 활성화 버전
 *
 * ⚠️ 비용 안내: 웹검색은 1,000회당 $10 + 검색 결과에 대한 토큰 비용이 별도로 붙는다.
 * 이 프로젝트 측정 스케줄(하루 30회 기준)로는 월 약 $9 추가 예상 (2026-08-07 기준 계산,
 * 실제 토큰 비용까지 합치면 이보다 조금 더 나올 수 있음 — 추정치).
 *
 * ⚠️ 중요한 특성: Claude는 검색 여부를 "스스로 판단"한다. tools에 web_search를
 * 쥐여줬다고 매번 검색하는 게 아니라, "이 질문에 검색이 필요한가"를 판단해서
 * 결정한다. 그래서 이 어댑터는 tool_choice로 검색을 강제한다.
 *
 * ⚠️ 텍스트 필터링 한계 (2026-08-07 실측 후 추가):
 * Claude가 검색 전에 "검색해드리겠습니다" 같은 안내 멘트를 text 블록으로 남기는
 * 경우가 있어, 이를 제외하기 위해 "마지막 web_search_tool_result 이후의 text만
 * 사용"하는 규칙을 적용함. 단, 검색을 여러 번 반복하며 중간 코멘트를 남기는
 * 경우까지는 완벽히 걸러내지 못함 (아직 실측된 적 없는 케이스, 발견 시 재검토 필요).
 *
 * ───────────────────────────────────────────────────────────
 * "본 것"과 "사용한 것"을 가르는 방법 (Day 8, 2026-08-17 실측 기준)
 * ───────────────────────────────────────────────────────────
 * Claude 응답에는 출처가 두 군데에 따로 들어온다. 둘은 의미가 완전히 다르다.
 *
 *   1) 본 것(retrieved) = `web_search_tool_result` 블록의 content 배열
 *      → 검색 엔진이 돌려준 "후보 목록"일 뿐, 답변에 반영됐다는 보장이 없다.
 *
 *   2) 사용한 것(cited)  = 각 `text` 블록에 붙은 `citations` 배열
 *      (`type: "web_search_result_location"`)
 *      → "이 블록의 문장은 이 출처를 근거로 썼다"는 Claude 자신의 표시다.
 *
 * 이전 버전은 1)만 읽어서 `citations` 필드에 넣었다. 그래서 "검색해서 봤을 뿐인
 * 페이지"가 "답변 근거로 쓰인 페이지"로 집계됐다.
 * (2026-08-17 실측: 본 것 8개 중 실제로 사용된 고유 출처는 5개 — 3개는 답변에
 *  전혀 반영되지 않았는데도 출처로 잡히고 있었다)
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * text 블록들을 rawText로 이을 때 쓰는 구분자.
 * ⚠️ 이 값은 citedSpans의 오프셋 계산에도 그대로 쓰이므로, 여기 한 곳에서만
 *    정의한다. rawText 쪽만 바꾸고 오프셋 쪽을 안 바꾸면 좌표가 통째로 밀린다.
 */
const BLOCK_JOIN = '\n';

/** text 블록에 붙는 인용 정보 = "사용한 것" */
interface TextBlockCitation {
  type: string;
  url?: string;
  title?: string;
  /**
   * ⚠️ 함정: `cited_text`는 **출처 웹페이지 쪽의 원문 발췌**이지 Claude 답변
   *    텍스트가 아니다. (2026-08-17 실측 확인: 블록 text는
   *    "네이버 방문자 리뷰 기준으로 강서구에서 가장 많은 리뷰(5,052건)를 받은 치과"인데
   *     cited_text는 "네이버 방문자 리뷰 기준으로는 이편한세상치과의원 화곡점(5,052건)이
   *     가장 많습니다."로 서로 다른 문자열이었다)
   *    따라서 이 값을 rawText에서 indexOf로 찾아 답변 구간 좌표를 만들면 안 된다.
   *    대부분 못 찾고, 우연히 찾으면 엉뚱한 위치를 가리킨다.
   */
  cited_text?: string;
  /** 출처 내부 위치를 가리키는 불투명 토큰. 답변 좌표와는 무관하므로 쓰지 않는다. */
  encrypted_index?: string;
}

/** web_search_tool_result 안의 검색 결과 1건 = "본 것" */
interface SearchResultItem {
  type: string;
  url?: string;
  title?: string;
  page_age?: string | null;
  /** 암호화된 본문. 사람이 읽을 수 있는 미리보기가 아니므로 snippet으로 쓸 수 없다. */
  encrypted_content?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  /** text 블록에만 존재. 근거 없이 쓴 문장에는 아예 없다(undefined). */
  citations?: TextBlockCitation[];
  /**
   * web_search_tool_result 블록의 내용.
   * ⚠️ 검색이 실패하면 배열이 아니라 에러 객체가 온다
   *    (예: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }).
   *    그래서 아래 코드는 반드시 Array.isArray로 확인하고 접근한다.
   */
  content?: SearchResultItem[] | { type: string; error_code?: string };
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

    // ── 1) 본 것(retrieved) ──────────────────────────────────
    // Claude는 검색 후보 목록을 항상 제공하므로 null이 아니다.
    // (null은 "엔진이 후보 목록 자체를 안 준다"는 뜻이고 ChatGPT만 해당된다.
    //  검색이 실패해 0건이면 여기서는 빈 배열이 된다 — 둘의 뜻이 다르니 섞지 말 것)
    //
    // ⚠️ 같은 URL이 두 번 이상 나오면 1건으로 합친다. 검색을 여러 번 하면
    //    같은 페이지가 여러 검색 결과에 중복으로 들어오는데, 그걸 그대로 세면
    //    "본 것 개수"가 실제 후보 페이지 수보다 부풀려진다.
    //    (합치는 기준은 정규화 URL. 원본 URL은 rawUrl에 먼저 나온 것을 보존한다)
    const retrievedByUrl = new Map<string, RetrievedSource>();
    for (const block of blocks) {
      if (block.type !== 'web_search_tool_result') continue;
      if (!Array.isArray(block.content)) continue; // 검색 실패 시 에러 객체가 온다

      for (const item of block.content) {
        if (!item.url) continue;

        const url = normalizeUrl(item.url);
        if (retrievedByUrl.has(url)) continue;

        retrievedByUrl.set(url, {
          url,
          rawUrl: item.url, // 정규화 전 원본 보존 (http, www, 추적 파라미터 포함)
          domain: extractDomain(item.url),
          ...(item.title ? { title: item.title } : {}),
          // snippet은 담지 않는다. Claude가 주는 encrypted_content는 암호화된
          // 값이라 사람이 읽을 수 있는 미리보기가 아니다 (2026-08-17 실측 확인).
        });
      }
    }
    const retrievedSources: RetrievedSource[] = Array.from(retrievedByUrl.values());

    // ── 2) 답변 본문 블록 고르기 ─────────────────────────────
    // 마지막 검색 결과 블록의 위치를 찾음 (그 이후 text만 "진짜 답변"으로 간주)
    const lastSearchResultIndex = blocks
      .map((block, idx) => (block.type === 'web_search_tool_result' ? idx : -1))
      .filter((idx) => idx !== -1)
      .pop() ?? -1;

    const textBlocks =
      lastSearchResultIndex === -1
        ? blocks // 검색 결과가 없으면(검색 안 한 케이스) 전체 text 블록 사용
        : blocks.filter((_, idx) => idx > lastSearchResultIndex);

    // rawText에 실제로 들어가는 블록 목록.
    // ⚠️ 이 배열이 rawText와 citedSpans 좌표의 **단일 진실 소스**다.
    //    예전처럼 rawText를 만드는 filter와 좌표를 세는 filter를 따로 두면
    //    둘 중 하나만 조건이 바뀌었을 때 좌표가 조용히 어긋난다.
    const answerBlocks = textBlocks.filter(
      (block) => block.type === 'text' && block.text
    );

    const rawText = answerBlocks.map((block) => block.text).join(BLOCK_JOIN);

    // ── 3) 사용한 것(cited) — 구간별 출처 ────────────────────
    // ⚠️ Claude는 답변 텍스트 안의 글자 인덱스를 주지 않는다. 알 수 있는 건
    //    "이 text 블록 전체가 이 출처를 근거로 한다"까지다. 그래서 precision은
    //    'block'이고, 구간은 블록 경계와 정확히 일치한다.
    //    문장 단위로 브랜드↔출처를 연결하려는 로직은 이 값을 반드시 확인해야 한다.
    //    (블록이 길면 그 안의 여러 문장이 통째로 같은 출처에 묶이므로,
    //     'exact'와 똑같이 취급하면 관련 없는 브랜드까지 그 출처에 붙는다)
    //
    // ⚠️ 좌표 기준은 원본 응답이 아니라 **join으로 만들어진 rawText**다.
    //    위에서 안내 멘트 블록을 잘라냈기 때문에 원본 순서의 인덱스를 쓰면 어긋난다.
    //    그래서 answerBlocks를 순회하며 오프셋을 직접 누적하고,
    //    join에 들어간 BLOCK_JOIN 길이도 같이 더한다.
    const citedSpans: CitedSpan[] = [];
    let offset = 0;

    for (const block of answerBlocks) {
      const text = block.text as string; // answerBlocks 필터에서 이미 보장됨
      const startIndex = offset;
      const endIndex = startIndex + text.length;

      // 다음 블록의 시작 위치 = 이번 블록 끝 + 구분자 길이.
      // (마지막 블록 뒤에는 구분자가 없지만, 루프가 끝나므로 더해도 영향 없음)
      offset = endIndex + BLOCK_JOIN.length;

      // citations가 없는 text 블록은 구간을 만들지 않는다.
      // 이건 "근거 없이 쓰인 문장"이라는 뜻이고, 그 자체가 의미 있는 정보다.
      // (2026-08-17 실측: 답변 15개 블록 중 8개에 citations가 없었다. 대부분은
      //  "입니다.", "합니다." 같은 연결 어미나 제목·목차 줄이지만, 출처 없이
      //  단정하는 문장이 섞여 있을 수 있으므로 "출처 있는 구간의 총 길이 ÷ rawText 길이"
      //  같은 지표를 나중에 볼 수 있게 일부러 채우지 않고 비워둔다)
      if (!Array.isArray(block.citations) || block.citations.length === 0) continue;

      // 한 블록이 여러 출처를 근거로 들 수 있어서 sourceUrls는 배열이다.
      // 같은 블록 안에서 같은 URL이 두 번 나오면 1개로 합친다. Claude는 같은
      // 페이지의 서로 다른 문장을 각각 인용하면서 같은 url을 반복해서 붙인다.
      // (2026-08-17 실측: citations 항목이 2개 붙은 블록이 있었는데 둘 다 같은
      //  onetopdental.com/implant/total-implant였다 → 합쳐서 출처 1개로 셌다.
      //  안 합치면 "이 구간이 2개 출처를 근거로 했다"는 틀린 값이 된다)
      // Claude는 실제 주소를 주므로 도메인을 주소에서 뽑는다
      const uniqueUrls = Array.from(
        new Set(
          block.citations
            .filter((c) => c.type === 'web_search_result_location' && c.url)
            .map((c) => normalizeUrl(c.url as string))
        )
      );

      if (uniqueUrls.length === 0) continue; // 인용 형식이 다르거나 url이 없으면 좌표를 못 만든다

      citedSpans.push({
        startIndex,
        endIndex,
        sources: uniqueUrls.map((url) => ({ url, domain: extractDomain(url) })),
        precision: 'block',
      });
    }

    // ⚠️⚠️ 의미가 바뀐 필드 (Day 8) ⚠️⚠️
    // `citations`는 예전에 **본 것(검색 후보 목록 전체)**이었다.
    // 이제부터는 **사용한 것(답변에 실제 근거로 붙은 출처)**만 담긴다.
    // 이름은 그대로인데 내용이 바뀌었으므로, 이 필드를 읽는 기존 코드
    // (collector.ts 등)의 숫자가 이전 측정과 달라진다.
    //   - 값이 줄어든다: 2026-08-17 실측 기준 8개 → 5개
    //   - 과거 저장분과 그대로 비교하면 "출처가 줄었다"는 가짜 변화로 보인다.
    //     Day 8 이전 데이터와 이후 데이터는 반드시 구분해서 집계할 것.
    // "본 것"이 필요한 코드는 이 필드가 아니라 retrievedSources를 봐야 한다.
    const citations = getCitedUrls(citedSpans);

    const modelUsed: string = data.model ?? MODEL;

    return {
      engine: 'claude',
      query,
      rawText,
      retrievedSources,
      citedSpans,
      citations,
      timestamp,
      model: modelUsed,
      // tool_choice로 웹검색을 강제했으므로 항상 true.
      // ⚠️ 한계: 검색 도구가 에러를 돌려준 경우(max_uses_exceeded 등)에도 true가 된다.
      //    그때는 retrievedSources가 빈 배열이 되므로, "검색은 했다는데 후보가 0개"인
      //    관측이 보이면 실제로는 검색 실패였을 수 있다. (⚠️ 추정: 이 프로젝트에서
      //    아직 실제 에러 응답을 관측한 적은 없다)
      searchPerformed: true,
      overviewShown: null, // Tier 2 엔진 - 이 개념 자체가 해당 없음
    };
  },
};
