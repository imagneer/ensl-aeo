// lib/types.ts

import type { EngineName } from './engine-config';

/**
 * 어댑터가 API를 호출한 뒤 돌려줘야 하는 공통 형식.
 * 모든 엔진 어댑터는 이 형식을 반환해야 한다.
 */
export interface AdapterResponse {
  /** 어떤 엔진에서 왔는지 */
  engine: EngineName;

  /** 보낸 질문 원문 */
  query: string;

  /** AI가 준 전체 답변 텍스트 (원시 데이터, 나중에 파싱용) */
  rawText: string;

  /** AI가 제공한 인용 출처 URL 목록 (없으면 빈 배열) */
  citations: string[];

  /** API 호출 시각 (ISO 문자열) */
  timestamp: string;

  /** 사용한 모델명 (예: 'gpt-4o', 'claude-sonnet-4-5') */
  model: string;

  /**
   * 실제로 웹검색을 수행했는지 여부.
   * ⚠️ 대부분의 엔진은 항상 true(검색이 필수 구조)지만,
   *    Gemini는 모델이 스스로 판단해서 검색을 건너뛸 수 있음(2026-08-07 실측 확인).
   *    citations가 0개면 검색을 안 한 것으로 간주.
   *    이 값이 false면, isTargetExposed 등 파싱 결과의 신뢰도가 낮다는 뜻이니
   *    대시보드나 통계 집계에서 반드시 구분해서 다뤄야 함.
   */
  searchPerformed: boolean;
}

/**
 * 모든 엔진 어댑터가 구현해야 하는 인터페이스.
 * "query(질문)를 받아서 AdapterResponse를 돌려준다"는 계약.
 */
export interface EngineAdapter {
  /** 이 어댑터가 담당하는 엔진 이름 */
  engineName: EngineName;

  /** 질문을 보내고 응답을 받아오는 함수 */
  ask(query: string): Promise<AdapterResponse>;
}