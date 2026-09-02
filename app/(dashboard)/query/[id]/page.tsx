import { notFound } from 'next/navigation';
import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchQueryById,
  fetchLatestDiagnosis,
  fetchQuerySnapshotsWithMentions,
  fetchKnownBrands,
  fetchBrandFeatureCandidatesForDiagnosis,
  fetchBrandExpressionsByIds,
  truncateExcerpt,
} from '@/lib/supabase';
import { kstDayBoundsUtc, todayKST } from '@/lib/aggregator';
import { diagnosisDurationDays } from '@/lib/brand-one-liner';
import {
  computeAppearanceHeaderStats,
  computeResponseHeaderStats,
  computeEngineAppearance,
  computeEngineResponse,
  computeMatrix,
  computeCompetitorBrands,
  selectTopCompetitors,
} from '@/lib/query-detail';
import { EngineBreakdownGrid } from '@/components/EngineBreakdownGrid';
import { AppearanceMatrix } from '@/components/AppearanceMatrix';
import { CompetitorBrandList } from '@/components/CompetitorBrandList';
import { QueryEvidenceList, type EvidenceCardData } from '@/components/QueryEvidenceList';
import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';

function engineLabel(engine: string): string {
  return ENGINE_CONFIG[engine as EngineName]?.label ?? engine;
}

