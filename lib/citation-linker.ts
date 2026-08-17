// lib/citation-linker.ts

/**
 * 브랜드 언급 ↔ 출처 연결 (Day 8 본 과제 = "link 감지")
 * ═══════════════════════════════════════════════════════
 *
 * 왜 이게 필요한가:
 *   이전에는 답변 전체의 출처 목록을 그 답변에 등장한 모든 브랜드에
 *   똑같이 복사해서 저장했다. 그래서 mentions.source_urls는 이름과 달리
 *   "이 브랜드의 출처"가 아니라 "이 답변의 출처"였고,
 *   "어느 블로그가 우리를 띄우는가"라는 진단 자체가 불가능했다.
 *
 * ─────────────────────────────────────────────────────────
 * 판정 규칙 (2026-08-17 확정)
 * ─────────────────────────────────────────────────────────
 *  1. 브랜드 이름이 있는 **문단** 안의 출처 구간만 그 브랜드에 붙인다.
 *     문단 = 줄바꿈(\n)으로 나뉜 덩어리.
 *     → AI 답변은 "- 병원이름: 설명[1][3]" 같은 목록으로 답하는 경우가 많다.
 *       빈 줄 기준으로 묶으면 목록 전체가 한 덩어리가 되어, 서로 다른 병원의
 *       출처가 전부 섞인다. 줄 단위로 끊어야 병원별로 갈린다.
 *
 *  2. 확신도를 함께 기록한다.
 *     - confirmed(확실) : 그 문단에 브랜드가 **하나뿐**
 *     - estimated(추정) : 그 문단에 브랜드가 **여럿** (어느 출처가 누구 근거인지 알 수 없음)
 *     - none(출처 없음) : 그 문단에 출처 구간이 하나도 없음
 *
 *  3. 출처가 없으면 근처에서 끌어오지 않는다.
 *     "AI가 근거 없이 이름만 언급했다"는 것도 사실이고, 그 자체가 정보다.
 *     끌어오면 그 사실이 사라진다.
 *
 * ⚠️ 가장 중요한 한계 — 이 확신도는 **우리가 만든 추론**이다.
 *    AI가 알려주는 건 "이 문장의 근거는 이 출처"까지이고,
 *    "그 문장 안의 어느 브랜드 얘기인지"는 알려주지 않는다.
 *    그래서 confirmed조차 "문단에 브랜드가 하나뿐이라 그럴 것"이라는 추론이다.
 *    클라이언트에게 보여줄 때 "엔슬의 판정 기준"임을 밝혀야 한다.
 *
 * ⚠️ 엔진별 차이 (2026-08-17 실측):
 *    ChatGPT의 출처 구간은 본문 속 인용 표시 "([도메인](URL))" 자체만 가리키고
 *    브랜드 이름은 그 앞에 있다. 그래서 "구간 안에서 브랜드 찾기"로 짜면
 *    ChatGPT만 결과가 0건이 된다. 이 파일이 문단 단위로 매칭하는 이유가 이것이다.
 */

import type { CitedSpan } from './types';
import type { OverallMention } from './parser';

export type CitationConfidence = 'confirmed' | 'estimated' | 'none';

export interface LinkedCitation {
  /** 이 브랜드에 연결된 출처 주소들 (중복 제거) */
  urls: string[];

  /**
   * 이 브랜드에 연결된 출처 도메인들 (중복 제거).
   * ⚠️ 엔진 간 비교는 반드시 이 값으로 한다. urls로 비교하면 Gemini만
   *    구글 중계 주소라서 다른 엔진과 절대 매칭되지 않는다.
   */
  domains: string[];

  confidence: CitationConfidence;
}

/** 문단 하나의 범위 (rawText 기준, end는 exclusive) */
interface Paragraph {
  start: number;
  end: number;
}

/**
 * rawText를 줄바꿈 단위로 잘라 각 문단의 위치 범위를 만든다.
 *
 * 왜 문자열이 아니라 "범위"로 다루는가:
 *   브랜드 위치(position)와 출처 구간(startIndex/endIndex)이 전부
 *   rawText 기준 글자 위치이기 때문이다. 같은 좌표계에서 비교해야
 *   "이 브랜드와 이 출처가 같은 문단에 있나"를 판정할 수 있다.
 */
