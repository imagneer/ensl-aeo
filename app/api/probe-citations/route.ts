// app/api/probe-citations/route.ts

/**
 * Step 0 — 인용 구조 실측 프로브 (Day 8)
 * ══════════════════════════════════════
 *
 * 목적: "AI 회사들이 출처 정보를 어느 정도까지 주는가"를 문서가 아니라
 *       실제 응답으로 확인한다.
 *
 * 왜 어댑터를 안 쓰고 API를 직접 부르는가:
 *   기존 어댑터(lib/adapters/*.ts)는 응답에서 URL만 뽑고 나머지를 버린다.
 *   지금 확인하려는 건 "버려지는 부분에 뭐가 들어있냐"이므로,
 *   어댑터를 통과시키면 확인하려는 대상이 사라진다.
 *   그래서 이 파일만 예외적으로 원본 응답을 통째로 받는다.
 *
 * ⚠️ 이 파일은 진단용 일회성 도구다. 프로덕션 경로가 아니다.
 *    확인이 끝나면 지워도 되고, 참고용으로 남겨둬도 된다.
 *
 * 실행법:
 *   1) npm run dev
 *   2) 브라우저에서 http://localhost:3000/api/probe-citations
 *   3) 화면의 요약을 보고, 원본 JSON은 probe-output/ 폴더에서 확인
 */

import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';   // 파일 저장이 필요하므로 Node 런타임 강제
export const maxDuration = 300;    // 4개 엔진 호출 — 넉넉히

// 실측에 쓸 질문 하나. 실제 측정 쿼리와 같은 성격으로 골랐다.
const PROBE_QUERY = '강서구에서 임플란트 잘하는 치과 알려줘';

/** 판정 결과를 담는 공통 형식 */
interface ProbeReport {
  engine: string;
  ok: boolean;
  error?: string;

  /** ① "본 것" — 검색해서 받아온 후보 출처 개수 */
  retrievedCount: number | null;

  /** ② "쓴 것" — 답변에 실제 근거로 붙은 출처 개수 */
  citedCount: number | null;

  /** ③ 답변의 어느 구간이 어느 출처인지 알 수 있는가 (핵심 질문) */
  hasSpanMapping: boolean;

  /** ③이 어떤 형태로 오는지 (필드명) */
  spanMappingShape: string;

  /** 실제로 관측된 샘플 1개 — 눈으로 확인용 */
  sample: unknown;

  /** 원본 JSON을 저장한 파일 경로 */
  savedTo: string;
}

