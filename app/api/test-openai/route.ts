// app/api/test-openai/route.ts

import { NextResponse } from 'next/server';
import { openaiAdapter } from '@/lib/adapters/openai';
import { parseBrandMentions, findUnregisteredBrands, buildOverallRanking } from '@/lib/parser';
import { fetchKnownBrands } from '@/lib/supabase';

export async function GET() {
  try {
    const testQuery = '강서구에서 임플란트 잘하는 치과 추천해줘';

    console.log('=== OpenAI 어댑터 테스트 시작 ===');
    console.log('쿼리:', testQuery);

    const result = await openaiAdapter.ask(testQuery);

    const knownBrands = await fetchKnownBrands();
    const parsed = parseBrandMentions(result.rawText, knownBrands);
    const unregistered = findUnregisteredBrands(result.rawText, parsed.mentions, knownBrands);
    const overallRanking = buildOverallRanking(parsed, unregistered);
    const targetOverall = overallRanking.find((m) => m.isTarget);

    console.log('=== 응답 수신 완료 ===');
    console.log('엔진:', result.engine);
    console.log('모델:', result.model);
    console.log('인용 출처 수:', result.citations.length);
    console.log('인용 출처 목록:', result.citations);
    console.log('=== 파싱 결과 ===');
    console.log('타겟(원탑) 노출 여부:', parsed.isTargetExposed);
    console.log('미등록 브랜드:', unregistered);
    console.log('타겟 절대 순위:', targetOverall?.overallRank);
    console.log('답변 앞 300자:', result.rawText.slice(0, 300));

    return NextResponse.json({
      success: true,
      engine: result.engine,
      model: result.model,
      query: result.query,
      timestamp: result.timestamp,
      citationCount: result.citations.length,
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