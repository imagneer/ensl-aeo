// app/api/collect-and-save/route.ts

import { NextResponse } from 'next/server';
import { collectAndSaveAll } from '@/lib/collector';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const maxDuration = 800; // Fluid Compute 켜짐 확인됨(2026-08-19). 향후 브랜드 늘어도 재계산 불필요하도록 상한까지 미리 설정

/**
 * 전체 파이프라인 실행: 수집 → 파싱 → DB 저장.
 * 20~40번 API 호출 + DB 저장까지 하므로 시간이 걸림(A안: 시간대당 반복 2회 포함).
 *
 * Day 14 — Cron 전용 라우트로 전환하며 인증을 추가했다. 하루 수십 번 유료 API를
 * 호출하는 라우트라, 인증 없이 열어두면 URL만 알면 누구나 크레딧을 소진시킬 수 있다.
 *
 * Day 20 — 인지/자리 이원화. vercel.json의 09시 크론만 `?scope=all`을 붙여서
 * 인지+자리를 다 돌리고, 13시·18시는 파라미터 없이 호출해서 인지만 돈다.
 * ⚠️ scope가 없거나 'all'이 아닌 값이면 무조건 'recognition'(인지만)으로
 * 처리한다 — 크론 설정이 잘못돼도 자리 질문이 의도치 않게 더 자주 도는
 * (비용 초과) 쪽보다, 덜 도는(데이터 부족) 쪽이 안전하기 때문이다.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope') === 'all' ? 'all' : 'recognition';

    // scope 파라미터가 잘못 붙었을 때 "조용히 잘못 도는" 상황을 잡기 위한
    // 교차 확인. vercel.json 크론 설정 실수(2026-09-01, 루아 지적으로 추가)
    // — route 혼자서는 "지금이 09시라 scope=all이어야 하는데 빠졌다"를 모른다.
    // KST 09시대인지를 별도로 계산해서 어긋나면 error 레벨로 남긴다.
    const kstHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        hour: 'numeric',
        hour12: false,
      }).format(new Date())
    );

    if (kstHour === 9 && scope !== 'all') {
      console.error(
        `⚠️ 09시(KST) 배치인데 scope=all이 아님(scope=${scope}) — 자리 질문 9개가 이번 배치에서 통째로 빠집니다. vercel.json의 09시 크론 경로에 ?scope=all이 붙어있는지 확인하세요.`
      );
    } else if (kstHour !== 9 && scope === 'all') {
      console.error(
        `⚠️ 09시(KST)가 아닌 시간대(KST ${kstHour}시)에 scope=all로 호출됨 — 예정에 없던 자리 질문 반복이 추가로 돌아 비용이 늘어납니다. 의도한 호출이 맞는지 확인하세요.`
      );
    }

    console.log(`=== 전체 파이프라인 시작 (scope: ${scope}, KST ${kstHour}시) ===`);

    const result = await collectAndSaveAll(scope);

    console.log('=== 전체 파이프라인 완료 ===');
    console.log(result);

    return NextResponse.json({
      success: true,
      scope,
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