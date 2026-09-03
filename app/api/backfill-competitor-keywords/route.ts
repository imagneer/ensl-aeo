// app/api/backfill-competitor-keywords/route.ts

import { NextResponse } from 'next/server';
import { backfillCompetitorKeywords } from '@/lib/aggregator';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const maxDuration = 800; // Vercel Pro(Fluid Compute) 상한 — CLAUDE.md 인프라 보충 참고

/**
 * 경쟁사 특징 추출 2단계 백필 — 일회성 수동 라우트 (2026-09-03).
 *
 * 기존 daily 집계 504건 중 competitor_data는 있지만 아직 이 확장을 거치지
 * 않은(topKeywords가 undefined인) 경쟁사 항목에 한해서만 키워드를 채운다.
 * 한 번의 요청으로 전부(최대 738건 추정) 못 끝낼 수 있어 maxCalls로 나눠
 * 처리한다 — remaining이 0이 될 때까지 같은 URL을 반복 호출하면 된다.
 * (백필 로직 자체가 이어서 실행 가능하도록 설계됨 — lib/aggregator.ts의
 * backfillCompetitorKeywords 주석 참고)
 *
 * 사용법: /api/backfill-competitor-keywords?maxCalls=150
 * maxCalls를 안 주면 기본값(150) 사용.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const maxCallsParam = searchParams.get('maxCalls');
    const maxCalls = maxCallsParam ? Number(maxCallsParam) : 150;

    console.log(`=== 경쟁사 키워드 백필 시작 (maxCalls=${maxCalls}) ===`);
    const result = await backfillCompetitorKeywords(maxCalls);
    console.log('=== 경쟁사 키워드 백필 완료 ===', result);

    return NextResponse.json({
      success: true,
      ...result,
      note:
        result.remaining > 0
          ? `아직 ${result.remaining}건 남음 — 같은 URL로 다시 호출하면 이어서 처리됩니다.`
          : '전체 완료 — 더 남은 항목 없음.',
    });
  } catch (error) {
    console.error('경쟁사 키워드 백필 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}
