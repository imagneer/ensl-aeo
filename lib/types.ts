// lib/types.ts

import type { EngineName } from './engine-config';

/**
 * ═══════════════════════════════════════════════════════════
 * 출처(citation) 관련 타입 — Day 8에서 도입
 * ═══════════════════════════════════════════════════════════
 *
 * 왜 citations: string[] 하나로는 부족한가:
 *   엔진마다 "출처"라는 단어가 가리키는 게 다르다.
 *   - Perplexity/Gemini/Claude는 "검색해서 받아온 후보 목록"을 준다
 *   - OpenAI/Perplexity/Claude/Gemini는 "답변에 실제 반영한 출처"도 준다
 *   이 둘을 같은 배열에 담으면 엔진 간 비교가 성립하지 않는다.
 *   (2026-08-17 실측: Perplexity는 20개 중 10개만 실제 사용, ChatGPT는
 *    후보 목록을 아예 제공하지 않음 — probe-citations 참고)
 *
 * 용어는 CLAUDE.md의 용어 정의표를 따른다:
 *   본 것(retrieved)   = AI가 검색해서 받아온 후보 출처 목록
 *   사용한 것(cited)   = AI가 답변에 실제 근거로 붙인 출처
 */

/** 본 것 — 검색으로 받아온 후보 출처 1건 */
export interface RetrievedSource {
  /** 정규화된 URL (normalizeUrl 적용 후) */
  url: string;

  /** API가 돌려준 원본 URL — 정규화 때문에 원본을 잃지 않도록 보존 */
  rawUrl: string;

  /**
   * 출처의 도메인 (예: 'onetopdental.com').
   *
   * 왜 url에서 뽑지 않고 따로 저장하는가 (2026-08-17 실측 확인):
   *   Gemini는 url 자리에 실제 주소가 아니라
   *   vertexaisearch.cloud.google.com/grounding-api-redirect/... 라는
   *   구글 중계 주소를 준다. 그래서 url에서 도메인을 뽑으면 Gemini 출처가
   *   전부 google.com으로 잡혀 브랜드 매칭이 통째로 실패한다.
   *   실제 도메인은 Gemini의 title 필드에 순수 도메인 형태로 들어온다(10/10 확인).
   *   → 도메인을 얻는 방법이 엔진마다 달라서, 각 어댑터가 책임지고 채운다.
   *
   * ⚠️ Gemini는 도메인까지만 알 수 있고 "어느 페이지"인지는 모른다.
   *    페이지 단위 비교를 할 때 Gemini는 참여할 수 없다.
   */
  domain: string;

  title?: string;

  /** 검색 결과 미리보기 텍스트 (Perplexity의 search_results만 제공) */
  snippet?: string;
}

/**
 * 인용된 출처 1건 — 주소와 도메인을 한 쌍으로 묶는다.
 *
 * 왜 주소 목록과 도메인 목록을 따로 두지 않는가:
 *   두 배열을 나란히 두면 길이가 어긋날 수 있고, 어긋나도 아무도 모른다.
 *   한 쌍으로 묶으면 구조적으로 어긋날 수가 없다.
 */
export interface CitedSource {
  /** 정규화된 URL. ⚠️ Gemini는 구글 중계 주소라 페이지 식별에 쓸 수 없다 */
  url: string;

  /** 도메인 (예: 'onetopdental.com') — 엔진 간 비교는 이 값을 기준으로 한다 */
  domain: string;
}

/**
 * 사용한 것 — 답변의 특정 구간이 어떤 출처를 근거로 삼았는지.
 *
 * ⚠️ 구간(span)의 좌표 기준은 반드시 AdapterResponse.rawText다.
 *    엔진이 준 원본 텍스트가 아니라, 어댑터가 최종적으로 rawText에 담은
 *    문자열 기준으로 변환해서 넣어야 한다. (Claude 어댑터는 안내 멘트를
 *    잘라내므로 원본 인덱스를 그대로 쓰면 어긋난다)
 */
export interface CitedSpan {
  /** rawText 기준 시작 글자 위치 (0부터) */
  startIndex: number;

