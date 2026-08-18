// app/api/test-keyword-extraction/route.ts
//
// Day 12 실측 검증용. ⚠️ 이 라우트는 코드 작성 세션에서 API 키가 없어 한 번도
// 실행해보지 못했다 — "코드가 돌아간다"와 "결과가 정확하다"는 다른 사실이다.
// 반드시 루아가 실제로 GET 요청을 날려서, 아래 세 가지를 눈으로 확인해야 한다:
//   1. 문단이 브랜드와 무관한 내용을 안 담고 정확히 잘렸는가
//   2. LLM이 원문에 없는 표현을 지어내지 않았는가 (환각 여부)
//   3. 이름만 나열되고 설명이 없는 경우 정말 빈 배열로 돌아오는가

import { NextResponse } from 'next/server';
import { anthropicAdapter } from '@/lib/adapters/anthropic';
import { parseBrandMentions } from '@/lib/parser';
import { fetchKnownBrands } from '@/lib/supabase';
import {
  buildBrandParagraphs,
  extractExpressionsFromParagraphs,
  countTopKeywords,
} from '@/lib/keyword-extractor';

export async function GET() {
  try {
    const testQuery = '강서구에서 임플란트 잘하는 치과 추천해줘';

    console.log('=== Day 12 키워드 추출 실측 테스트 시작 ===');

    // 1) 실제 AI 응답 1건 받기 (수집용 어댑터 재사용 — 비용은 기존 테스트 라우트와 동일)
    const result = await anthropicAdapter.ask(testQuery);
    const knownBrands = await fetchKnownBrands();
    const parsed = parseBrandMentions(result.rawText, knownBrands);

    if (!parsed.targetMention) {
      // 이건 실패가 아니라 그냥 이번 관측에서 노출이 안 된 것 — AEO는 확률
      // 싸움이라는 원칙 그대로. 재시도해서 나올 때까지 반복 호출하지 않는다.
      return NextResponse.json({
        success: true,
        note: '이번 관측에서 타겟 브랜드가 노출되지 않았습니다 (정상 — 여러 번 실행해서 노출된 케이스로 다시 시도해보세요).',
        rawTextPreview: result.rawText.slice(0, 500),
      });
    }

    // 2) 문단 추출 (규칙 B)
     const paragraphs = buildBrandParagraphs([
     {
      snapshotId: 'live-test-1',
      rawText: result.rawText,
      targetBrandName: parsed.targetMention.brandName,
      allMentions: parsed.mentions.map((m) => ({
       brandName: m.brandName,
       position: m.position,
        })),
      },
    ]);

    console.log('추출된 문단:', paragraphs);

    // 3) LLM 호출 (규칙 C, D)
    const brandName = parsed.targetMention.brandName;
    const keywordResults = await extractExpressionsFromParagraphs(brandName, paragraphs);

    console.log('LLM이 뽑은 표현:', keywordResults);

    // 4) 빈도 집계 (규칙 D, E — LLM 재호출 없이 코드로 계산)
    const topKeywords = countTopKeywords(keywordResults, 5);

    return NextResponse.json({
      success: true,
      brandName,
      matchedParagraph: paragraphs[0]?.paragraphText ?? null,
      llmExtractedExpressions: keywordResults[0]?.expressions ?? [],
      topKeywords, // 문단이 1개뿐이라 이번엔 사실상 llmExtractedExpressions와 순서만 다름 — 여러 관측 합쳐야 진짜 의미가 생김(규칙 A 참고, 이건 단일 스냅샷 프로토타입 검증용)
      rawTextPreview: result.rawText.slice(0, 500),
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