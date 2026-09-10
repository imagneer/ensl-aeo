// app/api/compute-placement-narrative/route.ts

import { NextResponse } from 'next/server';
import { kstDayBoundsUtc } from '@/lib/aggregator';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { fetchCompletedDiagnosesMissingPlacementNarrative } from '@/lib/supabase';
import { computeAndSavePlacementNarrativeTop10 } from '@/lib/placement-narrative';
import { getUsageRunSummary } from '@/lib/llm-usage';

/**
 * "추천 표현 TOP10"(자리질문 mentions 원문 전체 재분석) 전용 크론
 * (2026-09-10, 작업지시서_간극화면_교체_2026-09-09_V1.0.md §완료기준).
 *
 * ⚠️ /api/complete-diagnoses에 그냥 얹지 않고 완전히 분리했다 — 그 라우트는
 * 브랜드 한 줄 합성만으로 이미 실측 13분 가까이 써서(마찬가지로 800초
 * 한도) 여기다 추가 LLM 호출(220건 기준 약 1분)을 더 얹으면 브랜드 한 줄
 * 합성 자체가 시간초과로 실패할 위험이 있다(2026-09-10 루아 확인 — 안전한
 * 방법 채택). completed 상태인데 아직 이 표가 없는 진단만 골라서 처리하는
 * 방식이라, 어느 실행 회차에서 놓쳐도 다음 실행 때 자동으로 다시 걸린다
 * (재시도 큐 없이도 안전 — fetchCompletedDiagnosesMissingPlacementNarrative
 * 참고).
 */
export const maxDuration = 600;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const targets = await fetchCompletedDiagnosesMissingPlacementNarrative();
    console.log(`=== 추천 표현 TOP10 대상 진단 ${targets.length}건 ===`);

    const results = await Promise.allSettled(
      targets.map(async (t) => {
        const periodStart = kstDayBoundsUtc(t.startedAt).periodStart;
        const periodEnd = kstDayBoundsUtc(t.endedAt).periodEnd;
        const result = await computeAndSavePlacementNarrativeTop10({
          brandId: t.brandId,
          brandName: t.brandName,
          diagnosisId: t.diagnosisId,
          periodStart,
          periodEnd,
        });
        return { diagnosisId: t.diagnosisId, brandName: t.brandName, ...result };
      })
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { diagnosisId: targets[i].diagnosisId, error: String(r.reason) } : null))
      .filter((x): x is { diagnosisId: string; error: string } => x !== null);

    if (failed.length > 0) {
      console.error('=== 추천 표현 TOP10 계산 실패 건 ===', failed);
    }

    const routeTotalUsage = getUsageRunSummary();
    console.log('=== 추천 표현 TOP10 라우트 LLM 사용량 ===', routeTotalUsage);

    return NextResponse.json({
      success: true,
      targetCount: targets.length,
      succeeded,
      failed,
      llmUsageRouteTotal: routeTotalUsage,
    });
  } catch (error) {
    console.error('추천 표현 TOP10 계산 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}
