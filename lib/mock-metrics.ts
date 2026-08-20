import { EngineName } from "@/lib/engine-config";

// 화면 레이아웃 검증용 목업 데이터.
// 실데이터 연결 시 이 파일만 지우고, aggregated_metrics 조회 함수로 교체하면 됨.
export type EngineMetric = {
  rank: number | null;
  exposureRate: number;
  observedCount: number;
  keywords: string[];
};

export const MOCK_METRICS: Record<EngineName, EngineMetric> = {
  perplexity: { rank: 1, exposureRate: 82, observedCount: 6, keywords: ["비대면진료", "투명교정"] },
  chatgpt: { rank: 3, exposureRate: 45, observedCount: 6, keywords: ["강서구 임플란트"] },
  claude: { rank: 2, exposureRate: 67, observedCount: 6, keywords: [] },
  gemini: { rank: null, exposureRate: 0, observedCount: 6, keywords: [] },
  google_aio: { rank: null, exposureRate: 0, observedCount: 0, keywords: [] },
  naver_ai_briefing: { rank: null, exposureRate: 0, observedCount: 0, keywords: [] },
};