function splitIntoParagraphs(rawText: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let start = 0;

  for (let i = 0; i < rawText.length; i++) {
    if (rawText[i] === '\n') {
      paragraphs.push({ start, end: i });
      start = i + 1;
    }
  }
  paragraphs.push({ start, end: rawText.length }); // 마지막 줄

  return paragraphs;
}

/** 위치 pos가 속한 문단을 찾는다. 못 찾으면 null */
function findParagraph(paragraphs: Paragraph[], pos: number): Paragraph | null {
  return paragraphs.find((p) => pos >= p.start && pos < p.end) ?? null;
}

/**
 * 출처 구간이 이 문단과 겹치는지 판정한다.
 *
 * 왜 "포함"이 아니라 "겹침"인가:
 *   Claude는 문단(text 블록) 통째로 구간을 주기 때문에, 구간이 문단보다
 *   크거나 여러 문단에 걸칠 수 있다. "완전히 포함될 때만"으로 하면
 *   Claude 출처가 하나도 안 붙는다.
 */
function overlaps(span: CitedSpan, paragraph: Paragraph): boolean {
  return span.startIndex < paragraph.end && span.endIndex > paragraph.start;
}

/**
 * 브랜드 멘션 각각에 출처를 연결한다.
 *
 * @param rawText     AI 답변 원문 (모든 좌표의 기준)
 * @param mentions    파서가 찾아낸 브랜드 언급들 (등록 + 미등록)
 * @param citedSpans  어댑터가 뽑아낸 "사용한 것" 구간들
 * @returns mentions와 **같은 순서·같은 길이**의 배열.
 *          (인덱스로 짝지으므로 순서를 바꾸면 안 된다)
 */
export function linkCitationsToMentions(
  rawText: string,
  mentions: OverallMention[],
  citedSpans: CitedSpan[]
): LinkedCitation[] {
  const paragraphs = splitIntoParagraphs(rawText);

  // 문단별 브랜드 개수를 미리 세어둔다 (확신도 판정용).
  // 같은 브랜드가 한 문단에 두 번 나와도 1개로 센다 — 확신도는
  // "다른 브랜드와 섞였는가"를 보는 것이지 등장 횟수가 아니다.
  const brandNamesByParagraph = new Map<number, Set<string>>();

  for (const mention of mentions) {
    const paragraph = findParagraph(paragraphs, mention.position);
    if (!paragraph) continue;

    const key = paragraph.start;
    if (!brandNamesByParagraph.has(key)) brandNamesByParagraph.set(key, new Set());
    brandNamesByParagraph.get(key)!.add(mention.brandName);
  }

  return mentions.map((mention) => {
    const paragraph = findParagraph(paragraphs, mention.position);

    // 문단을 못 찾는 경우는 이론상 없지만(모든 위치는 어떤 문단엔가 속한다),
    // 좌표가 어긋났을 때 조용히 틀리지 않도록 명시적으로 처리한다.
    if (!paragraph) {
      return { urls: [], domains: [], confidence: 'none' as const };
    }

    const spansInParagraph = citedSpans.filter((span) => overlaps(span, paragraph));

    if (spansInParagraph.length === 0) {
      // 규칙 3: 근처에서 끌어오지 않는다.
      // "언급은 됐지만 AI가 근거를 제시하지 않았다"는 사실을 그대로 남긴다.
      return { urls: [], domains: [], confidence: 'none' as const };
    }

    const urls = new Set<string>();
    const domains = new Set<string>();
    for (const span of spansInParagraph) {
      for (const source of span.sources) {
        urls.add(source.url);
        if (source.domain) domains.add(source.domain);
      }
    }

    const brandCount = brandNamesByParagraph.get(paragraph.start)?.size ?? 1;

    return {
      urls: Array.from(urls),
      domains: Array.from(domains),
      // 규칙 2: 문단에 브랜드가 하나뿐이면 확실, 여럿이면 추정
      confidence: (brandCount === 1 ? 'confirmed' : 'estimated') as CitationConfidence,
    };
  });
}
