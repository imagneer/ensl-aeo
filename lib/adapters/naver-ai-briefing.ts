import type {
    EngineAdapter,
    AdapterResponse,
    RetrievedSource,
    CitedSpan,
    CitedSource,
} from '../types';
import { extractDomain, getCitedUrls } from '../types';

/**
 * 네이버 AI브리핑 어댑터 (SerpApi 경유)
 *
 * Tier 1 — 검색결과 페이지를 긁는 방식이라 Tier 2(ChatGPT 등)와 근본적으로 다르다.
 *
 * 이 엔진의 특징 (SerpApi 공식 문서 기준, 2026-08-18):
 *   - 단일 호출로 끝난다 (구글과 달리 2단계 토큰 흐름이 없음).
 *   - `text_blocks[]`가 문단 단위로 이미 쪼개져서 오고, 각 블록에
 *     `reference_indexes`(그 블록이 인용한 출처 번호)가 딸려 있다.
 *   - `references[]`는 Perplexity의 search_results와 달리, "찾아는 봤지만
 *     안 쓴 후보"를 따로 안 준다 — 사실상 사용한 것과 같은 목록으로 보인다.
 *     ⚠️ 이건 문서만으로 확인한 것이라 추정이다. 실제 호출로 재확인 필요.
 *   - AI브리핑 자체가 아예 안 뜨는 쿼리가 있다 — 이건 실패가 아니라
 *     "미노출"이라는 유의미한 관측이다 (overviewShown: false로 표시).
 *
 * rawText를 만드는 방법이 Perplexity와 다르다:
 *   SerpApi가 주는 markdown 필드는 굵은 글씨(**) 등 서식이 섞여 있어서
 *   text_blocks[].snippet과 문자열이 정확히 일치하지 않는 경우가 있다.
 *   그래서 markdown을 파싱하지 않고, text_blocks의 snippet을 우리가 직접
 *   한 줄씩 이어붙여 rawText를 만든다. 이러면 각 블록의 글자 위치를
 *   추측(indexOf)할 필요 없이 조립하면서 바로 알 수 있다.
 *   → precision을 'exact'로 표시할 수 있는 이유.
 */
const SERPAPI_URL = 'https://serpapi.com/search.json';

/** SerpApi references[] 원본 타입 (필요한 필드만) */
interface NaverReference {
    index: number;
    link: string;
    source?: string;
}

/** SerpApi text_blocks[] 원본 타입 (필요한 필드만, table 제외) */
interface NaverTextBlock {
    type: string;
    snippet?: string;
    reference_indexes?: number[];
    list?: Array<{ snippet: string; reference_indexes?: number[] }>;
    table?: string[][];
}

/**
 * text_blocks를 순서대로 훑으며 rawText를 조립하고, 동시에 CitedSpan을 만든다.
 *
 * Perplexity(findSpanStart)와 다른 점: 위치를 문자열에서 "찾는" 게 아니라
 * "만들면서 기록"한다. 그래서 precision이 'exact'다 — 추측이 섞이지 않는다.
 *
 * @param references index(1-based) → 출처 정보 조회용 원본 배열
 */
function buildRawTextAndSpans(
  textBlocks: NaverTextBlock[],
  references: NaverReference[]
): { rawText: string; citedSpans: CitedSpan[] } {
  // index(1-based)로 바로 찾을 수 있게 Map으로 미리 바꿔둔다.
  const refByIndex = new Map<number, NaverReference>();
  for (const ref of references) refByIndex.set(ref.index, ref);

  const lines: string[] = [];
  const citedSpans: CitedSpan[] = [];
  let cursor = 0; // 지금까지 조립된 rawText의 총 길이

  // 한 줄(snippet + 그 줄의 reference_indexes)을 rawText에 추가하고,
  // 필요하면 CitedSpan도 같이 만드는 내부 함수.
  function appendLine(snippet: string, refIndexes: number[] | undefined) {
    const startIndex = cursor;
    const endIndex = cursor + snippet.length;

    if (refIndexes && refIndexes.length > 0) {
      const sources: CitedSource[] = [];
      for (const idx of refIndexes) {
        const ref = refByIndex.get(idx);
        // 실측 전 방어 코드: 문서 범위 밖 인덱스가 오면 조용히 버리지 않고 남긴다.
        if (!ref) continue;
        if (!sources.some((s) => s.url === ref.link)) {
          sources.push({ url: ref.link, domain: extractDomain(ref.link) });
        }
      }
      if (sources.length > 0) {
        citedSpans.push({ startIndex, endIndex, sources, precision: 'exact' });
      }
    }

    lines.push(snippet);
    cursor = endIndex + 1; // +1은 줄바꿈 한 글자 몫
  }

  for (const block of textBlocks) {
    if (block.type === 'table' && block.table) {
      // 표: 출처 연결 없이 텍스트만 남긴다 (행마다 한 줄).
      for (const row of block.table) appendLine(row.join(' '), undefined);
    } else if (block.type === 'list' && block.list) {
      for (const item of block.list) appendLine(item.snippet, item.reference_indexes);
    } else if (block.snippet) {
      appendLine(block.snippet, block.reference_indexes);
    }
  }

  return { rawText: lines.join('\n'), citedSpans };
}

