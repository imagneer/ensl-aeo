// lib/source-analysis.ts

/**
 * "인지와 추천, 그 사이" 화면(Day23) — "AI는 어디서 정보를 가져올까" 섹션의
 * 순수 계산 함수. DB 접근(mentions.source_urls, brand_owned_channels 조회)은
 * app/(dashboard)/gap/page.tsx가 lib/supabase.ts로 끝내고, 이 파일은 URL
 * 목록을 입력으로 받아 소유/외부 비율·상위 도메인을 파생시킨다.
 *
 * ⚠️ "판정불가"(unresolvable) — vertexaisearch.cloud.google.com(Gemini)과
 * google.com/searchviewer(구글 AIO)는 실제로 인용한 도메인을 감춘 채
 * 리다이렉트 주소만 노출한다(2026-09-08 확인, docs/claude_day8-decision-
 * citation-linking.md). 이건 "소유인지 외부인지 판단이 애매하다"가 아니라
 * "어느 도메인인지 그 자체를 알 수 없다"는 뜻이라 third_party로 넣으면
 * 외부 비율이 실제보다 부풀려진다 — 그래서 비율 계산의 분모(판정 가능
 * 건수)에서 아예 뺀다.
 */

export type SourceClassification = 'owned' | 'third_party' | 'unresolvable';

/** 프로토콜·www.·m. 접두어를 제거해서 비교하기 쉬운 형태로 만든다. */
function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^m\./i, '');
}

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').replace(/^m\./i, '');
  } catch {
    return null;
  }
}

const UNRESOLVABLE_PATTERNS = [/^vertexaisearch\.cloud\.google\.com/i, /^google\.com\/searchviewer/i];

export function classifySourceUrl(url: string, ownedPatterns: string[]): SourceClassification {
  const normalized = normalizeUrl(url);
  if (UNRESOLVABLE_PATTERNS.some((re) => re.test(normalized))) return 'unresolvable';
  if (ownedPatterns.some((p) => normalized.includes(normalizeUrl(p)))) return 'owned';
  return 'third_party';
}

export interface SourceAnalysisResult {
  /** 판정 가능(owned+third_party) 건수 — 비율의 분모. */
  resolvableCount: number;
  unresolvableCount: number;
  ownedCount: number;
  thirdPartyCount: number;
  /** 0~1. resolvableCount가 0이면 0. */
  ownedRate: number;
  /** 소유/외부 안 가리고 건수 기준 상위 도메인(작업지시서 §2-3). */
  topDomains: { domain: string; count: number }[];
}

export function buildSourceAnalysis(
  urls: string[],
  ownedPatterns: string[],
  topDomainsN = 15
): SourceAnalysisResult {
  let ownedCount = 0;
  let thirdPartyCount = 0;
  let unresolvableCount = 0;
  const countByDomain = new Map<string, number>();

  for (const url of urls) {
    const classification = classifySourceUrl(url, ownedPatterns);
    if (classification === 'owned') ownedCount++;
    else if (classification === 'third_party') thirdPartyCount++;
    else unresolvableCount++;

    const domain = extractHostname(url);
    if (domain) countByDomain.set(domain, (countByDomain.get(domain) ?? 0) + 1);
  }

  const resolvableCount = ownedCount + thirdPartyCount;
  const topDomains = [...countByDomain.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topDomainsN)
    .map(([domain, count]) => ({ domain, count }));

  return {
    resolvableCount,
    unresolvableCount,
    ownedCount,
    thirdPartyCount,
    ownedRate: resolvableCount > 0 ? ownedCount / resolvableCount : 0,
    topDomains,
  };
}
