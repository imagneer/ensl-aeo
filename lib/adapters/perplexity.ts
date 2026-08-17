// lib/adapters/perplexity.ts

import type {
  EngineAdapter,
  AdapterResponse,
  RetrievedSource,
  CitedSpan,
} from '../types';
import { normalizeUrl, getCitedUrls } from '../types';

/**
 * Perplexity Sonar API 어댑터
 *
 * Perplexity API는 OpenAI와 동일한 형식(chat completions)을 쓰기 때문에
 * 별도 SDK 없이 fetch만으로 호출 가능.
 *
 * 이 엔진의 특징 (2026-08-17 probe-output/perplexity-*.json 실측 확인):
 *   - `search_results`  = 본 것(retrieved). 검색해서 받아온 후보 20건.
 *   - `citations`       = 같은 20건의 URL만 뽑은 배열. search_results와
 *                         **순서·개수가 정확히 1:1로 일치**했다(20/20).
 *   - 답변 본문의 `[n]` = 사용한 것(cited). n은 citations의 1-based 인덱스.
 *
 * ⚠️ 여기서 가장 조심할 점: `citations`(20건)는 "사용한 것"이 아니라
 *    "본 것의 URL 목록"이다. 실측에서 본문이 실제로 인용한 건 20건 중 10건뿐이었다.
 *    예전 코드는 이 20건을 통째로 AdapterResponse.citations에 넣었는데,
 *    그건 CLAUDE.md 용어 정의상 "본 것"을 "사용한 것" 칸에 넣은 것이라
 *    다른 엔진과 비교하면 Perplexity만 출처 수가 2배로 부풀어 보였다.
 *    이번 수정으로 citations는 citedSpans에서 파생시킨다(= 10건).
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

// 사용할 모델 — sonar는 웹 검색을 포함한 응답을 줌
const MODEL = 'sonar';

/**
 * 본문에서 인용 마커 덩어리를 찾는 정규식.
 *
 * 왜 "덩어리"인가: 실측 본문은 `[1][2][12]`처럼 마커를 연달아 붙인다.
 * 이걸 하나씩 따로 구간으로 만들면 거의 같은 범위의 구간이 3개 생겨서
 * "인용 구간 수"가 부풀고, 한 문장이 세 출처를 함께 근거로 삼았다는
 * 사실도 사라진다. 그래서 붙어 있는 마커는 한 구간으로 합친다.
 *
 * ⚠️ 마커 사이 공백([1] [2])은 2026-08-17 실측에선 나오지 않았지만,
 *    나올 경우에도 한 덩어리로 보는 게 맞다고 판단해 [ \t]* 를 허용했다.
 *    (⚠️ 추정: 줄바꿈으로 갈라진 마커는 다른 문장의 인용일 수 있어 제외)
 * ⚠️ 마크다운 링크 `[1](https://...)`가 본문에 오면 이 정규식이 인용 마커로
 *    오인한다. 실측 본문에는 없었지만, 프롬프트를 바꿔 목록/링크를 요구하면
 *    생길 수 있는 오작동이다.
 */
const CITATION_CLUSTER_RE = /\[\d+\](?:[ \t]*\[\d+\])*/g;

/**
 * 문장 경계 후보.
 *
 * 왜 한국어 종결어미(다./요./죠.)까지 넣었나: 한국어 답변은 `. ` 뒤에
 * 공백 없이 마커가 바로 붙는 경우가 많아 영어식 `[.!?]\s` 규칙만으로는
 * 문장 시작점을 못 찾는다.
 *
 * ⚠️ 한계: "1.5mm" 같은 소수점은 뒤에 공백이 없어 안 걸리지만,
 *    "홍길동 씨는 ~다. 그렇다" 처럼 인용문 안에 종결어미가 있으면
 *    거기서 잘린다. 즉 구간 시작점은 문장 단위 근사치이지 정확한 값이 아니다.
 *    그래서 precision을 'marker'로 표시한다.
 */
const SENTENCE_BOUNDARY_RE = /\n|다\.|요\.|죠\.|[.!?][ \t]/g;

