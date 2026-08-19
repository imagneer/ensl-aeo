// app/api/collect-and-save/route.ts

import { NextResponse } from 'next/server';
import { collectAndSaveAll } from '@/lib/collector';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const maxDuration = 300; // 실측 3분 + 여유. 6개 엔진 x 2회 반복이라 제일 오래 걸림

/**
 * 전체 파이프라인 실행: 수집 → 파싱 → DB 저장.
 * 20~40번 API 호출 + DB 저장까지 하므로 시간이 걸림(A안: 시간대당 반복 2회 포함).
 *
 * Day 14 — Cron 전용 라우트로 전환하며 인증을 추가했다. 하루 수십 번 유료 API를
 * 호출하는 라우트라, 인증 없이 열어두면 URL만 알면 누구나 크레딧을 소진시킬 수 있다.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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