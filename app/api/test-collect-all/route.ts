// app/api/test-collect-all/route.ts

import { NextResponse } from 'next/server';
import { collectAll } from '@/lib/collector';

/**
 * 4개 엔진 전부를 한 번에 호출하는 테스트 라우트.
 * 브라우저에서 http://localhost:3000/api/test-collect-all 접속하면 실행됨.
 */
export async function GET() {
  try {
    const testQuery = '강서구에서 임플란트 잘하는 치과 추천해줘';

    console.log('=== collectAll 테스트 시작 ===');
    console.log('쿼리:', testQuery);
    console.log('4개 엔진 동시 호출 중...');

    const startTime = Date.now();
    const results = await collectAll(testQuery);
    const elapsedMs = Date.now() - startTime;

    console.log('=== collectAll 완료 ===');
    console.log('소요 시간:', elapsedMs, 'ms');

    for (const r of results) {
      if (r.success) {
        console.log(`✅ ${r.engine}: 성공 (${r.response?.rawText.length}자)`);
      } else {
        console.log(`❌ ${r.engine}: 실패 - ${r.error}`);
      }
    }

    return NextResponse.json({
      success: true,
      elapsedMs,
      results: results.map((r) => ({
        engine: r.engine,
        success: r.success,
        error: r.error,
        rawTextPreview: r.response?.rawText.slice(0, 200),
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