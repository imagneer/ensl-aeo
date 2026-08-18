// app/api/test-google/route.ts

import { NextResponse } from 'next/server';
import { googleAiOverviewAdapter } from '@/lib/adapters/google-ai-overview';
import { parseBrandMentions, findUnregisteredBrands, buildOverallRanking } from '@/lib/parser';
import { fetchKnownBrands } from '@/lib/supabase';

/**
 * 테스트용 API Route
 * 브라우저에서 http://localhost:3000/api/test-google 접속하면 실행됨
 *
 * ⚠️ 이 호출은 SerpApi 크레딧을 1~2회 쓴다(지연 로딩 여부에 따라).
 *    무료 플랜(월 100회) 잔여량 확인하고 실행할 것.
 */
export async function GET() {
  try {
    const testQuery = '강서구에서 임플란트 잘하는 치과 추천해줘';

    console.log('=== 구글 AI Overview 어댑터 테스트 시작 ===');
    console.log('쿼리:', testQuery);

    const result = await googleAiOverviewAdapter.ask(testQuery);

    console.log('=== 응답 수신 완료 ===');
    console.log('AI Overview 노출 여부(overviewShown):', result.overviewShown);
    console.log('본 것(retrievedSources) 개수:', result.retrievedSources?.length);
    console.log('사용한 것(citedSpans) 개수:', result.citedSpans.length);
    console.log('rawText 앞 500자:', result.rawText.slice(0, 500));

    const knownBrands = await fetchKnownBrands();
    const parsed = parseBrandMentions(result.rawText, knownBrands);
    const unregistered = findUnregisteredBrands(result.rawText, parsed.mentions, knownBrands);
    const overallRanking = buildOverallRanking(parsed, unregistered);
    const targetOverall = overallRanking.find((m) => m.isTarget);

    console.log('타겟(원탑) 노출 여부:', parsed.isTargetExposed);
    console.log('타겟 절대 순위:', targetOverall?.overallRank);

    return NextResponse.json({
      success: true,
      engine: result.engine,
      model: result.model,
      overviewShown: result.overviewShown,
      retrievedSourcesCount: result.retrievedSources?.length ?? null,
      citedSpansCount: result.citedSpans.length,
      citations: result.citations,
      rawTextPreview: result.rawText.slice(0, 500),
      parsed: parsed,
      unregistered: unregistered,
      overallRanking: overallRanking,
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