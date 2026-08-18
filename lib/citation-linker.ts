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
 * 판정 규칙 (2026-08-18, Day 12에서 재설계)
 * ─────────────────────────────────────────────────────────
 *
 * ⚠️ 이 규칙은 2026-08-17 확정판을 대체한다. 원래는 "문단 = 줄바꿈으로
 *    나뉜 덩어리"였는데, Day 12 실측에서 AI가 "1. **브랜드명**" 다음 줄들에
 *    설명을 늘어놓는 형식으로 답할 때, 브랜드 이름이 있는 문단(제목 줄
 *    하나)에는 설명이 하나도 안 딸려온다는 게 드러났다. 그래서 "문단"의
 *    정의 자체를 바꿨다 — 아래는 새 규칙.
 *
 *  1. 브랜드 이름이 있는 위치부터 "다음 브랜드가 등장하는 지점"과
 *     "다음 마크다운 제목(#…)이 나오는 지점" 중 더 먼저 오는 곳까지를
 *     그 브랜드의 **구간**으로 본다. 그 구간 안의 출처 구간만 이 브랜드에
 *     붙인다. (computeBrandSegments 참고)
 *
 *  2. 확신도를 함께 기록한다.
 *     - confirmed(확실) : 구간 텍스트 안에 다른 브랜드 이름(정식명칭·별칭
 *       포함)이 하나도 없음
 *     - estimated(추정) : 구간 텍스트 안에 다른 브랜드 이름이 등장함
 *       (예: "더와이즈치과병원은 원탑치과보다 저렴합니다" — 더와이즈 구간
 *       안에 "원탑치과"라는 글자가 있으므로 estimated)
 *     - none(출처 없음) : 그 구간에 출처 구간이 하나도 없음
 *     ⚠️ 옛 규칙("문단에 브랜드가 몇 개 있나" 개수 세기)은 이제 못 쓴다 —
 *     구간이 애초에 브랜드가 나올 때 끊기므로, 구간 하나에 앵커 브랜드
 *     하나만 있는 게 항상 참이 되어(정의상) 개수 세기가 무의미해진다.
 *     그래서 "텍스트 안에 다른 이름이 글자로 있는가"로 바꿨다.
 *
 *  3. 출처가 없으면 근처에서 끌어오지 않는다.
 *     "AI가 근거 없이 이름만 언급했다"는 것도 사실이고, 그 자체가 정보다.
 *
 * ⚠️ 가장 중요한 한계 — 이 확신도는 **우리가 만든 추론**이다.
 *    AI가 알려주는 건 "이 문장의 근거는 이 출처"까지이고,
 *    "그 문장 안의 어느 브랜드 얘기인지"는 알려주지 않는다.
 *    클라이언트에게 보여줄 때 "엔슬의 판정 기준"임을 밝혀야 한다.
 *
 * ⚠️ 새 방식의 한계 (2026-08-18 확인): 한 문장에 여러 브랜드가 같이
 *    언급되면("A와 B 모두 ~"), 그 설명은 뒤쪽 브랜드 구간에만 들어가고
 *    앞쪽 브랜드는 못 받는다. 문장을 의미 단위로 이해해야 풀리는 문제라
 *    이번 범위 밖 — 부채로 남겨둔다(노션 트래커 참고).
 *
 * ⚠️ 엔진별 차이 (2026-08-17 실측):
 *    ChatGPT의 출처 구간은 본문 속 인용 표시 "([도메인](URL))" 자체만
 *    가리키고 브랜드 이름은 그 앞에 있다. 그래서 "구간 안에서 브랜드
 *    찾기"로 짜면 ChatGPT만 결과가 0건이 된다. 이 파일이 문단(이제는
 *    구간) 단위로 매칭하는 이유가 이것이다.
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

/** 브랜드 구간 하나 (rawText 기준, end는 exclusive) */
export interface BrandSegment {
  /** 이 구간을 시작시킨 브랜드 이름 */
  anchorBrandName: string;
  start: number;
  end: number;
}

/**
 * 알려진 모든 브랜드 언급 위치를 기준으로 rawText를 구간으로 나눈다.
 *
 * 구간 하나 = 한 브랜드가 처음 등장한 위치부터, "다음 브랜드가 등장하는
 * 지점"과 "다음 마크다운 제목(#…)이 나오는 지점" 중 더 먼저 오는 곳까지.
 *
 * 왜 줄바꿈이 아니라 이 기준으로 바꿨는가 (2026-08-18, Day 12 실측에서 발견):
 *   AI 답변이 "1. **브랜드명**" 다음 줄들에 설명을 늘어놓는 형식으로 올 때,
 *   줄바꿈 기준 분리로는 브랜드 이름이 있는 문단(제목 줄 하나)에 설명이
 *   하나도 안 딸려왔다. 브랜드 위치부터 다음 브랜드 전까지를 통째로 봐야
 *   실제 설명이 포함된다.
 *
 * ⚠️ 한계: 한 문장에 여러 브랜드가 같이 언급되면("A와 B 모두 ~"), 그 설명은
 *    뒤쪽 브랜드 구간에만 들어가고 앞쪽 브랜드는 못 받는다. 문장을 의미
 *    단위로 이해해야 풀리는 문제라 이번 범위 밖 — 부채로 남겨둔다.
 */