/** 원본 응답을 파일로 떨군다 (터미널·브라우저로는 다 안 보이므로) */
async function dump(engine: string, data: unknown): Promise<string> {
  const dir = path.join(process.cwd(), 'probe-output');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${engine}-${stamp}.json`);
  await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
  return path.relative(process.cwd(), file);
}

// ────────────────────────────────────────────────────────────
// 1. Perplexity — 답변 본문의 [1][2] 마커가 citations 배열 순서와 대응하는지
// ────────────────────────────────────────────────────────────
async function probePerplexity(): Promise<ProbeReport> {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: PROBE_QUERY }],
    }),
  });

  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const savedTo = await dump('perplexity', data);

  const content: string = data.choices?.[0]?.message?.content ?? '';
  const citations: string[] = data.citations ?? [];
  const searchResults: unknown[] = data.search_results ?? [];

  // 본문에 [1] 같은 숫자 마커가 실제로 있는가
  const markers = content.match(/\[\d+\]/g) ?? [];
  const uniqueMarkers = Array.from(new Set(markers));

  return {
    engine: 'perplexity',
    ok: true,
    // Perplexity는 "본 것"이 search_results, "쓴 것"이 본문 마커로 참조된 citations
    retrievedCount: searchResults.length || citations.length,
    citedCount: uniqueMarkers.length,
    hasSpanMapping: uniqueMarkers.length > 0,
    spanMappingShape: uniqueMarkers.length > 0
      ? `본문 인라인 마커 ${uniqueMarkers.join(',')} → citations 배열 인덱스`
      : '마커 없음 — 이 엔진은 2안(도메인 매칭)으로 내려야 함',
    sample: {
      마커_샘플: uniqueMarkers.slice(0, 5),
      본문_앞부분: content.slice(0, 300),
      citations_앞3개: citations.slice(0, 3),
      search_results_1개: searchResults[0] ?? null,
    },
    savedTo,
  };
}

// ────────────────────────────────────────────────────────────
// 2. OpenAI — annotations에 start_index/end_index가 실제로 오는지
// ────────────────────────────────────────────────────────────
async function probeOpenAI(): Promise<ProbeReport> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5-search-api',
      web_search_options: {},
      messages: [{ role: 'user', content: PROBE_QUERY }],
    }),
  });

  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const savedTo = await dump('openai', data);

  const message = data.choices?.[0]?.message ?? {};
  const annotations: any[] = message.annotations ?? [];

  // 핵심 확인: 인덱스가 숫자로 채워져 오는가
  const withIndex = annotations.filter(
    (a) => typeof a?.url_citation?.start_index === 'number'
  );

  return {
    engine: 'chatgpt',
    ok: true,
    // OpenAI는 "본 것"을 응답에 안 준다 (검색 후보 목록 비공개)
    retrievedCount: null,
    citedCount: annotations.length,
    hasSpanMapping: withIndex.length > 0,
    spanMappingShape: withIndex.length > 0
      ? 'annotations[].url_citation.start_index / end_index (글자 단위)'
      : 'annotations에 인덱스 없음 — 문서와 실제가 다름, 재검토 필요',
    sample: {
      annotation_1개: annotations[0] ?? null,
      인덱스_있는_개수: withIndex.length,
      전체_annotation_개수: annotations.length,
      본문_앞부분: (message.content ?? '').slice(0, 300),
    },
    savedTo,
  };
}

// ────────────────────────────────────────────────────────────
// 3. Anthropic — text 블록의 citations 배열이 실제로 오는지
//    (지금 어댑터는 이걸 안 읽고 web_search_tool_result만 읽는 중)
// ────────────────────────────────────────────────────────────
async function probeAnthropic(): Promise<ProbeReport> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: PROBE_QUERY }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  });

  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const savedTo = await dump('anthropic', data);

  const blocks: any[] = data.content ?? [];

  // "본 것" — 검색엔진이 돌려준 후보 목록
  let retrieved = 0;
  for (const b of blocks) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      retrieved += b.content.filter((i: any) => i?.url).length;
    }
  }

  // "쓴 것" — 각 text 블록에 붙은 citations
  const textBlocksWithCitations = blocks.filter(
    (b) => b.type === 'text' && Array.isArray(b.citations) && b.citations.length > 0
  );
  const citedTotal = textBlocksWithCitations.reduce(
    (sum, b) => sum + b.citations.length,
    0
  );

  return {
    engine: 'claude',
    ok: true,
    retrievedCount: retrieved,
    citedCount: citedTotal,
    hasSpanMapping: citedTotal > 0,
    spanMappingShape: citedTotal > 0
      ? 'content[].citations[] (type=web_search_result_location, cited_text로 구간 식별)'
      : 'text 블록에 citations 없음 — 재검토 필요',
    sample: {
      본것_vs_쓴것: `본 것 ${retrieved}개 / 쓴 것 ${citedTotal}개`,
      citation_1개: textBlocksWithCitations[0]?.citations?.[0] ?? null,
      블록_타입_순서: blocks.map((b) => b.type),
    },
    savedTo,
  };
}

// ────────────────────────────────────────────────────────────
// 4. Gemini — groundingSupports(구버전) 또는 annotations(신버전) 중 뭐가 오는지
//    ⚠️ 여기가 제일 불확실. 구글 문서와 현재 코드의 필드명이 안 맞음.
// ────────────────────────────────────────────────────────────
async function probeGemini(): Promise<ProbeReport> {
  const model = 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROBE_QUERY }] }],
      tools: [{ google_search: {} }],
    }),
  });

  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const savedTo = await dump('gemini', data);

  const candidate = data.candidates?.[0];
  const gm = candidate?.groundingMetadata ?? {};

  // "본 것" — 검색으로 가져온 청크들
  const chunks: any[] = gm.groundingChunks ?? [];

  // "쓴 것" 후보 A — 구버전 필드
  const supports: any[] = gm.groundingSupports ?? [];

  // "쓴 것" 후보 B — 신버전 필드 (문서가 이쪽을 설명하고 있음)
  const parts: any[] = candidate?.content?.parts ?? [];
  const annotations: any[] = parts.flatMap((p: any) => p?.annotations ?? []);

  const shape =
    supports.length > 0
      ? 'groundingMetadata.groundingSupports[].segment(startIndex/endIndex) + groundingChunkIndices'
      : annotations.length > 0
        ? 'content.parts[].annotations[] (start_index/end_index)'
        : '둘 다 없음 — 이 엔진은 2안(도메인 매칭)으로 내려야 함';

  return {
    engine: 'gemini',
    ok: true,
    retrievedCount: chunks.length,
    citedCount: supports.length || annotations.length,
    hasSpanMapping: supports.length > 0 || annotations.length > 0,
    spanMappingShape: shape,
    sample: {
      검색수행_여부: chunks.length > 0 ? '검색함' : '⚠️ 검색 건너뜀 (학습지식으로만 답변)',
      groundingMetadata_키목록: Object.keys(gm),
      support_1개: supports[0] ?? null,
      annotation_1개: annotations[0] ?? null,
    },
    savedTo,
  };
}

// ────────────────────────────────────────────────────────────
// 실행부
// ────────────────────────────────────────────────────────────
export async function GET() {
  const probes = [
    { name: 'perplexity', fn: probePerplexity },
    { name: 'chatgpt', fn: probeOpenAI },
    { name: 'claude', fn: probeAnthropic },
    { name: 'gemini', fn: probeGemini },
  ];

  // allSettled — 한 엔진이 실패해도 나머지 결과는 봐야 하므로
  const settled = await Promise.allSettled(probes.map((p) => p.fn()));

  const reports: ProbeReport[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      engine: probes[i].name,
      ok: false,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      retrievedCount: null,
      citedCount: null,
      hasSpanMapping: false,
      spanMappingShape: '호출 실패',
      sample: null,
      savedTo: '',
    };
  });

  // 한눈에 보는 판정표
  const 판정 = reports.map((r) => ({
    엔진: r.engine,
    호출: r.ok ? '성공' : `실패 (${r.error})`,
    본것: r.retrievedCount ?? '제공 안 함',
    쓴것: r.citedCount ?? '제공 안 함',
    구간정보: r.hasSpanMapping ? '✅ 있음' : '❌ 없음',
    형태: r.spanMappingShape,
  }));

  const 가능한_엔진 = reports.filter((r) => r.hasSpanMapping).map((r) => r.engine);

  return NextResponse.json(
    {
      질문: PROBE_QUERY,
      결론: `1안(제대로 연결) 가능한 엔진: ${가능한_엔진.length}/4 — ${가능한_엔진.join(', ') || '없음'}`,
      판정,
      원본JSON위치: 'probe-output/ 폴더',
      상세: reports,
    },
    { status: 200 }
  );
}
