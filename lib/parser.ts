// lib/parser.ts

/**
 * AI 응답 텍스트(rawText)에서 브랜드 멘션을 추출하는 파서.
 *
 * 지금 단계: 규칙 기반(문자열 검색)으로 1~3번만 처리.
 *   1. 브랜드 멘션 감지
 *   2. 순위 추출 (등장 위치 기반 — 방식 1)
 *   3. 경쟁사 3단계 판정
 * 4번(노출 키워드 추출)은 LLM 기반으로 나중에 별도 구현.
 */

/**
 * ⚠️ 중요: rankAmongKnown 필드에 대한 주의사항
 * ─────────────────────────────────────────
 * 이 값은 "KNOWN_BRANDS에 등록된 브랜드들 사이에서의 순위"다.
 * 원문에 등장한 순서 그대로의 절대 순위가 아니다.
 *
 * 예시: 원문 등장 순서가 [더와이즈, 마곡베스트(미등록), 원탑, 연세힐]이면
 *   - 실제 절대 순위: 원탑은 3위
 *   - rankAmongKnown: 원탑은 2위 (미등록인 마곡베스트가 빠졌으므로)
 *
 * 대시보드에 이 숫자를 그대로 "N위"라고 표시하면 오해를 살 수 있다.
 * 미등록 브랜드까지 포함한 절대 순위가 필요하면 position 값을 기준으로
 * 별도 계산해야 하며, 이는 미등록 브랜드 자동 감지 기능이 붙어야 완성된다
 * (Day 6~7 과제, 아직 미구현).
 */

// ── 브랜드 사전 (임시 하드코딩, 나중에 DB에서 가져오도록 교체) ──
// brand_id는 Supabase의 실제 UUID로 나중에 교체 필요.
export interface KnownBrand {
  brandId: string;      // Supabase brands.id (지금은 임시 문자열)
  name: string;          // 정식 명칭
  aliases: string[];     // 같은 브랜드를 가리키는 다른 표현들
  isTarget: boolean;      // 타겟 브랜드 여부 (365서울원탑치과 = true)
}

// ── 미등록 브랜드 감지용 정규식 + 예외 처리 ──

// "OO치과", "OO치과의원", "OO치과병원" 패턴.
// [가-힣]{2,20} = 한글 2~20글자, 그 뒤에 "치과"가 오고, "의원"/"병원"은 있어도 없어도 됨.
// (2026-08-07: 10글자 제한에서 20글자로 확장 — "자연치아살리기강서모아치과의원"처럼
//  11글자 이상 상호명이 실측에서 확인되어 앞글자가 잘리는 문제 발견 후 수정)
const CLINIC_NAME_PATTERN = /[가-힣]{2,20}치과(?:의원|병원)?/g;

// 브랜드 이름이 아니라 그냥 지시어인데 정규식에 걸릴 수 있는 단어들.
// "우리 치과", "근처 치과의원" 같은 문장에서 오탐(가짜 감지)을 막기 위한 목록.
// ⚠️ 완벽하지 않음 — 새로운 오탐 사례가 나오면 계속 추가해야 하는 목록.
const NON_BRAND_PREFIXES = [
  '우리', '저희', '근처', '동네', '해당', '이', '그', '저',
  '다른', '다른곳', '유명한', '최고의', '가까운', '인근',
];

function isLikelyRealBrandName(matchedText: string): boolean {
  // 매칭된 텍스트가 제외 단어로 시작하면 브랜드 이름이 아닐 가능성이 높음
  return !NON_BRAND_PREFIXES.some((prefix) => matchedText.startsWith(prefix));
}


// ── 파싱 결과 타입 ──
export interface ParsedMention {
  brandName: string;
  brandId: string | null;
  isTarget: boolean;
  matchedText: string;
  position: number;          // 원문 전체에서의 글자 위치 (미등록 브랜드 포함해도 변하지 않는 절대 기준)
  rankAmongKnown: number;    // ⚠️ "등록된 브랜드들 사이에서"의 순위. 원문 전체 순위가 아님!
                              //    미등록 경쟁사(예: 마곡베스트치과의원)가 중간에 끼어 있어도 이 숫자엔 반영 안 됨.
}

export interface ParseResult {
  mentions: ParsedMention[];   // 등장 순서대로 정렬된 전체 멘션 목록
  targetMention: ParsedMention | null; // 타겟 브랜드(원탑치과)의 멘션, 없으면 null
  isTargetExposed: boolean;     // 타겟 브랜드가 노출됐는지 여부
}

/**
 * rawText 안에서 KNOWN_BRANDS에 있는 브랜드들을 찾아서
 * 등장 위치 순서대로 순위를 매긴다.
 *
 * 미등록 브랜드(예: "마곡베스트치과의원")는 이 함수에서는 감지하지 않는다.
 * → 이유: 지금은 "알고 있는 이름을 찾는" 방식이라, 모르는 이름은 원천적으로 못 찾음.
 *    미등록 브랜드 자동 발견은 별도 기능(로드맵의 "경쟁사 자동 발견")으로 나중에 붙임.
 */
