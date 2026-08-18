import type {
    EngineAdapter,
    AdapterResponse,
    RetrievedSource,
    CitedSpan,
    CitedSource,
} from '../types';
import { extractDomain, getCitedUrls } from '../types';

/**
 * 구글 AI Overviews 어댑터 (SerpApi 경유)
 *
 * Tier 1 — 네이버와 같은 계열이지만, 호출 방식이 근본적으로 다르다.
 *
 * ⚠️ 가장 중요한 차이 — 2단계 호출:
 *   구글은 AI Overview를 단독으로 못 부른다. 먼저 일반 검색(engine=google)을
 *   호출해야 한다.
 *     1) 응답에 ai_overview가 바로 들어있으면 → 그걸 쓴다 (호출 1회로 끝)
 *     2) ai_overview.page_token만 있으면(지연 로딩) → 그 토큰으로
 *        engine=google_ai_overview를 즉시 재호출해야 한다.
 *        ⚠️ 토큰은 발급 후 1분 안에 써야 한다(SerpApi 공식 문서).
 *     3) 둘 다 없으면 → 이 쿼리엔 AI Overview가 아예 안 뜬 것(미노출).
 *   즉 측정 1회가 SerpApi 호출 1~2회를 쓴다. 몇 %가 2회까지 가는지는
 *   아직 실측 데이터가 없다 — Day4 비용 계산(월 1,800회 가정)이
 *   낙관적일 수 있다는 뜻이다. 실행하면서 확인해야 할 부분.
 *
 * ⚠️ 참조 번호 기준이 네이버와 다르다:
 *   네이버 references[].index는 1부터 시작했지만, 구글은 0부터 시작한다
 *   (SerpApi 공식 문서 예시로 확인). 다행히 우리 코드는 배열 위치가 아니라
 *   각 참조가 가진 index 값으로 직접 찾는 방식(Map)이라, 이 차이에
 *   영향을 안 받는다 — 어느 쪽 기준이든 그대로 맞는다.
 *
 * ⚠️ 지역/언어 파라미터:
 *   gl=kr(대한민국), hl=ko(한국어)를 명시한다. 안 넣으면 SerpApi 서버의
 *   기본 위치(대개 미국) 기준 결과가 나와, 실제 한국 이용자가 보는
 *   화면과 달라질 수 있다.
 */

const SERPAPI_URL = 'https://serpapi.com/search.json';

/** 구글 references[] 원본 타입 (필요한 필드만) */
interface GoogleReference {
  index: number;
  link: string;
  title?: string;
  source?: string;
}

/**
 * 구글 text_blocks[] 원본 타입.
 * expandable은 안에 text_blocks가 다시 중첩된다 — 재귀적으로 처리해야 한다.
 */
interface GoogleTextBlock {
  type: string;
  snippet?: string;
  title?: string;
  reference_indexes?: number[];
  list?: Array<{
    snippet?: string;
    title?: string;
    reference_indexes?: number[];
    text_blocks?: GoogleTextBlock[]; // 중첩 리스트(예: "1. 세금 조항" 아래 하위 목록)
  }>;
  text_blocks?: GoogleTextBlock[]; // expandable 타입 전용
}
/**
 * text_blocks를 순서대로(재귀적으로) 훑으며 rawText를 조립하고,
 * 동시에 CitedSpan을 만든다. 네이버 버전과 같은 원리 — 위치를
 * "찾지" 않고 "만들면서 기록"하므로 precision은 'exact'다.
 */
function buildRawTextAndSpans(
  textBlocks: GoogleTextBlock[],
  references: GoogleReference[]
): { rawText: string; citedSpans: CitedSpan[] } {
  const refByIndex = new Map<number, GoogleReference>();
  for (const ref of references) refByIndex.set(ref.index, ref);

  const lines: string[] = [];
  const citedSpans: CitedSpan[] = [];
  let cursor = 0;

  function appendLine(snippet: string, refIndexes: number[] | undefined) {
    if (!snippet) return; // 빈 문자열은 줄 자체를 만들지 않는다 (좌표만 어긋남)

    const startIndex = cursor;
    const endIndex = cursor + snippet.length;

    if (refIndexes && refIndexes.length > 0) {
      const sources: CitedSource[] = [];
      for (const idx of refIndexes) {
        const ref = refByIndex.get(idx);
        if (!ref) continue; // 범위 밖 인덱스는 조용히 버리지 않되, 없는 출처를 지어내지도 않는다
        if (!sources.some((s) => s.url === ref.link)) {
          sources.push({ url: ref.link, domain: extractDomain(ref.link) });
        }
      }
      if (sources.length > 0) {
        citedSpans.push({ startIndex, endIndex, sources, precision: 'exact' });
      }
    }

    lines.push(snippet);
    cursor = endIndex + 1;
  }

  // 재귀 처리 — expandable/list 안에 또 text_blocks가 있을 수 있다
  function processBlocks(blocks: GoogleTextBlock[]) {
    for (const block of blocks) {
      if (block.type === 'expandable') {
        // 펼침 제목은 출처 연결 없이 텍스트만 남긴다 (브랜드명이 제목에 있을 수 있음)
        if (block.title) appendLine(block.title, undefined);
        if (block.text_blocks) processBlocks(block.text_blocks); // 재귀
      } else if (block.type === 'comparison') {
        // 비교표: 출처 연결 없이 텍스트만 남긴다 (product_labels + 각 feature/value)
        // 이 타입엔 reference_indexes 자체가 구조상 없다.
        const anyBlock = block as unknown as {
          product_labels?: string[];
          comparison?: Array<{ feature: string; values: string[] }>;
        };
        if (anyBlock.product_labels) appendLine(anyBlock.product_labels.join(' vs '), undefined);
        for (const row of anyBlock.comparison ?? []) {
          appendLine(`${row.feature}: ${row.values.join(' / ')}`, undefined);
        }
      } else if (block.type === 'list' && block.list) {
        for (const item of block.list) {
          if (item.snippet) {
            const line = item.title ? `${item.title}: ${item.snippet}` : item.snippet;
            appendLine(line, item.reference_indexes);
          }
          if (item.text_blocks) processBlocks(item.text_blocks); // 중첩 리스트 재귀
        }
      } else if (block.snippet) {
        // paragraph, heading 등
        appendLine(block.snippet, block.reference_indexes);
      }
    }
  }

  processBlocks(textBlocks);

  return { rawText: lines.join('\n'), citedSpans };
}