export function computeBrandSegments(
  rawText: string,
  mentions: { brandName: string; position: number }[]
): BrandSegment[] {
  const sorted = [...mentions].sort((a, b) => a.position - b.position);

  // 마크다운 제목 줄(#, ##, ...)들의 시작 위치를 미리 찾아둔다.
  const headingPositions: number[] = [];
  let offset = 0;
  for (const line of rawText.split('\n')) {
    if (/^#{1,6}\s/.test(line)) headingPositions.push(offset);
    offset += line.length + 1; // +1은 잘려나간 '\n' 길이
  }

  return sorted.map((m, i) => {
    const nextBrandPos = i + 1 < sorted.length ? sorted[i + 1].position : Infinity;
    const nextHeadingPos = headingPositions.find((p) => p > m.position) ?? Infinity;
    const end = Math.min(nextBrandPos, nextHeadingPos, rawText.length);
    return { anchorBrandName: m.brandName, start: m.position, end };
  });
}

/** 구간의 실제 텍스트를 꺼낸다 */
export function getSegmentText(rawText: string, segment: BrandSegment): string {
  return rawText.slice(segment.start, segment.end);
}

/**
 * 이 구간(segment) 텍스트 안에, 구간을 시작시킨 브랜드 말고 다른 브랜드
 * 이름(정식명칭 또는 별칭)이 하나라도 등장하는지 확인한다.
 *
 * 새 확신도 규칙의 핵심 (2026-08-18, Day 12 리팩터에서 확정):
 *   옛날 방식(줄바꿈 문단)은 "이 문단에 브랜드가 몇 개 있나" 개수를 셌다.
 *   근데 브랜드 구간은 애초에 브랜드가 나올 때 끊기 때문에, 구간 하나에
 *   그 구간을 시작시킨 브랜드만 있는 게 항상 참이 되어버려서(정의상) 개수
 *   세기가 무의미해졌다. 대신 "다른 브랜드 이름이 텍스트로 남아있는가"를
 *   본다 — "더와이즈치과병원은 원탑치과보다 저렴합니다" 같은 비교 문장에서
 *   더와이즈 구간 안에 "원탑치과"라는 글자가 실제로 있는 걸 잡아낸다.
 *
 * ⚠️ 정식명칭만 검사하면 놓친다 — 실측에서 "원탑치과"(별칭)는 잡히는데
 *    "365서울원탑치과"(정식명칭)만 검사하면 못 잡는 걸 확인했다. 그래서
 *    별칭까지 전부 후보로 넣어야 한다.
 */
function segmentMentionsOtherBrand(
  segmentText: string,
  anchorBrandName: string,
  allBrands: { name: string; aliases: string[] }[]
): boolean {
  const others = allBrands.filter((b) => b.name !== anchorBrandName);

  for (const other of others) {
    const candidates = [other.name, ...other.aliases];
    if (candidates.some((c) => segmentText.includes(c))) {
      return true;
    }
  }

  return false;
}

/**
 * 브랜드 멘션 각각에 출처를 연결한다.
 *
 * @param rawText     AI 답변 원문 (모든 좌표의 기준)
 * @param mentions    파서가 찾아낸 브랜드 언급들 (등록 + 미등록)
 * @param citedSpans  어댑터가 뽑아낸 "사용한 것" 구간들
 * @param knownBrands 확신도 판정에 쓸 브랜드 사전(정식명칭+별칭). Day 12
 *                    리팩터에서 새로 추가된 매개변수 —
 *                    segmentMentionsOtherBrand가 "다른 브랜드 이름이
 *                    텍스트에 있는지" 검사할 때 별칭까지 알아야 한다.
 * @returns mentions와 **같은 순서·같은 길이**의 배열.
 *          (인덱스로 짝지으므로 순서를 바꾸면 안 된다)
 */
export function linkCitationsToMentions(
  rawText: string,
  mentions: OverallMention[],
  citedSpans: CitedSpan[],
  knownBrands: { name: string; aliases: string[] }[]
): LinkedCitation[] {
  const segments = computeBrandSegments(rawText, mentions);

  // mention.brandName → 그 mention의 구간, 빠르게 찾기 위한 매핑
  const segmentByBrandName = new Map<string, BrandSegment>();
  for (const seg of segments) {
    segmentByBrandName.set(seg.anchorBrandName, seg);
  }

  return mentions.map((mention) => {
    const segment = segmentByBrandName.get(mention.brandName);

    // 구간을 못 찾는 경우는 이론상 없지만(모든 mention이 자기 구간의
    // anchor이므로), 좌표가 어긋났을 때 조용히 틀리지 않도록 명시적으로
    // 처리한다.
    if (!segment) {
      return { urls: [], domains: [], confidence: 'none' as const };
    }

    const spansInSegment = citedSpans.filter(
      (span) => span.startIndex < segment.end && span.endIndex > segment.start
    );

    if (spansInSegment.length === 0) {
      // 규칙 3: 근처에서 끌어오지 않는다.
      // "언급은 됐지만 AI가 근거를 제시하지 않았다"는 사실을 그대로 남긴다.
      return { urls: [], domains: [], confidence: 'none' as const };
    }

    const urls = new Set<string>();
    const domains = new Set<string>();
    for (const span of spansInSegment) {
      for (const source of span.sources) {
        urls.add(source.url);
        if (source.domain) domains.add(source.domain);
      }
    }

    const segmentText = getSegmentText(rawText, segment);
    const hasOtherBrand = segmentMentionsOtherBrand(segmentText, mention.brandName, knownBrands);

    return {
      urls: Array.from(urls),
      domains: Array.from(domains),
      // 규칙 2: 구간 안에 다른 브랜드 이름이 없으면 확실, 있으면 추정
      confidence: (hasOtherBrand ? 'estimated' : 'confirmed') as CitationConfidence,
    };
  });
}