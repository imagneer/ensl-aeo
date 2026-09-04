// app/api/aggregate-daily/route.ts

import { NextResponse } from 'next/server';
import { aggregateAllQueriesForDay, yesterdayKST } from '@/lib/aggregator';
import { checkAndCompleteDiagnoses } from '@/lib/brand-one-liner';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { getUsageRunSummary } from '@/lib/llm-usage';

export const maxDuration = 800; // 브랜드 한 줄 합성(LLM 여러 번) 추가로 300 → 800(Fluid Compute 상한)

/**
 * 특정 KST 날짜의 daily 집계를 수동으로 돌려보는 테스트 라우트.
 *
 * 사용법: /api/aggregate-daily?date=2026-08-17
 * date를 안 주면 어제(KST 기준) 날짜로 자동 계산한다(yesterdayKST()).
 *
 * ⚠️ 아직 Cron이 없어서(Day 12 예정) 이 라우트가 지금 daily 집계를 실행하는
 *    유일한 방법이다. 진짜 자동화가 붙기 전까지는 수동 호출로 검증만 한다.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const dateKST = searchParams.get('date') ?? yesterdayKST();

    console.log(`=== daily 집계 시작 (${dateKST}, KST 기준) ===`);

    const summary = await aggregateAllQueriesForDay(dateKST);

    console.log('=== daily 집계 완료 ===', summary);

    // 브랜드 한 줄 — 그날 집계가 끝난 뒤, 오늘 종료할 진단이 있는지 확인
    console.log('=== 진단 종료 확인 시작 ===');
    const diagnosisSummary = await checkAndCompleteDiagnoses(dateKST);
    console.log('=== 진단 종료 확인 완료 ===', diagnosisSummary);

    // 2026-09-04, 예산 사고 후속 — aggregateAllQueriesForDay가 시작한
    // usage 추적을 checkAndCompleteDiagnoses(브랜드 한 줄, Sonnet 호출)까지
    // 포함해서 다시 읽는다. summary.llm*은 daily 집계분만 반영돼 있어서,
    // 이 라우트 전체(집계+브랜드 한 줄) 합계는 이걸로 따로 봐야 한다 —
    // 특히 진단이 처음 종료되는 날은 Sonnet 비용이 여기서만 잡힌다
    // (에일 확인 사실 6번 — "진단 종료가 처음 발생하는 날 Sonnet 비용이
    // 새로 튄다").
    const routeTotalUsage = getUsageRunSummary();
    console.log('=== daily 집계 라우트 전체 LLM 사용량(집계+브랜드 한 줄 합계) ===', routeTotalUsage);

    return NextResponse.json({
      success: true,
      ...summary,
      diagnosisCompletion: diagnosisSummary,
      llmUsageRouteTotal: routeTotalUsage,
    });
  } catch (error) {
    console.error('daily 집계 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}