export const googleAiOverviewAdapter: EngineAdapter = {
  engineName: 'google_aio',

  async ask(query: string): Promise<AdapterResponse> {
    const apiKey = process.env.SERPAPI_API_KEY;
    if (!apiKey) {
      throw new Error('SERPAPI_API_KEY 환경 변수가 설정되지 않았습니다');
    }

    const timestamp = new Date().toISOString();

    // ── 1단계: 일반 구글 검색 ──────────────────────────────────
    const searchUrl = new URL(SERPAPI_URL);
    searchUrl.searchParams.set('engine', 'google');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('gl', 'kr'); // 대한민국
    searchUrl.searchParams.set('hl', 'ko'); // 한국어
    searchUrl.searchParams.set('api_key', apiKey);

    const searchResponse = await fetch(searchUrl.toString());
    if (!searchResponse.ok) {
      const errorBody = await searchResponse.text();
      throw new Error(`SerpApi(구글 검색) 오류 (${searchResponse.status}): ${errorBody}`);
    }

    const searchData = await searchResponse.json();

    if (searchData.search_metadata?.status === 'Error') {
      throw new Error(`SerpApi(구글 검색) 실패: ${searchData.error ?? '원인 불명'}`);
    }

    let aiOverview = searchData.ai_overview ?? null;

    // ── 2단계: 지연 로딩이면 page_token으로 재호출 ──────────────
    // aiOverview가 있는데 text_blocks가 없고 page_token만 있으면 지연 로딩 케이스.
    // ⚠️ 토큰은 발급 후 1분 안에 써야 하므로 이 자리에서 바로 이어서 호출한다.
    if (aiOverview && !aiOverview.text_blocks && aiOverview.page_token) {
      const tokenUrl = new URL(SERPAPI_URL);
      tokenUrl.searchParams.set('engine', 'google_ai_overview');
      tokenUrl.searchParams.set('page_token', aiOverview.page_token);
      tokenUrl.searchParams.set('api_key', apiKey);

      const tokenResponse = await fetch(tokenUrl.toString());
      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();
        throw new Error(`SerpApi(구글 AI Overview) 오류 (${tokenResponse.status}): ${errorBody}`);
      }

      const tokenData = await tokenResponse.json();

      if (tokenData.search_metadata?.status === 'Error') {
        throw new Error(`SerpApi(구글 AI Overview) 실패: ${tokenData.error ?? '원인 불명'}`);
      }

      aiOverview = tokenData.ai_overview ?? null;
    }

    // ── 규칙 B: 미노출과 실패를 구분한다 ──────────────────────────
    // 여기까지 왔는데 text_blocks가 없으면, 이 쿼리엔 AI Overview가
    // 아예 안 뜬 것이다(실패 아님).
    const textBlocks: GoogleTextBlock[] =
      aiOverview && Array.isArray(aiOverview.text_blocks) ? aiOverview.text_blocks : [];
    const references: GoogleReference[] =
      aiOverview && Array.isArray(aiOverview.references) ? aiOverview.references : [];

    const overviewShown = textBlocks.length > 0;

    const { rawText, citedSpans } = overviewShown
      ? buildRawTextAndSpans(textBlocks, references)
      : { rawText: '', citedSpans: [] };

    // ── 본 것(retrieved) ────────────────────────────────────────
    // ⚠️ 네이버와 마찬가지로, references가 "본 것 전체"인지 "사용한 것과
    //    동일"인지 문서만으로는 확신 못함(추정). 실제 호출로 재확인 필요.
    const retrievedSources: RetrievedSource[] = references.map((ref) => ({
      url: ref.link,
      rawUrl: ref.link,
      domain: extractDomain(ref.link),
      ...(ref.title ? { title: ref.title } : {}),
    }));

    return {
      engine: 'google_aio',
      query,
      rawText,
      retrievedSources,
      citedSpans,
      citations: getCitedUrls(citedSpans),
      timestamp,
      model: 'serpapi-google-ai-overview',
      searchPerformed: true,
      overviewShown,
    };
  },
};
