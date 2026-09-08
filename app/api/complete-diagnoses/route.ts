// app/api/complete-diagnoses/route.ts

import { NextResponse } from 'next/server';
import { yesterdayKST, kstDayBoundsUtc } from '@/lib/aggregator';
import { checkAndCompleteDiagnoses } from '@/lib/brand-one-liner';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { hasAggregatedMetricsForDay } from '@/lib/supabase';
import { getUsageRunSummary } from '@/lib/llm-usage';

/**
 * 진단 종료 확인 — 원래 /api/aggregate-daily 안에서 그날 집계 직후 같이
 * 돌았는데(2026-09-01), 2026-09-08 실측으로 브랜드 한 줄 합성(그룹핑·
 * 문장작성·검수·대립탐지, LLM 순차 호출 다수 — 실측 90회·13분)이 daily
 * 집계와 시간 예산(maxDuration=800초)을 나눠 쓰다 못 끝내고 타임아웃되는
 * 걸 확인해서 별도 크론으로 분리했다(day4-decision-schedule.md 추가 기록).
 *
 * ⚠️ synthesizeBrandOneLiner는 그 진단의 마지막 날짜까지 brand_expressions가
 * 다 쌓여 있어야 정확하다 — brand_expressions는 daily 집계(aggregateOne)가
 * 채운다. 그래서 aggregate-daily와 실행 시각을 벌려놨어도(vercel.json),
 * 혹시 그날 집계가 아직 안 끝난 상태에서 이 라우트가 먼저 돌면 마지막
 * 날짜 데이터가 빠진 채로 조용히 합성될 위험이 있다 — 그런 "틀린 줄
 * 모르고 도는" 상황을 막으려고 hasAggregatedMetricsForDay로 먼저 확인하고,
 * 안 끝났으면 실패가 아니라 스킵으로 처리한다(다음 실행 때 diagnoses.status가
 * 여전히 'collecting'이라 자동으로 다시 시도됨).
 */
export const maxDuration = 800;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const dateKST = searchParams.get('date') ?? yesterdayKST();

    const { periodStart } = kstDayBoundsUtc(dateKST);
    const aggregationDone = await hasAggregatedMetricsForDay(periodStart);
    if (!aggregationDone) {
      console.log(`=== 진단 종료 확인 스킵 (${dateKST} daily 집계가 아직 안 끝남) ===`);
      return NextResponse.json({ success: true, skipped: true, reason: `${dateKST} 집계 미완료` });
    }

    console.log(`=== 진단 종료 확인 시작 (${dateKST}) ===`);
    const diagnosisSummary = await checkAndCompleteDiagnoses(dateKST);
    console.log('=== 진단 종료 확인 완료 ===', diagnosisSummary);

    const routeTotalUsage = getUsageRunSummary();
    console.log('=== 진단 종료 확인 라우트 LLM 사용량 ===', routeTotalUsage);

    return NextResponse.json({
      success: true,
      diagnosisCompletion: diagnosisSummary,
      llmUsageRouteTotal: routeTotalUsage,
    });
  } catch (error) {
    console.error('진단 종료 확인 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}
