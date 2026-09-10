// lib/placement-narrative.ts

/**
 * "인지와 추천, 그 사이" 화면(Day23) — "추천 표현 TOP10"을 자리질문 mentions
 * 원문 전체(우리 브랜드 문단)를 재분석해서 만든다.
 *
 * ⚠️ 왜 aggregated_metrics.top_keywords를 안 쓰는가(2026-09-09 확인,
 * 작업지시서_간극화면_교체_2026-09-09_V1.0.md §2-2): 그 daily 집계는
 * 하루당 표현을 최대 5개까지만 남기고(countTopKeywords cap), 게다가 daily
 * 집계 자체가 실시간 데이터보다 지연될 수 있다(220건 중 200건까지만
 * 데이터가 있던 사례 확인됨). 이 함수는 그 두 문제를 다 피하려고 daily
 * 집계를 거치지 않고 mentions.raw_response를 직접 다시 읽는다.
 *
 * ⚠️ 이것도 "대표 표현 자동 선정" 방식의 한계는 그대로 안고 있다 — 한
 * 문장에 여러 개념이 섞여 있으면 LLM이 그중 하나만 뽑을 수 있고, 여러
 * 브랜드를 한 문장에 나열하는 답변은 특정 브랜드 문단으로 안 잡힌다
 * (2026-09-09 실측 확인, "과잉진료 지양" 사례). 특정 문구의 정확한 빈도가
 * 필요하면 이 결과 말고 원문을 직접 정규식으로 대조하는 게 더 정확하다 —
 * 이건 버그가 아니라 이 방식 자체의 한계라 화면에 별도 경고 문구를
 * 넣지 않기로 했다(작업지시서 §2-2, 코드 주석으로만 남김).
 */

import {
  supabaseAdmin,
  fetchActiveQueries,
  fetchKnownBrands,
  fetchQuerySnapshotsWithMentionsBatch,
  savePlacementNarrativeTop10,
  type PlacementNarrativeTop10Item,
} from './supabase';
import { isValidRecord } from './query-detail';
import { getBrandSegmentText } from './mention-feature-roles';
import { extractExpressionsFromParagraphs, type BrandParagraph } from './keyword-extractor';
import { retryWithBackoff, isRetryableLLMError } from './retry';

const BATCH_SIZE = 10;

export interface PlacementNarrativeTop10Result {
  items: PlacementNarrativeTop10Item[];
  appearedRuns: number;
}

/**
 * 실측(2026-09-09): 365서울원탑치과 1차 진단, 자리질문 9개·220건 기준
 * 배치 크기 10으로 22회 호출, 실제 비용 $0.1642, 약 1분 소요.
 */
export async function computeAndSavePlacementNarrativeTop10(params: {
  brandId: string;
  brandName: string;
  diagnosisId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<PlacementNarrativeTop10Result> {
  const placementQueries = (await fetchActiveQueries(['자리'])).filter((q) => q.brandId === params.brandId);
  const placementQueryIds = placementQueries.map((q) => q.id);

  const recordsByQuery = await fetchQuerySnapshotsWithMentionsBatch(
    placementQueryIds,
    params.periodStart,
    params.periodEnd,
    supabaseAdmin
  );
  const knownBrands = await fetchKnownBrands();

  const paragraphs: BrandParagraph[] = [];
  let appearedRuns = 0;
  for (const records of recordsByQuery.values()) {
    for (const r of records) {
      if (!isValidRecord(r)) continue;
      if (!r.mentions.some((m) => m.isTarget)) continue;
      appearedRuns++;

      const segment = getBrandSegmentText(r.rawResponse, knownBrands, params.brandName);
      if (!segment) continue; // 세그먼트 추출 실패 — mentionsSkippedNoSegment와 같은 종류
      paragraphs.push({ snapshotId: r.id, paragraphText: segment });
    }
  }

  const countByKeyword = new Map<string, number>();
  for (let i = 0; i < paragraphs.length; i += BATCH_SIZE) {
    const batch = paragraphs.slice(i, i + BATCH_SIZE);
    const results = await retryWithBackoff(
      () =>
        extractExpressionsFromParagraphs(params.brandName, batch, {
          kind: 'target',
          runKind: 'cron',
          brandId: params.brandId,
          queryId: null,
          engine: null,
        }),
      3,
      isRetryableLLMError
    );

    for (const r of results) {
      // 한 mention 안에서 같은 표현이 여러 번 잡혀도 "관측 1회"로만 센다 —
      // lib/gap.ts buildPlacementFeatureFrequencyTop10과 같은 규칙(분모와
      // 단위를 맞추기 위함, 알려진 정합성 이슈 1번과 같은 이유).
      const seen = new Set<string>();
      for (const raw of r.expressions) {
        const keyword = raw.trim();
        if (!keyword || seen.has(keyword)) continue;
        seen.add(keyword);
        countByKeyword.set(keyword, (countByKeyword.get(keyword) ?? 0) + 1);
      }
    }
  }

  const items: PlacementNarrativeTop10Item[] = [...countByKeyword.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([keyword, count]) => ({
      keyword,
      count,
      rate: appearedRuns > 0 ? count / appearedRuns : 0,
    }));

  await savePlacementNarrativeTop10({
    diagnosisId: params.diagnosisId,
    brandId: params.brandId,
    items,
    appearedRuns,
  });

  return { items, appearedRuns };
}