/**
 * 마커 덩어리 하나에 대응하는 구간의 시작 위치를 찾는다.
 *
 * 규칙: 덩어리 바로 앞에서 뒤로 거슬러 올라가며 "직전" 문장 경계를 찾고,
 * 그 경계 끝을 시작점으로 삼는다.
 *
 * 왜 lowerBound(직전 마커 덩어리의 끝)를 받는가:
 *   "...입니다.[1][2] 다만 ...좋습니다.[3]" 에서 뒤 구간이 앞 마커까지
 *   삼켜버리면 같은 글자가 두 구간에 중복으로 들어간다. 그래서 앞 덩어리
 *   끝을 하한선으로 걸어 구간이 겹치지 않게 한다.
 *
 * 왜 trimmedLen 비교가 필요한가:
 *   마커는 자기 문장의 마침표 **뒤에** 붙는다("...진료합니다.[1][3]").
 *   그 마침표를 경계로 잡으면 시작점이 마커 위치와 같아져 구간이 빈다.
 *   그래서 덩어리 직전(뒤쪽 공백 제외)에 붙어 있는 경계는 후보에서 뺀다.
 */
function findSpanStart(
  rawText: string,
  lowerBound: number,
  clusterStart: number
): number {
  const prefix = rawText.slice(lowerBound, clusterStart);
  const trimmedLen = prefix.replace(/\s+$/, '').length;

  const boundaryRe = new RegExp(SENTENCE_BOUNDARY_RE.source, 'g');
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(prefix)) !== null) {
    const boundaryEnd = match.index + match[0].length;
    // 마커에 딱 붙은 종결부호는 "이 문장의 끝"이지 "직전 문장의 끝"이 아니다
    if (boundaryEnd < trimmedLen) start = boundaryEnd;
  }

  // 경계 뒤의 공백·줄바꿈은 구간에 넣지 않는다 (구간 텍스트를 그대로 보여줄 때 지저분해짐)
  while (start < prefix.length && /\s/.test(prefix[start])) start++;

  return lowerBound + start;
}

/**
 * 본문의 `[n]` 마커를 CitedSpan[]으로 바꾼다.
 *
 * (2026-08-17 실측 확인) n은 data.citations의 **1-based** 인덱스다.
 * 근거 3건 — 우연히 맞을 확률이 낮은 대응들:
 *   - "...강서로 179, 화곡역 8번 출구 도보 1분...[1]" ↔ citations[0]=onetopdental.com
 *     (search_results[0].snippet에 동일 주소·출구 문구가 그대로 있음)
 *   - "**리라이브치과**: 발산역...[15]" ↔ citations[14]=relivedent.com (relive=리라이브)
 *   - "카카오 평점 4.8점, 총 2,202건 리뷰...[2]" ↔ citations[1]=medicalkoreaguide
 *     (해당 snippet에 같은 수치가 있음)
 * 즉 0-based가 아니다. 0-based로 읽으면 모든 출처가 한 칸씩 밀린다.
 *
 * @param citationUrls 정규화된 citations 배열 (인덱스 위치를 보존해야 하므로
 *                     중간을 걸러내면 안 된다)
 */