export default async function QueryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ brand?: string }>;
}) {
  const { id: queryId } = await params;
  const { brand: brandIdParam } = await searchParams;

  const sessionClient = await createServerSupabaseClient();
  const account = await fetchCurrentAccount(sessionClient);
  if (!account) {
    return (
      <div className="empty-state">
        <p className="es-text">계정 정보를 확인할 수 없습니다. 다시 로그인해주세요.</p>
      </div>
    );
  }

  const query = await fetchQueryById(queryId, sessionClient);
  if (!query) {
    notFound();
  }

  const diagnosis = await fetchLatestDiagnosis(query.brandId, sessionClient);
  if (!diagnosis) {
    return (
      <div className="empty-state">
        <p className="es-text">이 브랜드의 진단 데이터가 아직 없어요.</p>
      </div>
    );
  }

  const periodEndDate = diagnosis.endedAt ?? todayKST();
  const periodStart = kstDayBoundsUtc(diagnosis.startedAt).periodStart;
  const periodEnd = kstDayBoundsUtc(periodEndDate).periodEnd;
  const totalDiagnosisDays = diagnosisDurationDays(diagnosis, periodEndDate);

  const [records, knownBrands] = await Promise.all([
    fetchQuerySnapshotsWithMentions(queryId, periodStart, periodEnd, sessionClient),
    fetchKnownBrands(),
  ]);
  const brandNameById = new Map(knownBrands.map((b) => [b.brandId, b.name]));

  const isRecognition = query.queryType === '인지';
  const backHref = isRecognition
    ? `/brand-awareness${brandIdParam ? `?brand=${brandIdParam}` : ''}`
    : `/brand-position${brandIdParam ? `?brand=${brandIdParam}` : ''}`;
  const backLabel = isRecognition ? '브랜드 인지' : '브랜드 현 위치';

  const headerStats = isRecognition
    ? computeResponseHeaderStats(records, totalDiagnosisDays)
    : computeAppearanceHeaderStats(records);

  const engineRows = isRecognition
    ? computeEngineResponse(records, totalDiagnosisDays)
    : computeEngineAppearance(records);

  const matrix = computeMatrix(records, diagnosis.startedAt, totalDiagnosisDays, isRecognition ? '인지' : '자리');

  const competitorRows = isRecognition
    ? []
    : selectTopCompetitors(computeCompetitorBrands(records, brandNameById));

  // 3-5 "이 질문에서 반복된 표현" — 기존 brand_feature_candidates 그대로 조회,
  // 신규 로직 없음(작업지시서 명시). diagnosis가 아직 completed가 아니면
  // brand_feature_candidates 자체가 생성 전이라 조회하지 않는다.
  // ⚠️ brand_feature_candidates의 근거(brand_expressions)는 인지 질문
  // 답변에서만 추출된다(v1.0~v1.2 파이프라인 전체가 인지 전용) — 그래서
  // 자리 질문에서는 이 섹션이 항상 빈 상태로 보인다. 버그가 아니라 지금
  // 파이프라인이 실제로 커버하는 범위를 정직하게 보여주는 것이다.
  let repeatedExpressions: { label: string; count: number }[] = [];
  if (diagnosis.status === 'completed') {
    const candidates = await fetchBrandFeatureCandidatesForDiagnosis(diagnosis.id, sessionClient);
    const allEvidenceIds = candidates.flatMap((c) => c.evidenceExpressionIds);
    const evidenceRows = await fetchBrandExpressionsByIds(allEvidenceIds, sessionClient);
    const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
    repeatedExpressions = candidates
      .map((c) => ({
        label: c.featureName,
        count: c.evidenceExpressionIds.filter((id) => evidenceById.get(id)?.queryId === queryId).length,
      }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
  }

  // 3-6 "실제 답변 일부와 출처" — 유효 응답만 카드로 보여준다(실패 응답엔
  // 보여줄 만한 답변 자체가 없음).
  const evidenceCards: EvidenceCardData[] = records
    .filter((r) => r.status === 'success' && r.searchPerformed === true)
    .map((r) => {
      const dateTimeLabel = new Date(r.executedAt).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const appeared = isRecognition ? null : r.mentions.some((m) => m.isTarget);
      const appearedBrands = isRecognition
        ? []
        : r.mentions.map((m) => ({
            name: m.brandId ? brandNameById.get(m.brandId) ?? m.brandNameRaw : m.brandNameRaw,
            isTarget: m.isTarget,
          }));

      // 멘션마다 달린 출처를 스냅샷 하나 기준으로 합치고 URL로 중복 제거한다.
      const sourcePairs = new Map<string, string>();
      for (const m of r.mentions) {
        m.sourceUrls.forEach((url, i) => {
          if (url && !sourcePairs.has(url)) sourcePairs.set(url, m.sourceDomains[i] || url);
        });
      }

      return {
        id: r.id,
        engineLabel: engineLabel(r.engine),
        dateTimeLabel,
        appeared,
        appearedBrands,
        shortQuote: truncateExcerpt(r.rawResponse, 160),
        fullQuote: r.rawResponse,
        sources: Array.from(sourcePairs.entries()).map(([url, domain]) => ({ url, domain })),
      };
    });

  return (
    <>
      <div className="crumb">
        <a href={backHref}>← {backLabel}</a>
      </div>

      <div className="q-header">
        <p className="q-eyebrow">{isRecognition ? '인지 질문' : '자리 질문'}</p>
        <h1 className="q-title">&quot;{query.queryText}&quot;</h1>
        <div className="q-meta">
          <span className="stat">
            {headerStats.kind === 'appearance'
              ? `등장률 ${Math.round(headerStats.rate * 100)}% · ${headerStats.totalValidRuns}회 관측 중 ${headerStats.appearedRuns}회 등장 · AI ${headerStats.engineCount}개에서 확인`
              : `응답률 ${Math.round(headerStats.rate * 100)}% · ${headerStats.totalDays}일 중 ${headerStats.respondedDays}일 응답 · AI ${headerStats.engineCount}개에서 확인`}
          </span>
        </div>
      </div>

      {!isRecognition && (
        <section>
          <h2 className="sec">이 질문에서 함께 등장한 브랜드</h2>
          <p className="sec-sub">등장률이 높은 순으로 최대 3개까지 보여드려요.</p>
          <CompetitorBrandList rows={competitorRows} />
        </section>
      )}

      <section>
        <h2 className="sec">AI마다 얼마나 다른가</h2>
        <p className="sec-sub">같은 질문이어도 AI에 따라 결과가 갈려요.</p>
        <EngineBreakdownGrid rows={engineRows} unit={isRecognition ? '응답' : '등장'} />
      </section>

      <section>
        <h2 className="sec">언제 등장했나</h2>
        <p className="sec-sub">관측 회차 하나하나의 기록이에요.</p>
        <AppearanceMatrix matrix={matrix} queryType={isRecognition ? '인지' : '자리'} />
      </section>

      <section>
        <h2 className="sec">이 질문에서 반복된 표현</h2>
        <p className="sec-sub">비슷한 표현은 하나로 합쳤어요.</p>
        {repeatedExpressions.length === 0 ? (
          <p className="es-text">아직 반복 확인된 표현이 없어요.</p>
        ) : (
          <div className="expr-chips">
            {repeatedExpressions.map((r) => (
              <span key={r.label}>
                {r.label} <b style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {r.count}회</b>
              </span>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 0 }}>
        <h2 className="sec">실제 답변 일부와 출처</h2>
        <p className="sec-sub">가장 최근 회차부터 보여드려요. 카드를 펼치면 답변 전체를 볼 수 있어요.</p>
        <QueryEvidenceList cards={evidenceCards} />
      </section>
    </>
  );
}