  /** rawText 기준 끝 글자 위치 */
  endIndex: number;

  /**
   * 이 구간이 근거로 삼은 출처들.
   * 한 구간이 여러 출처를 참조할 수 있으므로 배열이다.
   */
  sources: CitedSource[];

  /**
   * 구간 좌표를 얼마나 믿을 수 있는지.
   *   'exact'       — 엔진이 글자 인덱스를 직접 줌 (OpenAI, Gemini)
   *   'block'       — 문단/블록 단위로만 알 수 있음 (Claude)
   *   'marker'      — 본문의 [n] 마커 위치로 추정 (Perplexity)
   * ⚠️ 이 값을 무시하고 전부 같은 정밀도로 취급하면 안 된다.
   *    브랜드↔출처 연결 로직이 정밀도에 따라 다르게 동작해야 한다.
   */
  precision: 'exact' | 'block' | 'marker';
}

/**
 * 어댑터가 API를 호출한 뒤 돌려줘야 하는 공통 형식.
 * 모든 엔진 어댑터는 이 형식을 반환해야 한다.
 */
export interface AdapterResponse {
  /** 어떤 엔진에서 왔는지 */
  engine: EngineName;

  /** 보낸 질문 원문 */
  query: string;

  /** AI가 준 전체 답변 텍스트 (원시 데이터, 파싱 및 구간 좌표의 기준) */
  rawText: string;

  /**
   * 본 것 — 검색으로 받아온 후보 출처 목록.
   *
   * ⚠️ null과 빈 배열([])의 뜻이 다르다. 절대 섞지 말 것:
   *   null = 이 엔진은 후보 목록을 제공하지 않음 (ChatGPT)
   *   []   = 제공은 하는데 이번엔 0개였음 (= 검색을 안 했거나 결과가 없었음)
   * 집계에서 null을 0으로 취급하면 "ChatGPT는 아무것도 안 봤다"는
   * 사실이 아닌 결론이 나온다.
   */
  retrievedSources: RetrievedSource[] | null;

  /** 사용한 것 — 답변 구간별 출처 매핑 */
  citedSpans: CitedSpan[];

  /**
   * @deprecated citedSpans에서 파생된 고유 URL 목록 (하위 호환용).
   *
   * 기존 코드(collector.ts 등)가 이 필드를 참조하고 있어 한 번에 걷어내지 않았다.
   * Day 8 Step 2~3에서 호출부를 전부 옮긴 뒤 제거할 것.
   * 새 코드에서는 citedSpans 또는 getCitedUrls()를 쓸 것.
   */
  citations: string[];

  /** API 호출 시각 (ISO 문자열) */
  timestamp: string;

  /** 사용한 모델명 (예: 'gpt-5-search-api', 'claude-haiku-4-5') */
  model: string;

  /**
   * 실제로 웹검색을 수행했는지 여부.
   * ⚠️ Gemini는 모델이 스스로 판단해서 검색을 건너뛸 수 있음(2026-08-07 실측 확인).
   *    이 값이 false면 답변이 학습 지식만으로 작성된 것이므로,
   *    AEO 작업(콘텐츠·스키마 개선)의 효과가 반영될 수 없는 관측이다.
   *    노출률 집계에 그대로 섞으면 안 되고, 반드시 구분해서 다뤄야 한다.
   */
  searchPerformed: boolean;

  /**
   * Tier 1(SerpApi) 전용 - 검색 결과 페이지에 AI 요약 자체가 떴는지 여부.
   * 
   * ⚠️ searchPerformed와 다른 질문이다.
   * searchPerformed = "검색을 하긴 했나" (Tier 1은 태생적으로 항상 true)
   * overviewShown = "그 겸색 결과 화면에 AI 요약이 떴나" 
   * 구글/네이버는 검색은 늘 되지만, 특정 쿼리엔 AI 요약이 안뜨는 경우도 있다. 
   * (예: 너무 짧은 쿼리, 상거래성 쿼리 등). 이건 미노출이지 실패가 아니다. 
   * - 대시보드에서 반드시 구분해서 보여줘야 한다.
   * 
   * Tier 2(기존 4개 엔진)는 이 개념이 없으므로 항상 null로 둔다.
   */
  overviewShown: boolean | null;
}