export function parseBrandMentions(rawText: string, knownBrands: KnownBrand[]): ParseResult {
  // 1단계: 각 브랜드별로 텍스트 안에서 가장 먼저 등장하는 위치를 찾는다.
  const found: Omit<ParsedMention, 'rankAmongKnown'>[] = [];

  for (const brand of knownBrands) {
  // 정식 명칭 + 별칭들을 전부 후보로 검사
    const candidates = [brand.name, ...brand.aliases];

    let earliestPosition = -1;
    let matchedText = '';

    for (const candidate of candidates) {
      const idx = rawText.indexOf(candidate);
      if (idx === -1) continue; // 이 표현은 텍스트에 없음

      // 여러 별칭 중 가장 먼저 나오는 위치를 채택
      if (earliestPosition === -1 || idx < earliestPosition) {
        earliestPosition = idx;
        matchedText = candidate;
      }
    }

    // 텍스트에 아예 없으면(-1) 건너뜀
    if (earliestPosition === -1) continue;

    found.push({
      brandName: brand.name,
      brandId: brand.brandId,
      isTarget: brand.isTarget,
      matchedText,
      position: earliestPosition,
    });
  }

  // 2단계: 등장 위치(position) 기준 오름차순 정렬 → 먼저 나온 순서대로 순위 부여
  found.sort((a, b) => a.position - b.position);

  const mentions: ParsedMention[] = found.map((item, index) => ({
    ...item,
    rankAmongKnown: index + 1, // 등록된 브랜드 내에서의 순위 (전체 순위 아님, 주석 참고)
  }));

  // 3단계: 타겟 브랜드(원탑치과) 멘션 찾기
  const targetMention = mentions.find((m) => m.isTarget) ?? null;

  return {
    mentions,
    targetMention,
    isTargetExposed: targetMention !== null,
  };
}

/**
 * 경쟁사 3단계 판정 로직 (Day 4에서 확정한 규칙).
 *
 * 이 함수는 parseBrandMentions가 찾아낸 "등록된 브랜드"뿐 아니라,
 * 앞으로 별도 로직(정규식 등)으로 "치과" 포함 미등록 상호명을 뽑아냈을 때도
 * 재사용할 수 있도록 범용적으로 만들어둠.
 *
 * 3단계 규칙:
 *   ① 텍스트에서 찾은 이름이 타겟 브랜드와 일치 → is_target = true
 *   ② 등록된 경쟁사(brand_competitors)와 일치 → is_target = false, brand_id 연결
 *   ③ 둘 다 아님(미등록) → brand_id = null (버리지 않고 저장, 나중에 경쟁사 자동발견 재료)
 */
export function classifyMention(
  matchedName: string,
  isKnown: boolean,
  knownBrand?: KnownBrand
): { isTarget: boolean; brandId: string | null } {
  if (isKnown && knownBrand) {
    return {
      isTarget: knownBrand.isTarget,
      brandId: knownBrand.brandId,
    };
  }
  // 미등록 브랜드 — 버리지 않고 null로 저장
  return {
    isTarget: false,
    brandId: null,
  };
}

// ── 미등록 브랜드 관련 타입 ──
export interface UnregisteredMention {
  matchedText: string;      // 대표 표기 (정규화된 이름, "치과"로 끝나는 짧은 형태로 통일)
  position: number;          // 대표 표기가 처음 등장한 위치
  rawVariants: string[];     // 실제로 원문에 등장했던 모든 표기 형태 (예: ["마곡베스트치과", "마곡베스트치과의원"])
}

/**
 * "OO치과의원", "OO치과병원"처럼 뒤에 붙은 접미사를 잘라내고
 * "OO치과" 형태로 통일한다. 표기 흔들림 통합의 핵심 로직.
 *
 * ⚠️ 범위: "치과의원/치과병원 ↔ 치과" 축약형만 처리한다.
 * 어순이 바뀌거나 완전히 다른 줄임말(예: "마곡의 베스트치과")은 다루지 않는다.
 */
function normalizeClinicName(text: string): string {
  return text.replace(/(의원|병원)$/, '');
}

/**
 * rawText에서 KNOWN_BRANDS에 없는 "OO치과" 패턴을 정규식으로 찾는다.
 *
 * 처리 단계:
 *   ① 정규화된 이름이 KNOWN_BRANDS의 정식명칭/별칭을 정규화한 것과 같으면 제외
 *      (예: 정규식이 "서울원탑치과의원"을 찾아도, 정규화하면 "서울원탑치과"가 되고
 *       이게 KNOWN_BRANDS 별칭 "서울원탑치과"와 일치하므로 제외됨)
 *   ② 위치가 알려진 브랜드 구간과 겹치면 제외 (보조 방어선)
 *   ③ 지시어(우리/근처 등)로 시작하는 오탐 제외
 *   ④ "치과의원/치과병원 ↔ 치과" 표기 흔들림을 정규화된 이름 기준으로 통합
 *   ⑤ 정규화된 이름이 같으면 가장 먼저 등장한 위치를 대표로, 모든 표기는 rawVariants에 보존
 *
 * ⚠️ 한계: 위 ①④는 접미사 축약형(의원/병원 ↔ 치과)만 처리한다. 어순 변경이나
 * 완전히 다른 줄임말은 여전히 별개 브랜드로 잡힌다 (범위 밖, 별도 과제).
 */
