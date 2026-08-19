// app/api/test-share-of-voice/route.ts

import { NextResponse } from 'next/server';
import { fetchAggregatedMetrics } from '@/lib/supabase';
import { computeShareOfVoice, competitorParticipation } from '@/lib/analysis';
import { kstDayBoundsUtc } from '@/lib/aggregator';

/**
 * 특정 KST 날짜의 daily 집계 행들을 읽어와서 share of voice를 계산해보는
 * 수동 검증용 라우트 (Day 11) — Day 9의 aggregate-daily와 같은 패턴.
 *
 * 사용법: /api/test-share-of-voice?date=2026-08-17
 *
 * ⚠️ 이 라우트는 계산만 한다. 집계 자체를 새로 돌리지 않는다 —
 *    먼저 /api/aggregate-daily?date=... 로 그 날짜 집계를 만들어놔야
 *    결과가 나온다(안 만들어놨으면 결과 0건).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateKST = searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
    const { periodStart } = kstDayBoundsUtc(dateKST);

    const metrics = await fetchAggregatedMetrics({ periodStart, aggregationLevel: 'daily' });

    const results = metrics.map((m) => {
      const participation = competitorParticipation(m);

      return {
        queryId: m.queryId,
        brandId: m.brandId,
        engine: m.engine,
        mentionCount: m.mentionCount,
        shareOfVoice: computeShareOfVoice(m),
        // 규칙 F: SOV 100%가 "진짜 우세"인지 "경쟁사가 안 나온 라운드"인지
        // 이 두 값을 같이 봐야 구분된다. registered > 0인데 appeared === 0이면
        // 후자다.
        competitorsRegistered: participation.registered,
        competitorsAppeared: participation.appeared,
      };
    });

    return NextResponse.json({
      success: true,
      dateKST,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error('share of voice 계산 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}