/**
 * 모든 엔진 어댑터가 구현해야 하는 인터페이스.
 * "query(질문)를 받아서 AdapterResponse를 돌려준다"는 계약.
 */
export interface EngineAdapter {
  /** 이 어댑터가 담당하는 엔진 이름 */
  engineName: EngineName;

  /** 질문을 보내고 응답을 받아오는 함수 */
  ask(query: string): Promise<AdapterResponse>;
}

// ═══════════════════════════════════════════════════════════
// 헬퍼
// ═══════════════════════════════════════════════════════════

/**
 * URL 정규화 — 같은 페이지가 다른 문자열로 집계되는 걸 막는다.
 *
 * 왜 필요한가 (2026-08-17 실측으로 발견):
 *   OpenAI는 돌려주는 URL에 자기 추적 파라미터를 붙인다.
 *     Perplexity → https://onetopdental.com/
 *     ChatGPT    → https://onetopdental.com/?utm_source=openai
 *   정규화 없이 세면 같은 홈페이지가 서로 다른 출처 2개로 잡힌다.
 *
 * ⚠️ 한계: 추적용 파라미터만 제거한다. 페이지 내용을 바꾸는 파라미터
 *    (예: ?page=2, ?id=123)는 남긴다. 지우면 다른 페이지가 같은 것으로 합쳐진다.
 */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'ref', 'ref_src',
];

export function normalizeUrl(input: string): string {
  try {
    const u = new URL(input);

    for (const param of TRACKING_PARAMS) {
      u.searchParams.delete(param);
    }

    // 프로토콜 통일 (http로 온 것도 같은 페이지로 취급)
    u.protocol = 'https:';

    // 호스트 소문자화 + www 제거
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');

    // 끝의 슬래시 하나만 제거 ("/" 루트는 유지)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    // 해시(#섹션)는 같은 문서이므로 제거
    u.hash = '';

    return u.toString();
  } catch {
    // URL 형식이 아니면 원본 그대로 (버리지 않는다)
    return input;
  }
}

/**
 * URL에서 도메인만 뽑는다 (예: 'https://www.onetopdental.com/a/b' → 'onetopdental.com').
 *
 * ⚠️ Gemini의 중계 주소에는 쓰면 안 된다. 전부 'vertexaisearch.cloud.google.com'이
 *    나와서 실제 출처를 식별할 수 없다. Gemini는 title 값을 그대로 도메인으로 쓴다.
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return ''; // URL 형식이 아니면 빈 값 (거짓 도메인을 지어내지 않는다)
  }
}

/**
 * citedSpans에서 고유 출처 URL 목록을 뽑는다.
 *
 * ⚠️ 이 배열의 길이는 "사용한 출처 개수"이지 "인용 구간 개수"가 아니다.
 *    한 출처가 여러 문장에서 인용되면 구간은 여러 개지만 출처는 하나다.
 *    (2026-08-17 실측: Gemini는 19개 구간이 7개 출처를 참조)
 *    지표를 만들 때 둘 중 뭘 세는지 반드시 명시할 것.
 */
export function getCitedUrls(spans: CitedSpan[]): string[] {
  const set = new Set<string>();
  for (const span of spans) {
    for (const source of span.sources) set.add(source.url);
  }
  return Array.from(set);
}

/**
 * citedSpans에서 고유 도메인 목록을 뽑는다.
 *
 * 엔진 간 비교는 이 값을 기준으로 해야 한다. URL 기준으로 비교하면
 * Gemini만 구글 중계 주소라서 다른 엔진과 절대 매칭되지 않는다.
 */
export function getCitedDomains(spans: CitedSpan[]): string[] {
  const set = new Set<string>();
  for (const span of spans) {
    for (const source of span.sources) {
      if (source.domain) set.add(source.domain);
    }
  }
  return Array.from(set);
}
