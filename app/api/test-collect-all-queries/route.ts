// app/api/test-collect-all-queries/route.ts

import { NextResponse } from 'next/server';
import { collectAllQueries } from '@/lib/collector';

/**
 * DB의 쿼리 5개 × 엔진 4개 = 20번 전체 수집 테스트.
 * 아직 DB 저장은 안 함 — 결과만 눈으로 확인하는 단계.
 */
export async function GET() {
  try {
    console.log('=== collectAllQueries 테스트 시작 (20회 호출 예상) ===');

    const startTime = Date.now();
    const results = await collectAllQueries();
    const elapsedMs = Date.now() - startTime;

    console.log('=== collectAllQueries 완료 ===');
    console.log('총 결과 개수:', results.length);
    console.log('소요 시간:', elapsedMs, 'ms');

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    console.log(`성공: ${successCount}, 실패: ${failCount}`);

    return NextResponse.json({
      success: true,
      elapsedMs,
      totalResults: results.length,
      successCount,
      failCount,
      results: results.map((r) => ({
        queryText: r.queryText,
        engine: r.engine,
        success: r.success,
        error: r.error,
        citationCount: r.response?.citations.length,
      })),
    });
  } catch (error) {
    console.error('테스트 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}