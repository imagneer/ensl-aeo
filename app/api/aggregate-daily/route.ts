// app/api/aggregate-daily/route.ts

import { NextResponse } from 'next/server';
import { aggregateAllQueriesForDay, yesterdayKST } from '@/lib/aggregator';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { getUsageRunSummary } from '@/lib/llm-usage';

// 2026-09-08 — 진단 종료 확인(브랜드 한 줄 합성, LLM 순차 호출 다수)은
// /api/complete-diagnoses로 분리했다(day4-decision-schedule.md 추가 기록
// 참고). 이 라우트에 같이 묶여 있을 때 실측 13분(90회 순차 API 호출)이
// 걸려 800초 상한을 넘겨 타임아웃 — 진단이 자동으로 안 끝나던 원인이었다.
export const maxDuration = 800;

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

    const routeTotalUsage = getUsageRunSummary();
    console.log('=== daily 집계 라우트 LLM 사용량 ===', routeTotalUsage);

    return NextResponse.json({
      success: true,
      ...summary,
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
