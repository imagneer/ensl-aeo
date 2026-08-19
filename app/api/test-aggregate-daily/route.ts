// app/api/test-aggregate-daily/route.ts

import { NextResponse } from 'next/server';
import { aggregateAllQueriesForDay, yesterdayKST } from '@/lib/aggregator';

/**
 * 특정 KST 날짜의 daily 집계를 수동으로 돌려보는 테스트 라우트.
 *
 * 사용법: /api/test-aggregate-daily?date=2026-08-17
 * date를 안 주면 어제(KST 기준) 날짜로 자동 계산한다(yesterdayKST()).
 *
 * ⚠️ 아직 Cron이 없어서(Day 12 예정) 이 라우트가 지금 daily 집계를 실행하는
 *    유일한 방법이다. 진짜 자동화가 붙기 전까지는 수동 호출로 검증만 한다.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateKST = searchParams.get('date') ?? yesterdayKST();

    console.log(`=== daily 집계 시작 (${dateKST}, KST 기준) ===`);

    const summary = await aggregateAllQueriesForDay(dateKST);

    console.log('=== daily 집계 완료 ===', summary);

    return NextResponse.json({
      success: true,
      ...summary,
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
