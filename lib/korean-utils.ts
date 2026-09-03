// lib/korean-utils.ts

/**
 * 한글 조사 처리 — 여러 화면(브랜드 현 위치·간극·변화 추이·브랜드 한 줄)이
 * 브랜드명·키워드처럼 동적인 문자열을 문장에 끼워 넣을 때 공통으로 쓴다
 * (2026-09-03, 브랜드 현 위치 화면 실측 검증 중 발견한 문법 버그를 고치며
 * lib/brand-position.ts에서 분리함 — "더와이즈치과병원**는**", "'...시스템'**라는**"처럼
 * 받침 있는 단어 뒤에서 조사가 깨지던 문제).
 *
 * ⚠️ 완성형 한글(가~힣, U+AC00~U+D7A3)만 종성 유무를 계산할 수 있다.
 * 마지막 글자가 완성형 한글이 아니면(영어·기호로 끝나는 경우) 판정 불가라
 * true(받침 있음 취급)로 방어적으로 처리한다 — "은"/"이라는"이 어색하게
 * 붙는 쪽이 완전히 틀린 조사보다 덜 거슬린다는 판단.
 */
export function hasFinalConsonant(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  const code = trimmed.charCodeAt(trimmed.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return true;
  return (code - 0xac00) % 28 !== 0;
}

/** 은/는 — 주제격 조사. */
export function topicParticle(text: string): '은' | '는' {
  return hasFinalConsonant(text) ? '은' : '는';
}

/** 이라는/라는 — 인용구 뒤에 붙는 조사(예: "'고난도 임플란트'라는 표현"). */
export function quoteParticle(text: string): '이라는' | '라는' {
  return hasFinalConsonant(text) ? '이라는' : '라는';
}
