// app/api/collect-and-save/route.ts

import { NextResponse } from 'next/server';
import { collectAndSaveAll } from '@/lib/collector';

/**
 * 전체 파이프라인 실행: 수집 → 파싱 → DB 저장.
 * 20번 API 호출 + DB 저장까지 하므로 시간이 걸림(1~2분 예상).
 */
export async function GET() {
  try {
    console.log('=== 전체 파이프라인 시작 ===');

    const result = await collectAndSaveAll();

    console.log('=== 전체 파이프라인 완료 ===');
    console.log(result);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('파이프라인 실패:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      { status: 500 }
    );
  }
}