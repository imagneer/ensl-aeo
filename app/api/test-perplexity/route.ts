// app/api/test-perplexity/route.ts

import { NextResponse } from 'next/server';
import { perplexityAdapter } from '@/lib/adapters/perplexity';
import { parseBrandMentions, findUnregisteredBrands, buildOverallRanking } from '@/lib/parser';
import { fetchKnownBrands } from '@/lib/supabase';

/**
 * 테스트용 API Route
 * 브라우저에서 http://localhost:3000/api/test-perplexity 접속하면 실행됨
 */
export async function GET() {
  try {
    // 시드 데이터에 있는 쿼리 중 하나로 테스트
    const testQuery = '강서구에서 임플란트 잘하는 치과 추천해줘';

    console.log('=== Perplexity 어댑터 테스트 시작 ===');
    console.log('쿼리:', testQuery);

    const result = await perplexityAdapter.ask(testQuery);

    // DB에서 브랜드 목록 가져오기 (하드코딩 대신)
    const knownBrands = await fetchKnownBrands();
    console.log('=== DB에서 가져온 브랜드 목록 ===');
    console.log('브랜드 개수:', knownBrands.length);

    // result 받은 직후에 추가
    const parsed = parseBrandMentions(result.rawText, knownBrands);
    console.log('=== 파싱 결과 ===');
    console.log('전체 멘션:', parsed.mentions);
    console.log('타겟(원탑) 노출 여부:', parsed.isTargetExposed);
    console.log('타겟 순위(등록 브랜드 중):', parsed.targetMention?.rankAmongKnown);

    
    // 미등록 브랜드 감지 + 절대 순위 계산
    const unregistered = findUnregisteredBrands(result.rawText, parsed.mentions, knownBrands);
    const overallRanking = buildOverallRanking(parsed, unregistered);
    const targetOverall = overallRanking.find((m) => m.isTarget);

    console.log('=== 미등록 브랜드 감지 결과 ===');
    console.log('미등록 브랜드 목록:', unregistered);
    console.log('=== 절대 순위(미등록 포함) ===');
    console.log('전체 순위:', overallRanking);
    console.log('타겟(원탑) 절대 순위:', targetOverall?.overallRank);

    console.log('=== 응답 수신 완료 ===');
    console.log('엔진:', result.engine);
    console.log('모델:', result.model);
    console.log('인용 출처 수:', result.citations.length);
    console.log('답변 앞 200자:', result.rawText.slice(0, 200));

    // 브라우저에 JSON으로 결과를 보여줌
    return NextResponse.json({
      success: true,
      engine: result.engine,
      model: result.model,
      query: result.query,
      timestamp: result.timestamp,
      citationCount: result.citations.length,
      citations: result.citations,
      // 답변 전문은 길 수 있으니 앞 500자만
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