export function findUnregisteredBrands(
  rawText: string,
  knownMentions: ParsedMention[],
  knownBrands: KnownBrand[]
): UnregisteredMention[] {
  // knownBrands의 모든 이름(정식명칭+별칭)을 정규화한 버전으로 세트 구성
  // → 정규식이 "OO치과의원"을 찾아도 정규화하면 "OO치과"가 되어 이 세트와 비교 가능해짐
  const allKnownNamesNormalized = new Set<string>(
    knownBrands.flatMap((brand) => [brand.name, ...brand.aliases]).map(normalizeClinicName)
  );
  
  const occupiedRanges = knownMentions.map((m) => ({
    start: m.position,
    end: m.position + m.matchedText.length,
  }));

  const rawMatches: { matchedText: string; position: number }[] = [];
  const matches = rawText.matchAll(CLINIC_NAME_PATTERN);

  for (const match of matches) {
    const matchedText = match[0];
    const position = match.index ?? -1;
    if (position === -1) continue;

    // ① 정규화한 이름 기준으로 KNOWN_BRANDS와 비교 (의원/병원 접미사 차이 무시)
    if (allKnownNamesNormalized.has(normalizeClinicName(matchedText))) continue;

    const matchEnd = position + matchedText.length;
    const overlapsKnown = occupiedRanges.some(
      (range) => position < range.end && matchEnd > range.start
    );
    if (overlapsKnown) continue;

    if (!isLikelyRealBrandName(matchedText)) continue;

    rawMatches.push({ matchedText, position });
  }

  const sortedByPosition = [...rawMatches].sort((a, b) => a.position - b.position);

  const groups = new Map<string, { position: number; variants: string[] }>();

  for (const item of sortedByPosition) {
    const normalized = normalizeClinicName(item.matchedText);

    if (!groups.has(normalized)) {
      groups.set(normalized, { position: item.position, variants: [item.matchedText] });
    } else {
      const group = groups.get(normalized)!;
      if (!group.variants.includes(item.matchedText)) {
        group.variants.push(item.matchedText);
      }
    }
  }

  const result: UnregisteredMention[] = Array.from(groups.entries()).map(
    ([normalized, group]) => ({
      matchedText: normalized,
      position: group.position,
      rawVariants: group.variants,
    })
  );

  result.sort((a, b) => a.position - b.position);

  return result;
}

// ── 절대 순위 통합 타입 ──
export interface OverallMention {
  brandName: string;
  brandId: string | null;
  isTarget: boolean;
  isRegistered: boolean;   // KNOWN_BRANDS에 등록된 브랜드인지 여부
  matchedText: string;
  position: number;
  overallRank: number;      // 미등록 브랜드까지 포함한 "진짜" 등장 순서
}

/**
 * 등록 브랜드 + 미등록 브랜드를 합쳐서, 원문 등장 순서 그대로의
 * "절대 순위"(overallRank)를 계산한다.
 * rankAmongKnown과는 다른 값이니 혼동하지 말 것 — 주석 참고.
 */
export function buildOverallRanking(
  parseResult: ParseResult,
  unregistered: UnregisteredMention[]
): OverallMention[] {
  const registeredPart: Omit<OverallMention, 'overallRank'>[] = parseResult.mentions.map((m) => ({
    brandName: m.brandName,
    brandId: m.brandId,
    isTarget: m.isTarget,
    isRegistered: true,
    matchedText: m.matchedText,
    position: m.position,
  }));

  const unregisteredPart: Omit<OverallMention, 'overallRank'>[] = unregistered.map((u) => ({
    brandName: u.matchedText, // 미등록 브랜드는 매칭된 텍스트 자체를 이름으로 사용
    brandId: null,
    isTarget: false,
    isRegistered: false,
    matchedText: u.matchedText,
    position: u.position,
  }));

  const combined = [...registeredPart, ...unregisteredPart];
  combined.sort((a, b) => a.position - b.position);

  return combined.map((item, index) => ({
    ...item,
    overallRank: index + 1,
  }));
}
export interface KnownBrand {
  brandId: string;      // Supabase brands.id (지금은 임시 문자열)
  name: string;          // 정식 명칭
  aliases: string[];     // 같은 브랜드를 가리키는 다른 표현들
  isTarget: boolean;      // 타겟 브랜드 여부 (365서울원탑치과 = true)
  domain: string | null;  // 브랜드 자기 도메인 (S/C 뱃지 판정용, Day 17.x 추가)
}
