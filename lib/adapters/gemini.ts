// lib/adapters/gemini.ts

import type {
  EngineAdapter,
  AdapterResponse,
  RetrievedSource,
  CitedSpan,
  CitedSource,
} from '../types';
import { normalizeUrl, getCitedUrls } from '../types';

/**
 * Google Gemini API 어댑터 — "Grounding with Google Search" 기능 사용
 *
 * ⚠️ 인증 방식이 다른 세 엔진과 다름: 헤더가 아니라 URL 쿼리 파라미터로 API 키 전달.
 * ⚠️ Gemini는 모델이 스스로 검색 여부를 판단한다(2026-08-07 실측 확인).
 *    검색을 건너뛰면 groundingMetadata 자체가 없거나 비어서 온다.
 *    → 그때 retrievedSources는 null이 아니라 빈 배열([])이다.
 *      Gemini는 "본 것" 목록을 제공하는 엔진이므로 "제공 안 함(null)"이 될 수 없고,
 *      "이번엔 0개였음([])"이 정확한 뜻이다. (types.ts의 retrievedSources 주석 참고)
 *
 * 응답 구조 (2026-08-17 실측 확인, probe-output/gemini-2026-08-17T03-01-06-947Z.json):
 *   candidates[0].content.parts[]                      — 답변 텍스트
 *   candidates[0].groundingMetadata.groundingChunks[]  — 본 것(후보 출처) 7개
 *   candidates[0].groundingMetadata.groundingSupports[]— 사용한 것(구간↔출처) 19개
 */

const MODEL = 'gemini-3.6-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ───────────────────────────────────────────────────────────
// 바이트 오프셋 → 글자 인덱스 변환
// ───────────────────────────────────────────────────────────

/**
 * ★ Gemini의 segment.startIndex/endIndex는 글자 수가 아니라 **UTF-8 바이트 오프셋**이다.
 *
 * 왜 이 변환이 필요한가 (2026-08-17 실측 확인):
 *   실제 응답에 이런 구간이 있었다.
 *     { endIndex: 132,
 *       text: "서울 강서구 지역에는 임플란트 시술 경험이 풍부하고 평가가 좋은 치과들이 다수 위치해 있습니다" }
 *   이 텍스트는 44글자인데, 한글 1글자 = UTF-8 3바이트라 44×3 = 132바이트로 정확히 일치한다.
 *   같은 응답의 19개 구간 전부를 검산한 결과:
 *     - 바이트로 해석하면 19/19 일치
 *     - 글자로 해석하면  0/19 일치 (전부 어긋남)
 *   즉 변환 없이 rawText.slice(startIndex, endIndex)를 하면 한글 답변에서는
 *   좌표가 약 3배로 밀려 엉뚱한 구간(대개 빈 문자열이거나 뒤쪽 잘림)을 가리킨다.
 *
 * 구현 방식과 그 이유:
 *   Buffer.subarray(0, n).toString()으로 매번 자르는 방법도 되지만,
 *   (1) 구간마다 전체 버퍼를 다시 디코딩해 O(구간수 × 길이)가 되고
 *   (2) 오프셋이 멀티바이트 글자 한가운데를 가리키면 U+FFFD가 끼어들어
 *       길이가 조용히 틀어진다.
 *   그래서 텍스트를 한 번만 훑어 "바이트 위치 → 글자 위치" 표를 만든다.
 *   글자 경계가 아닌 바이트 위치는 -1로 남겨 두어, 나중에 "변환 실패"를
 *   조용히 넘기지 않고 명시적으로 감지할 수 있게 한다.
 *
 * ⚠️ 이모지·일부 한자 등 서로게이트 페어(UTF-16 2칸) 글자도 code point 단위로
 *    순회하므로 정상 처리된다. 다만 결과 인덱스는 JS 문자열 인덱스(UTF-16 단위)이며,
 *    이는 rawText.slice()가 쓰는 단위와 같으므로 의도한 대로 맞다.
 */
function buildByteToCharIndexMap(text: string): Int32Array {
  const byteLength = Buffer.byteLength(text, 'utf-8');
  const map = new Int32Array(byteLength + 1).fill(-1);

  let bytePos = 0;
  let charPos = 0;
  for (const codePoint of text) {
    map[bytePos] = charPos;
    bytePos += Buffer.byteLength(codePoint, 'utf-8');
    charPos += codePoint.length; // 서로게이트 페어면 2
  }
  map[bytePos] = charPos; // 문자열 끝 경계

  return map;
}