export const naverAiOverviewAdapter: EngineAdapter = {
    engineName: 'naver_ai_briefing' ,

    async ask(query: string): Promise<AdapterResponse> {
        const apiKey = process.env.SERPAPI_API_KEY;
        if (!apiKey) {
            throw new Error('SERPAPI_KEY 환경 변수가 설정되지 않았습니다');
        }

        const timestamp = new Date().toISOString();
    
        const url = new URL(SERPAPI_URL);
        url.searchParams.set('engine', 'naver_ai_overview');
    url.searchParams.set('query', query);
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `SerpApi(네이버) 오류 (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();

    // status는 'Success' | 'Error' | 'Processing' 중 하나로 온다(SerpApi 공통 규격).
    // 'Error'는 SerpApi 자체 호출 실패이지 "미노출"이 아니므로 여기서 걸러 던진다.
    if (data.search_metadata?.status === 'Error') {
      throw new Error(
        `SerpApi(네이버) 검색 실패: ${data.error ?? '원인 불명'}`
      );
    }

    const textBlocks: NaverTextBlock[] = Array.isArray(data.text_blocks)
      ? data.text_blocks
      : [];
    const references: NaverReference[] = Array.isArray(data.references)
      ? data.references
      : [];

    // ── 규칙 B: 미노출과 실패를 구분한다 ──────────────────────────
    // text_blocks가 비어있으면, 호출 자체는 성공했는데 이 쿼리엔
    // AI브리핑이 뜨지 않은 것이다. 실패(throw)가 아니라 "0건짜리 성공"으로
    // 다룬다 — rawText가 빈 문자열이면 기존 parser.ts가 자연스럽게
    // "브랜드 언급 없음"으로 처리해준다 (Day 8 이전부터 있던 동작 그대로).
    const overviewShown = textBlocks.length > 0;

    const { rawText, citedSpans } = overviewShown
      ? buildRawTextAndSpans(textBlocks, references)
      : { rawText: '', citedSpans: [] };

    // ── 본 것(retrieved) ────────────────────────────────────────
    // ⚠️ 파일 상단 주석 참고: references가 "본 것"인지 "사용한 것과 동일"인지
    //    문서로는 확신 못함(추정). 실제 호출로 재확인 전까지는 있는 그대로 담는다.
    const retrievedSources: RetrievedSource[] = references.map((ref) => ({
      url: ref.link,
      rawUrl: ref.link,
      domain: extractDomain(ref.link),
      ...(ref.source ? { title: ref.source } : {}),
    }));

    return {
      engine: 'naver_ai_briefing',
      query,
      rawText,
      retrievedSources,
      citedSpans,
      //citations: citedSpans.flatMap((s) => s.sources.map((src) => src.url)),
      citations: getCitedUrls(citedSpans),
      timestamp,
      model: 'serpapi-naver-ai-overview',
      // Tier 1은 태생적으로 검색 결과 페이지를 긁는 것이므로 항상 true.
      // (미노출이어도 "검색은 했는데 화면에 AI브리핑이 없었다"는 뜻이라 true가 맞다)
      searchPerformed: true,
      overviewShown,
    };
  },
};

