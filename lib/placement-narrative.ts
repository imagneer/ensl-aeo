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
  deletePlacementExpressionClassifications,
  savePlacementExpressionClassifications,
  saveReviewItem,
  type PlacementNarrativeTop10Item,
  type PlacementExpressionClassificationToSave,
} from './supabase';
import { isValidRecord } from './query-detail';
import { getBrandSegmentText, fetchGapFeatureUniverse } from './mention-feature-roles';
import { extractExpressionsFromParagraphs, type BrandParagraph } from './keyword-extractor';
import { retryWithBackoff, isRetryableLLMError } from './retry';
import {
  classifyExpressionBatch,
  type ExpressionForClassification,
  type LeftCandidateForMatching,
} from './placement-expression-classifier';
import { ANTHROPIC_MODEL, ANTHROPIC_MODEL_SONNET, MAX_LLM_CALLS_PER_RUN } from './llm-config';
import { startUsageRun, getUsageRunSummary } from './llm-usage';
import { sendIncidentAlert } from './email-alert';

const BATCH_SIZE = 10;
/** 분류 배치 하나마다 왼쪽 특징 목록(최대 40여개) 전체를 프롬프트에 같이 보내서
 *  고정 오버헤드가 있다 — 배치를 크게 잡아서 판정+검수 2콜/배치의 횟수를 줄인다. */
const CLASSIFICATION_BATCH_SIZE = 20;

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
  // 이 함수가 이번 실행에서 처음 LLM을 부르는 지점이다(app/api/compute-placement-narrative/route.ts는
  // startUsageRun을 안 불러서 getUsageRunSummary가 항상 0을 돌려주고 있었음 — 카테고리
  // 분류 단계가 호출 수를 크게 늘리므로, MAX_LLM_CALLS_PER_RUN 캡이 실제로 동작하게
  // 여기서 시작한다).
  startUsageRun();

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
        extractExpressionsFromParagraphs(
          params.brandName,
          batch,
          {
            kind: 'target',
            runKind: 'cron',
            brandId: params.brandId,
            queryId: null,
            engine: null,
          },
          true // 원자 분해 — 작업지시서_표현정규화_2026-09-16_V1.2 §2단계
        ),
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

  await classifyAndSavePlacementExpressions({
    brandId: params.brandId,
    brandName: params.brandName,
    diagnosisId: params.diagnosisId,
    countByKeyword,
    appearedRuns,
  });

  return { items, appearedRuns };
}

/**
 * 추천 표현 "전체"(top10이 아니라 countByKeyword의 고유 표현 전부)에
 * 카테고리+왼쪽 특징 세부 매칭을 판정해서 저장한다
 * (작업지시서_표현정규화_2026-09-16_V1.2 §2~4단계).
 *
 * top10만이 아니라 전체를 대상으로 하는 이유: "카테고리별 추천 등장 비율"이
 * top10 밖 표현을 누락하면 분모(appearedRuns)는 전체인데 분자만 일부가 돼서
 * 비율이 실제보다 작게 나온다 — 매니페스토 5원칙(수치 일관성) 위반.
 */