/** 바이트 오프셋을 글자 인덱스로. 글자 경계가 아니거나 범위 밖이면 null. */
function byteToCharIndex(map: Int32Array, byteIndex: number): number | null {
  if (byteIndex < 0 || byteIndex >= map.length) return null;
  const charIndex = map[byteIndex];
  return charIndex === -1 ? null : charIndex;
}

// ───────────────────────────────────────────────────────────
// title → 도메인
// ───────────────────────────────────────────────────────────

/**
 * Gemini는 uri에 구글 중계 주소를 주고, 실제 도메인은 title에 넣어준다.
 * (2026-08-17 실측 확인: 10건 전부 'onetopdental.com', 'youtube.com' 같은
 *  순수 도메인 형태였다)
 *
 * ⚠️ 그래도 검사하는 이유: title은 원래 "제목" 칸이다. 구글이 언제든 사람이 읽는
 *    페이지 제목("강서구 치과 추천 TOP5")을 넣도록 바꿀 수 있다. 그때 그 문자열을
 *    도메인으로 저장하면, 존재하지 않는 도메인이 집계에 섞여 들어가 조용히 틀린다.
 *    도메인 모양이 아니면 지어내지 않고 빈 값으로 둔다.
 */
const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function domainFromTitle(title: string | undefined): string {
  const candidate = (title ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (!DOMAIN_SHAPE.test(candidate)) {
    if (candidate) {
      console.warn(
        `[gemini] title이 도메인 모양이 아니라 도메인을 비워둔다: "${title}". ` +
          `구글이 title 의미를 바꿨을 수 있으니 실측 재확인 필요.`
      );
    }
    return '';
  }
  return candidate;
}

// ───────────────────────────────────────────────────────────
// 어댑터
// ───────────────────────────────────────────────────────────

export const geminiAdapter: EngineAdapter = {
  engineName: 'gemini',

  async ask(query: string): Promise<AdapterResponse> {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY 환경변수가 설정되지 않았습니다.');
    }

    const timestamp = new Date().toISOString();

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: query }],
          },
        ],
        tools: [
          {
            google_search: {},
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Gemini API 오류 (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();

    const candidate = data.candidates?.[0];

    // ── 답변 텍스트 ──────────────────────────────────────────
    /**
     * parts[0]만 쓰지 않고 텍스트 part를 전부 이어 붙이는 이유:
     *   parts가 여러 개인데 [0]만 쓰면 뒷부분이 통째로 잘리고,
     *   그러면 groundingSupports의 구간 좌표가 전부 어긋난다(범위 밖이 됨).
     *   측정 도구에서 이건 "조용히 틀린 값"이라 가장 위험한 실패다.
     *
     * (2026-08-17 실측 확인) 이번 응답은 parts가 1개였고 키는 text/thoughtSignature였다.
     *   thoughtSignature는 텍스트가 아니라 사고 과정 서명 값이라 본문과 무관하다.
     * ⚠️ 추정: 사고 요약이 별도 part로 오는 경우 `thought: true`가 붙는 것으로 알려져 있어
     *   그 part는 답변 본문이 아니므로 제외했다. 실제로 그런 응답은 아직 관측하지 못했다.
     * ⚠️ 추정: parts가 2개 이상일 때 Gemini의 구간 좌표가 "이어 붙인 전체 텍스트" 기준인지는
     *   미확인이다. 그런 응답을 만나면 아래 경고 로그가 뜨므로, 그때 반드시 실측 검증할 것.
     */
    const parts: unknown[] = candidate?.content?.parts ?? [];
    const textParts = parts.filter(
      (p): p is { text: string } =>
        typeof (p as { text?: unknown })?.text === 'string' &&
        (p as { thought?: boolean })?.thought !== true
    );
    if (textParts.length > 1) {
      console.warn(
        `[gemini] 텍스트 part가 ${textParts.length}개다. 구간 좌표 기준이 이어 붙인 전체 텍스트인지 실측 검증 필요.`
      );
    }
    const rawText = textParts.map((p) => p.text).join('');

    const groundingMetadata = candidate?.groundingMetadata;

    // ── 본 것(retrieved): 검색으로 받아온 후보 출처 목록 ──────
    /**
     * ⚠️ chunk의 uri는 실제 사이트 주소가 아니라
     *    vertexaisearch.cloud.google.com/grounding-api-redirect/... 형태의
     *    구글 리다이렉트 래퍼다(2026-08-17 실측 확인).
     *    그래서 도메인 기준으로 브랜드를 매칭하면 전부 google 도메인으로 잡힌다.
     *    실제 도메인은 title 필드에 들어온다(예: "onetopdental.com").
     *    → 뒤쪽에서 도메인 비교가 필요하면 title을 봐야 하고,
     *      최종 URL이 필요하면 리다이렉트를 따라가는 별도 해석 단계가 필요하다.
     *      (이 어댑터의 책임 밖이라 여기서는 원본을 그대로 보존만 한다)
     *
     * chunkIndex ↔ 배열 위치를 반드시 유지해야 한다.
     * groundingSupports는 "원본 groundingChunks 배열의 인덱스"로 출처를 가리키므로,
     * uri 없는 chunk를 그냥 filter로 걸러내면 뒤쪽 인덱스가 한 칸씩 밀려
     * 엉뚱한 출처가 붙는다. 그래서 자리를 비워 둔(null) 배열을 따로 만든다.
     */
    const rawChunks: unknown[] = groundingMetadata?.groundingChunks ?? [];
    const sourceByChunkIndex: (RetrievedSource | null)[] = rawChunks.map(
      (chunk) => {
        const web = (chunk as { web?: { uri?: string; title?: string } })?.web;
        if (!web?.uri) return null; // web이 아닌 chunk(예: 사내 검색)는 여기선 다루지 않음
        return {
          url: normalizeUrl(web.uri),
          rawUrl: web.uri,
          // ⚠️ 주소에서 뽑지 않는다. 주소가 구글 중계 주소라 전부 google이 된다.
          domain: domainFromTitle(web.title),
          title: web.title,
          // snippet: Gemini는 검색 결과 미리보기 텍스트를 주지 않는다(2026-08-17 실측 확인)
        };
      }
    );
    const retrievedSources: RetrievedSource[] = sourceByChunkIndex.filter(
      (s): s is RetrievedSource => s !== null
    );

    // ── 사용한 것(cited): 답변 구간 ↔ 출처 매핑 ───────────────
    const byteToChar = buildByteToCharIndexMap(rawText);
    const rawSupports: unknown[] = groundingMetadata?.groundingSupports ?? [];
    const citedSpans: CitedSpan[] = [];

    for (const support of rawSupports) {
      const s = support as {
        segment?: { startIndex?: number; endIndex?: number; text?: string };
        groundingChunkIndices?: number[];
      };
      const segment = s.segment;
      if (!segment || typeof segment.endIndex !== 'number') continue;

      /**
       * startIndex가 아예 없는 경우가 있다 (2026-08-17 실측: 19개 중 1개).
       * 값이 0일 때 protobuf 기본값이라 JSON 직렬화에서 생략되기 때문이다.
       * 실측에서 생략된 구간은 답변 맨 앞 문장(endIndex=132)이었다 → 0으로 보는 게 맞다.
       * ⚠️ 그래서 `?? 0`이지 `|| 0`이 아니다. 0을 "없음"으로 오해하면 안 된다.
       */
      const startByte = segment.startIndex ?? 0;
      const endByte = segment.endIndex;

      // 출처 URL 모으기 — 인덱스가 범위를 벗어나거나 빈 자리면 건너뛴다(방어)
      const sources: CitedSource[] = [];
      for (const idx of s.groundingChunkIndices ?? []) {
        const source =
          typeof idx === 'number' ? sourceByChunkIndex[idx] : undefined;
        if (!source) {
          // 조용히 넘기지 않는다: 인덱스가 어긋난다는 건 응답 구조가 바뀌었다는 신호다
          console.warn(
            `[gemini] groundingChunkIndices의 ${idx}번 출처를 찾을 수 없다 (chunk 개수 ${rawChunks.length}).`
          );
          continue;
        }
        // 같은 출처가 한 구간에 중복으로 붙는 경우가 있어 고유화한다
        if (!sources.some((x) => x.url === source.url)) {
          sources.push({ url: source.url, domain: source.domain });
        }
      }
      if (sources.length === 0) continue; // 근거 출처가 하나도 없으면 "사용한 것"이 아니다

      // 바이트 → 글자 변환
      const startChar = byteToCharIndex(byteToChar, startByte);
      const endChar = byteToCharIndex(byteToChar, endByte);

      if (
        startChar !== null &&
        endChar !== null &&
        (typeof segment.text !== 'string' ||
          rawText.slice(startChar, endChar) === segment.text)
      ) {
        /**
         * 변환 결과를 segment.text와 대조해 확인된 경우에만 'exact'로 표시한다.
         * (2026-08-17 실측: 19개 구간 전부 slice 결과가 segment.text와 정확히 일치)
         * 확인 없이 'exact'라고 적으면, 좌표가 틀려도 뒤쪽 코드가 그걸 믿어버린다.
         */
        citedSpans.push({
          startIndex: startChar,
          endIndex: endChar,
          sources,
          precision: 'exact',
        });
        continue;
      }

      /**
       * 변환/대조 실패 처리 — 구간을 버리지 않는다.
       *   버리면 "이 출처는 답변에 안 쓰였다"는 사실이 아닌 결론이 나오기 때문이다.
       *
       * 1순위 복구: segment.text를 rawText에서 직접 찾는다.
       *   찾으면 좌표가 글자 단위로 정확하므로 'exact'를 유지한다.
       * 2순위: 그래도 못 찾으면 변환된(또는 범위로 자른) 좌표를 넣되
       *   precision을 'block'으로 낮춘다.
       *   ⚠️ 'exact'로 두면 "글자 단위로 정확하다"는 거짓말이 된다.
       *      'block'은 이 프로젝트에서 "좌표가 대략적이다"는 뜻으로 쓰는 가장 낮은 신뢰도 표시다.
       *      브랜드↔출처 연결 로직은 precision을 보고 다르게 동작해야 한다(types.ts 참고).
       *
       * ⚠️ 어떤 조건에서 여기로 오나: 바이트 오프셋이 멀티바이트 글자 한가운데를 가리키거나,
       *    Gemini가 좌표 기준을 바꿨거나(글자 단위로 전환 등), 위의 parts 이어붙이기 가정이
       *    틀렸을 때. 셋 다 조용히 틀리면 위험해서 경고 로그를 남긴다.
       */
      if (typeof segment.text === 'string' && segment.text.length > 0) {
        const found = rawText.indexOf(segment.text);
        if (found !== -1) {
          console.warn(
            `[gemini] 구간 좌표 변환이 어긋나 텍스트 검색으로 복구했다 (byte ${startByte}~${endByte}).`
          );
          citedSpans.push({
            startIndex: found,
            endIndex: found + segment.text.length,
            sources,
            precision: 'exact',
          });
          continue;
        }
      }

      console.warn(
        `[gemini] 구간 좌표를 확정하지 못해 precision을 'block'으로 낮춘다 (byte ${startByte}~${endByte}).`
      );
      citedSpans.push({
        startIndex: Math.min(startChar ?? 0, rawText.length),
        endIndex: Math.min(endChar ?? rawText.length, rawText.length),
        sources,
        precision: 'block',
      });
    }

    return {
      engine: 'gemini',
      query,
      rawText,
      retrievedSources,
      citedSpans,
      // 하위 호환 필드 — citedSpans에서 파생시킨다.
      // "본 것"이 아니라 "사용한 것" 기준이어야 다른 엔진과 비교가 성립한다(CLAUDE.md 용어 정의).
      citations: getCitedUrls(citedSpans),
      timestamp,
      model: MODEL,
      /**
       * 검색 수행 여부는 "본 것"이 하나라도 있는지로 판단한다.
       * 기존 코드는 citations(=사용한 것) 유무로 봤는데, 그러면
       * "검색은 했지만 답변에 인용을 안 붙인" 경우를 검색 안 한 것으로 잘못 기록한다.
       * (검색 자체를 안 하면 groundingChunks가 비어서 온다 — 2026-08-07 실측)
       */
      searchPerformed: retrievedSources.length > 0,
      overviewShown: null, // Tier 2 엔진 - 이 개념 자체가 해당 없음
    };
  },
};
