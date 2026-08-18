// lib/adapters/openai.ts

import type { EngineAdapter, AdapterResponse, CitedSpan } from '../types';
import { normalizeUrl, getCitedUrls, extractDomain } from '../types';

/**
 * OpenAI (ChatGPT) API 어댑터
 *
 * ⚠️ 중요: gpt-5-search-api는 일반 모델과 다른 "검색 전용 모델"이다.
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

/**
 * 응답의 annotations[] 한 건.
 *
 * (2026-08-17 실측 확인) probe-output/openai-2026-08-17T03-01-04-961Z.json 기준
 * url_citation의 키는 정확히 { start_index, end_index, title, url } 4개이고,
 * type은 'url_citation' 한 종류만 왔다.
 * ⚠️ 추정: 다른 type(파일 인용 등)이 미래에 섞여 올 수 있으므로 아래에서
 *    type을 반드시 검사한다. 검사 없이 url_citation!을 쓰면 그때 터진다.
 */
interface Annotation {
  type: string;
  url_citation?: {
    url: string;
    title?: string;
    start_index?: number;
    end_index?: number;
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

    // OpenAI 응답 구조 (2026-08-17 실측 확인):
    //   data.choices[0].message.content     = 답변 텍스트
    //   data.choices[0].message.annotations = [{ type:'url_citation', url_citation:{...} }, ...]
    // rawText는 구간(span) 좌표의 기준점이다. 여기서 자르거나 다듬으면
    // 아래 citedSpans의 인덱스가 전부 어긋나므로, 원문 그대로 둔다.
    const rawText: string = data.choices?.[0]?.message?.content ?? '';
    const annotations: Annotation[] = data.choices?.[0]?.message?.annotations ?? [];

    // ── 사용한 것(cited) ────────────────────────────────────────────
    // annotation 1건 = 구간 1개로 둔다. 같은 URL이 여러 번 나와도 합치지 않는다.
    // 왜: "구간 개수"와 "고유 출처 개수"는 다른 지표이기 때문이다.
    // (2026-08-17 실측: 이 응답은 annotation 7건이 고유 URL 3개를 가리켰다.
    //  여기서 합쳐버리면 "몇 번 근거로 쓰였는지"라는 정보가 영구히 사라진다.
    //  고유 출처 개수가 필요하면 getCitedUrls()로 나중에 줄이면 된다 — 반대는 불가능)
    const citedSpans: CitedSpan[] = [];

    for (const a of annotations) {
      if (a.type !== 'url_citation') continue;

      const uc = a.url_citation;
      if (!uc?.url) continue;

      // 인덱스가 없으면 구간을 만들 수 없다.
      // ⚠️ 이 경우 구간은 버려지지만 URL 자체는 살려야 하므로 0,0 구간으로 남긴다.
      //    (출처를 통째로 버리면 "사용한 것" 집계가 실제보다 적게 나온다)
      const hasIndex =
        typeof uc.start_index === 'number' && typeof uc.end_index === 'number';

      const startIndex = hasIndex ? uc.start_index! : 0;
      const endIndex = hasIndex ? uc.end_index! : 0;

      citedSpans.push({
        startIndex,
        endIndex,
        // normalizeUrl 필수: OpenAI는 URL 끝에 ?utm_source=openai를 붙여서 돌려준다
        // (2026-08-17 실측 확인 — 공식 문서에는 없는 동작).
        // 정규화를 빼면 Perplexity가 준 https://onetopdental.com/ 과
        // ChatGPT가 준 https://onetopdental.com/?utm_source=openai 가
        // 서로 다른 출처 2개로 집계되어 엔진 간 비교가 통째로 망가진다.
        // OpenAI는 실제 주소를 주므로 도메인을 주소에서 뽑는다
        sources: [{ url: normalizeUrl(uc.url), domain: extractDomain(uc.url) }],
        // OpenAI는 글자 인덱스를 직접 주므로 'exact'.
        precision: 'exact',
      });

      // 인덱스 단위 자가 점검 — 개발 중 조용한 오작동을 막기 위한 장치다.
      // 자세한 근거는 아래 "인덱스 단위" 주석 참고.
      if (hasIndex) warnIfIndexLooksWrong(rawText, startIndex, endIndex, uc.url);
    }

    const modelUsed: string = data.model ?? MODEL;

    return {
      engine: 'chatgpt',
      query,
      rawText,

      // ⚠️ 반드시 null. 빈 배열([])이 아니다.
      // OpenAI는 "검색해서 본 후보 목록"을 응답에 아예 담아주지 않는다
      // (2026-08-17 실측 확인: 응답 최상위 키는 id/object/created/model/choices/
      //  usage/system_fingerprint 뿐이고, message에도 role/content/refusal/
      //  annotations 밖에 없다. 후보 목록에 해당하는 필드를 전수 탐색해도 없었다).
      // null = "이 엔진은 후보 목록을 제공하지 않음",
      // []   = "제공은 하는데 이번엔 0개였음(=검색을 안 했거나 결과가 없었음)".
      // 여기에 []를 넣으면 집계가 "ChatGPT는 아무것도 안 보고 답했다"는
      // 사실이 아닌 결론을 내게 된다. 실제로는 봤지만 안 알려주는 것뿐이다.
      retrievedSources: null,

      citedSpans,

      // 하위 호환용 파생 필드 — citedSpans가 단일 진실 소스이고 이건 거기서 뽑는다.
      // 두 곳에서 따로 계산하면 반드시 어긋나므로 절대 별도로 만들지 않는다.
      citations: getCitedUrls(citedSpans),

      timestamp,
      model: modelUsed,
      searchPerformed: true, // gpt-5-search-api는 검색 전용 모델이라 항상 검색함
      overviewShown: null, // Tier 2 엔진 - 이 개념 자체가 해당 없음
    };
  },
};