async function classifyAndSavePlacementExpressions(params: {
  brandId: string;
  brandName: string;
  diagnosisId: string;
  countByKeyword: Map<string, number>;
  appearedRuns: number;
}): Promise<void> {
  const { brandId, brandName, diagnosisId, countByKeyword, appearedRuns } = params;
  if (countByKeyword.size === 0) return;

  const leftFeatures = await fetchGapFeatureUniverse(brandId, diagnosisId);
  if (leftFeatures.length === 0) return; // 소개 특징이 아직 없으면 매칭 대상 자체가 없음 — 분류 스킵

  const leftCandidates: LeftCandidateForMatching[] = leftFeatures.map((f, index) => ({
    index,
    id: f.id,
    name: f.featureName,
    category: f.category,
  }));

  // 재실행 시 중복 누적 방지 — brand_feature_candidates 회차 재생성과 같은 패턴.
  await deletePlacementExpressionClassifications(diagnosisId);

  const allExpressions = [...countByKeyword.entries()];
  const rowsToSave: PlacementExpressionClassificationToSave[] = [];
  const reviewQueue: { expression: string; category: string; matchedFeatureName: string | null; reasonForReview: 'matched' | 'disagreement' }[] = [];
  let stoppedByLlmCallCap = false;

  for (let i = 0; i < allExpressions.length; i += CLASSIFICATION_BATCH_SIZE) {
    // 배치 하나 = 판정 1콜 + 검수 1콜 = 2콜. 다음 배치를 시작하기 전에 상한을
    // 미리 확인한다(mention-feature-roles.ts와 동일 이유 — 검수 없이 판정만
    // 저장되는 사고를 막기 위함).
    if (getUsageRunSummary().llmCalls >= MAX_LLM_CALLS_PER_RUN - 1) {
      stoppedByLlmCallCap = true;
      const capMessage =
        `placement-expression-classifier가 MAX_LLM_CALLS_PER_RUN(${MAX_LLM_CALLS_PER_RUN})에 걸려 중단됨 — ` +
        `처리 ${i}/${allExpressions.length}건에서 멈춤 (diagnosisId=${diagnosisId})`;
      console.warn(`⚠️ ${capMessage}`);
      void sendIncidentAlert({
        platform: 'cron:compute-placement-narrative:classify',
        errorType: 'llm_call_cap',
        message: capMessage,
        status: '남은 표현은 미분류 상태로 남음 — 다음 진단 실행 때는 재분류 대상 아님(이번 실행분만 부분 저장)',
      });
      break;
    }

    const batch = allExpressions.slice(i, i + CLASSIFICATION_BATCH_SIZE);
    const expressionsForClassification: ExpressionForClassification[] = batch.map(([text], index) => ({
      index,
      text,
    }));

    let classified;
    try {
      classified = await retryWithBackoff(
        () => classifyExpressionBatch(brandName, brandId, expressionsForClassification, leftCandidates, 'cron'),
        3,
        isRetryableLLMError
      );
    } catch (error) {
      // 배치 하나 실패해도 나머지 배치는 계속 — CLAUDE.md 절대원칙 4번.
      console.error(`추천 표현 분류 실패 (batch start=${i}, diagnosisId=${diagnosisId}):`, error);
      continue;
    }

    const leftById = new Map(leftFeatures.map((f) => [f.id, f]));
    for (const result of classified) {
      const [expression, occurrenceCount] = batch[result.index];
      const matchedFeatureId =
        result.matchedLeftIndex !== null ? leftCandidates[result.matchedLeftIndex]?.id ?? null : null;

      rowsToSave.push({
        diagnosisId,
        brandId,
        expression,
        occurrenceCount,
        appearedRuns,
        category: result.category,
        matchedFeatureId,
        judgedBy: ANTHROPIC_MODEL,
        reviewedBy: ANTHROPIC_MODEL_SONNET,
      });

      // 사람 검증 큐 대상(§4단계): (a) 구체적으로 왼쪽 특징과 매칭됐다고 판정된
      // 것(화면에 실제로 노출될 구체적 correspondence 주장이라 확인 필요),
      // (b) Haiku/Sonnet 두 독립 판정이 서로 다른 것("확신 낮음" 신호로 씀,
      // lib/placement-expression-classifier.ts 헤더 주석 참고). 카테고리만
      // 배정되고 매칭도 없고 두 모델이 합의한 건 상위 집계용 숫자일 뿐이라
      // 큐에 안 넣는다(전부 넣으면 새 브랜드마다 수십~백여 건이 쌓여 검토
      // 자체가 무너짐 — 2026-09-16 코난 판단, 범위가 안 맞으면 루아 지시로 넓힐 것).
      if (matchedFeatureId) {
        reviewQueue.push({
          expression,
          category: result.category ?? '미분류',
          matchedFeatureName: leftById.get(matchedFeatureId)?.featureName ?? null,
          reasonForReview: 'matched',
        });
      } else if (!result.agreedWithFirstPass) {
        reviewQueue.push({
          expression,
          category: result.category ?? '미분류',
          matchedFeatureName: null,
          reasonForReview: 'disagreement',
        });
      }
    }
  }

  const savedIds = await savePlacementExpressionClassifications(rowsToSave);
  const reviewQueueByExpression = new Map(reviewQueue.map((q) => [q.expression, q]));

  // review_items는 저장된 행의 id(source_id)가 있어야 연결되므로 저장 뒤에 큐잉한다.
  // rowsToSave와 savedIds는 같은 순서라는 보장(saveBrandFeatureCandidates와 동일 전제)을 쓴다.
  // 표현은 countByKeyword의 Map 키라 이 배치 안에서 유일 — reviewQueue도 표현 문자열로
  // 안전하게 조회할 수 있다.
  for (let idx = 0; idx < rowsToSave.length; idx++) {
    const row = rowsToSave[idx];
    const queued = reviewQueueByExpression.get(row.expression);
    if (!queued) continue;
    const sourceId = savedIds[idx];
    if (!sourceId) continue;

    const aiText =
      queued.reasonForReview === 'matched'
        ? `추천 표현 "${queued.expression}"이(가) 소개 특징 "${queued.matchedFeatureName}"와(과) 같은 특징으로 판정됨 (카테고리: ${queued.category})`
        : `추천 표현 "${queued.expression}" — 1차 판정과 검수 판정이 서로 달랐음 (검수 결과 채택: 카테고리 ${queued.category})`;

    await saveReviewItem({
      brandId,
      diagnosisId,
      itemType: 'placement_expression_match',
      sourceTable: 'placement_expression_classifications',
      sourceId,
      aiText,
      autoRegeneratable: false, // 다음 진단에서 재계산되는 관측값이라, 반려돼도 지금 당장 다시 생성할 대상이 아님
      evidence: { expression: row.expression, occurrenceCount: row.occurrenceCount, reasonForReview: queued.reasonForReview },
    });
  }

  if (stoppedByLlmCallCap) {
    console.warn(`추천 표현 분류 일부만 완료됨 (diagnosisId=${diagnosisId}) — 캡에 걸려 중단`);
  }
}
