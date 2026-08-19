// app/api/check-alerts/route.ts

import { NextResponse } from 'next/server';
import { runAlertCheckForDay } from '@/lib/alerts';
import { yesterdayKST } from '@/lib/aggregator';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const maxDuration = 60; // 아직 실측 전이지만 aggregate-daily와 비슷한 성격(DB 읽기+계산)이라 같은 값

/**
 * 특정 KST 날짜에 대해 알림 판정(생성/갱신/종료/보류)을 수동으로 돌려보는
 * 테스트 라우트.
 *
 * 사용법: /api/check-alerts?date=2026-08-19
 *
 * ⚠️ 이 라우트를 돌리기 전에 그 날짜의 daily 집계(aggregate-daily)가
 *    먼저 끝나 있어야 한다 — 알림 판정은 aggregated_metrics를 읽어서 하므로,
 *    순서가 바뀌면 "오늘 데이터 없음"으로 전부 보류 처리된다.
 *
 * ⚠️ 아직 Cron이 없어서(Day 14 예정) 이 라우트가 지금 알림 판정을 실행하는
 *    유일한 방법이다.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const dateKST = searchParams.get('date') ?? yesterdayKST();

    console.log(`=== 알림 판정 시작 (${dateKST}, KST 기준) ===`);

    const summary = await runAlertCheckForDay(dateKST);

    console.log('=== 알림 판정 완료 ===', summary);

    return NextResponse.json({
      success: true,
      ...summary,
    });
  } catch (error) {
    console.error('알림 판정 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}