function buildCitedSpans(
  rawText: string,
  citationUrls: string[],
  query: string
): CitedSpan[] {
  const spans: CitedSpan[] = [];

  // 범위를 벗어난 마커 번호 기록용.
  // 왜 모아서 한 번에 경고하나: 조용히 버리면 "이 관측의 인용이 왜 적지?"를
  // 나중에 절대 재구성할 수 없다. 측정 도구에서 원인 불명의 결측은 치명적이다.
  const outOfRangeMarkers: number[] = [];

  const clusterRe = new RegExp(CITATION_CLUSTER_RE.source, 'g');
  let prevClusterEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = clusterRe.exec(rawText)) !== null) {
    const clusterStart = match.index;
    const clusterEnd = clusterStart + match[0].length;

    const sourceUrls: string[] = [];
    for (const numberText of match[0].match(/\d+/g) ?? []) {
      const markerNumber = Number(numberText);
      const url = citationUrls[markerNumber - 1]; // 1-based → 0-based

      // 빈 문자열도 "없는 출처"로 취급한다.
      // ⚠️ citations 배열에 문자열이 아닌 값이 섞여 오면 위에서 ''로 바뀌는데,
      //    `undefined` 검사만으로는 ''가 통과해 주소 없는 출처가 집계에 잡힌다.
      //    측정 도구에서 원인 불명으로 하나 늘어난 숫자는 조용한 오류다.
      if (url === undefined || url === '') {
        // 규칙: citations 범위 밖 번호는 sourceUrls에 넣지 않는다.
        // (없는 출처를 지어내느니 빼는 쪽이 안전) 대신 아래에서 경고로 남긴다.
        outOfRangeMarkers.push(markerNumber);
        continue;
      }
      // 한 덩어리 안의 중복([2][2])은 같은 출처 1개로 센다
      if (!sourceUrls.includes(url)) sourceUrls.push(url);
    }

    // 유효 출처가 하나도 없는 덩어리는 구간으로 만들지 않는다.
    // (sourceUrls가 빈 CitedSpan은 "근거 없는 인용 구간"이라 의미가 없다)
    if (sourceUrls.length > 0) {
      spans.push({
        startIndex: findSpanStart(rawText, prevClusterEnd, clusterStart),
        endIndex: clusterEnd, // 끝은 마커 덩어리의 끝(=slice에 쓰는 exclusive 인덱스)
        sourceUrls,
        precision: 'marker', // 글자 인덱스를 엔진이 준 게 아니라 마커 위치로 추정한 값
      });
    }

    prevClusterEnd = clusterEnd;
  }

  if (outOfRangeMarkers.length > 0) {
    console.warn(
      `[perplexity] citations 범위를 벗어난 인용 마커 ${outOfRangeMarkers.length}건을 제외함 ` +
        `(번호: ${outOfRangeMarkers.join(', ')} / citations 길이: ${citationUrls.length} / 질문: "${query}")`
    );
  }

  return spans;
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

    // 실측 응답 구조 (2026-08-17):
    //   data.choices[0].message.content = 답변 텍스트
    //   data.search_results[]           = { url, title, snippet, date, last_updated, source, place_metadata }
    //   data.citations[]                = search_results와 같은 순서의 URL 배열
    const rawText: string = data.choices?.[0]?.message?.content ?? '';
    const modelUsed: string = data.model ?? MODEL;

    // ── 본 것 (retrieved) ──────────────────────────────────────
    // Perplexity는 후보 목록을 항상 제공하므로 null이 아니다.
    // ⚠️ 응답에 search_results가 아예 없는 경우(스펙 변경·오류)에는 []가 되는데,
    //    이건 "검색 결과 0건"과 구분되지 않는다. null로 바꾸면 "이 엔진은
    //    후보를 제공 안 함"이라는 다른 거짓말이 되므로 []를 택했다.
    // ⚠️ date/last_updated/source/place_metadata는 RetrievedSource에 자리가 없어
    //    현재 버려진다. 출처의 신선도를 지표로 쓰려면 타입부터 넓혀야 한다.
    const rawSearchResults: Array<{
      url?: string;
      title?: string;
      snippet?: string;
    }> = Array.isArray(data.search_results) ? data.search_results : [];

    const retrievedSources: RetrievedSource[] = rawSearchResults
      .filter((item) => typeof item?.url === 'string')
      .map((item) => ({
        url: normalizeUrl(item.url as string),
        rawUrl: item.url as string, // 정규화로 잃는 원본(추적 파라미터 등) 보존
        ...(item.title ? { title: item.title } : {}),
        ...(item.snippet ? { snippet: item.snippet } : {}),
      }));

    // ── 사용한 것 (cited) ──────────────────────────────────────
    // citations를 정규화하되 **인덱스 위치는 그대로 둔다**.
    // 마커 [n]이 위치로 참조하므로 중간을 걸러내면 전부 밀려서 오답이 된다.
    // (retrievedSources와 같은 normalizeUrl을 쓰므로 두 목록의 URL이 문자열로 일치한다.
    //  실측에서 citations[i] === search_results[i].url 이 20/20 일치했다.)
    const rawCitations: unknown[] = Array.isArray(data.citations) ? data.citations : [];
    const normalizedCitationUrls: string[] = rawCitations.map((url) =>
      typeof url === 'string' ? normalizeUrl(url) : ''
    );

    const citedSpans = buildCitedSpans(rawText, normalizedCitationUrls, query);

    return {
      engine: 'perplexity',
      query,
      rawText, // ⚠️ citedSpans의 좌표 기준. 여기 담는 문자열을 가공하면 좌표가 어긋난다
      retrievedSources,
      citedSpans,
      // 하위 호환 필드 — 반드시 구간에서 파생시킨다.
      // ⚠️ 예전 동작(citations 20건 전부)과 값이 달라진다. 본문이 실제로 인용한 것만 남는다.
      citations: getCitedUrls(citedSpans),
      timestamp,
      model: modelUsed,
      searchPerformed: true, // Perplexity는 모델 자체가 항상 검색하는 구조
    };
  },
};