/**
 * ── 인덱스 단위: 글자(JS 문자열) 단위다. 바이트 단위가 아니다. ──
 *
 * (2026-08-17 실측 확인) 검증 방법과 결과:
 *   probe-output/openai-2026-08-17T03-01-04-961Z.json (한글 답변, 본문 2,160글자 /
 *   UTF-8 기준 3,577바이트 — 단위가 다르면 반드시 어긋나는 조건)의 annotation 7건에 대해
 *     (A) rawText.slice(start, end)                          → 7건 전부 자기 URL을 포함
 *     (B) Buffer.from(rawText,'utf8').slice(start,end)       → 7건 전부 실패(글자 깨짐)
 *   예: start=272,end=337 → "([onetopdental.com](https://onetopdental.com/?utm_source=openai))"
 *   즉 글자 단위가 맞다. 그래서 변환 없이 그대로 쓴다.
 *
 * ⚠️ 같은 프로젝트의 Gemini는 바이트 단위라서 변환이 필요하다. 엔진마다 다르므로
 *    "OpenAI가 글자 단위니 다른 엔진도 그럴 것"이라고 유추하면 안 된다.
 *
 * ⚠️ 추정(미검증): JS 문자열 인덱스는 정확히는 UTF-16 코드유닛 단위인데,
 *    이 샘플에는 서로게이트 페어(예: 이모지 😀, 일부 한자 확장)가 없어서
 *    "코드포인트 단위"와 구분이 안 됐다(length === [...s].length). 이모지가 섞인
 *    답변에서 구간이 한두 칸 밀린다면 이 지점을 다시 의심할 것.
 *
 * ⚠️ 더 중요한 한계 — precision:'exact'는 "좌표가 정확하다"는 뜻이지
 *    "구간 안에 근거가 된 주장이 들어있다"는 뜻이 아니다.
 *    실측상 OpenAI의 구간은 본문 속 인용 마커 "([도메인](URL))" 자체를 가리킨다.
 *    근거가 된 문장(브랜드명이 들어있는 부분)은 구간 '앞쪽'에 있다.
 *    따라서 브랜드↔출처를 연결할 때 구간 안 텍스트만 보면 브랜드명을 하나도
 *    못 찾는다. 구간 주변(앞 문장/같은 표 행)까지 봐야 한다.
 */
function warnIfIndexLooksWrong(
  rawText: string,
  startIndex: number,
  endIndex: number,
  url: string
): void {
  // 범위 자체가 본문을 벗어나면 단위가 바뀌었을 가능성이 높다(바이트 인덱스는 더 크다).
  if (startIndex < 0 || endIndex > rawText.length || startIndex >= endIndex) {
    console.warn(
      `[openai 어댑터] ⚠️ 인용 구간이 본문 범위를 벗어남 (start=${startIndex}, end=${endIndex}, 본문 ${rawText.length}글자). ` +
      `API가 인덱스 단위를 바꿨을 수 있음 — 실측 재확인 필요. url=${url}`
    );
    return;
  }

  // 구간 안에 자기 URL이 들어있어야 정상(위 실측에서 7/7 성립).
  // ⚠️ 이 검사는 "OpenAI가 본문에 마크다운 인용 마커를 넣는다"는 현재 동작에
  //    의존한다. 마커 없이 순수 문장만 가리키도록 동작이 바뀌면 정상인데도
  //    경고가 뜬다. 그때는 경고를 없앨 게 아니라 실측으로 단위를 다시 확인할 것.
  if (!rawText.slice(startIndex, endIndex).includes(url)) {
    console.warn(
      `[openai 어댑터] ⚠️ 구간 텍스트에 해당 URL이 없음 (start=${startIndex}, end=${endIndex}). ` +
      `인덱스 단위 또는 인용 표기 방식이 바뀌었을 수 있음 — 실측 재확인 필요. url=${url}`
    );
  }
}
