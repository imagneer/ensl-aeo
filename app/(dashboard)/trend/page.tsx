import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchLatestDiagnosis,
  fetchDiagnosesForBrand,
  fetchActiveQueries,
  fetchKnownBrands,
  fetchDailyMetricsAcrossEngines,
  fetchQuestionEvidenceSummary,
  type QuestionEvidenceSummary,
} from '@/lib/supabase';
import {
  buildComparisonWindow,
  classifyPlacementTransition,
  selectFeaturedPlacementQueries,
  enumerateKstDays,
  kstDayFromPeriodStart,
  formatMD,
  type DailyValuePoint,
  type PlacementQueryTransition,
} from '@/lib/trend';
import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';
import { TrendPlacementChart, type TrendChartSeries } from '@/components/TrendPlacementChart';

function engineLabel(engine: string): string {
  return ENGINE_CONFIG[engine as EngineName]?.label ?? engine;
}

/** "9월 1일" 형식(사람 검토 배지 등에서 쓰는 것과 같은 포맷, 여기서는 답변 날짜 표시용). */
function formatKstFullDate(dateKST: string): string {
  return new Date(`${dateKST}T00:00:00Z`).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}

const LINE_COLORS = ['var(--line-q1)', 'var(--line-q2)', 'var(--line-q3)', 'var(--line-q4)'];

export default async function TrendPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const { brand: brandId } = await searchParams;

  if (!brandId) {
    return (
      <div className="empty-state">
        <p className="es-text">먼저 사이드바에서 진단할 브랜드를 선택해주세요.</p>
      </div>
    );
  }

  const sessionClient = await createServerSupabaseClient();
  const account = await fetchCurrentAccount(sessionClient);

  if (!account) {
    return (
      <div className="empty-state">
        <p className="es-text">계정 정보를 확인할 수 없습니다. 다시 로그인해주세요.</p>
      </div>
    );
  }

  const [brands, diagnosis] = await Promise.all([
    fetchTargetBrands(account.id, sessionClient),
    fetchLatestDiagnosis(brandId, sessionClient),
  ]);

  const brandName = brands.find((b) => b.id === brandId)?.name ?? '이 브랜드';

  if (!diagnosis) {
    return (
      <div className="empty-state">
        <p className="es-text">이 브랜드의 진단 데이터가 아직 없어요.</p>
      </div>
    );
  }

  const [diagnosesForBrand, knownBrands, placementQueriesAll, recognitionQueriesAll] = await Promise.all([
    fetchDiagnosesForBrand(brandId, sessionClient),
    fetchKnownBrands(),
    fetchActiveQueries(['자리']),
    fetchActiveQueries(['인지']),
  ]);

  const placementQueries = placementQueriesAll.filter((q) => q.brandId === brandId);
  const recognitionQueries = recognitionQueriesAll.filter((q) => q.brandId === brandId);
  const competitors = knownBrands.filter((b) => b.brandId !== brandId);

  if (placementQueries.length === 0) {
    return (
      <div className="empty-state">
        <p className="es-text">이 브랜드의 자리 질문이 아직 없어요.</p>
      </div>
    );
  }

  const window = buildComparisonWindow(diagnosis, diagnosesForBrand);
  const sequenceIndex = diagnosesForBrand.findIndex((d) => d.id === diagnosis.id);
  const sequence = sequenceIndex === -1 ? 1 : sequenceIndex + 1;

  // 자리 질문마다 day-by-day(6개 엔진 합산) 집계를 받아서 전환 유형을 판정한다.
  // (2026-09-14 — lib/trend.ts classifyPlacementTransition, 2026-09-10 실측
  // 검증 완료 로직 그대로)
  const transitions: PlacementQueryTransition[] = [];
  const seriesByQueryId = new Map<
    string,
    Awaited<ReturnType<typeof fetchDailyMetricsAcrossEngines>>
  >();

  await Promise.all(
    placementQueries.map(async (q) => {
      const fullRange = await fetchDailyMetricsAcrossEngines({
        queryId: q.id,
        brandId,
        periodStart: window.periodA.start,
        periodEnd: window.periodB.end,
      });
      seriesByQueryId.set(q.id, fullRange);

      const periodAPoints = fullRange.filter(
        (r) => r.periodStart >= window.periodA.start && r.periodStart < window.periodA.end
      );
      const periodBPoints = fullRange.filter(
        (r) => r.periodStart >= window.periodB.start && r.periodStart < window.periodB.end
      );
      const fullSeries: DailyValuePoint[] = fullRange.map((r) => ({
        periodStart: r.periodStart,
        value: r.visibilityRate,
      }));
      const competitorSeries = competitors.map((c) => ({
        brandId: c.brandId,
        name: c.name,
        series: fullRange.map((r) => ({
          periodStart: r.periodStart,
          value:
            r.totalRuns > 0 ? (r.competitorMentionCounts[c.brandId]?.mentionCount ?? 0) / r.totalRuns : null,
        })),
      }));

      transitions.push(
        classifyPlacementTransition(q.id, periodAPoints, periodBPoints, fullSeries, competitorSeries)
      );
    })
  );

  const featured = selectFeaturedPlacementQueries(transitions, 4);
  const queryTextById = new Map(placementQueries.map((q) => [q.id, q.queryText]));

  // 근거(초반/후반 실제 답변) — TOP4로 뽑힌 질문만, 배치로 한 번에.
  const featuredIds = featured.map((f) => f.queryId);
  const [periodAEvidenceList, periodBEvidenceList] = await Promise.all([
    fetchQuestionEvidenceSummary(featuredIds, window.periodA.start, window.periodA.end),
    fetchQuestionEvidenceSummary(featuredIds, window.periodB.start, window.periodB.end),
  ]);
  const periodAEvidenceById = new Map<string, QuestionEvidenceSummary>(
    periodAEvidenceList.map((e) => [e.queryId, e])
  );
  const periodBEvidenceById = new Map<string, QuestionEvidenceSummary>(
    periodBEvidenceList.map((e) => [e.queryId, e])
  );

  // 그래프 x축 — 비교 구간 전체(초반~후반)를 날짜로 펼치고, 질문마다
  // 빠진 날이 있으면 그 자리를 null로 남긴다(값을 이어붙이지 않음).
  const dayList = enumerateKstDays(window.periodA.start, window.periodB.end);
  const dayLabels = dayList.map(formatMD);

  const chartSeries: TrendChartSeries[] = featured.map((f, i) => {
    const rows = seriesByQueryId.get(f.queryId) ?? [];
    const byDay = new Map(rows.map((r) => [kstDayFromPeriodStart(r.periodStart), r.visibilityRate]));
    return {
      key: f.queryId,
      label: queryTextById.get(f.queryId) ?? f.queryId,
      color: LINE_COLORS[i % LINE_COLORS.length],
      dashed: f.ownTrend.confidence !== 'confirmed' && f.dataIncomplete,
      points: dayList.map((day) => byDay.get(day) ?? null),
    };
  });

  const transitionTypeLabel: Record<PlacementQueryTransition['transitionType'], string> = {
    rise: '가끔 → 강하게 선택됨',
    start: '아직 선택 안 됨 → 가끔 선택됨',
    fall: '강하게 선택됨 → 약해짐',
    comp: '경쟁 브랜드 부상',
  };

  return (
    <>
      <div className="eyebrow-row">
        <span className="eyebrow">변화 추이</span>
      </div>
      <h1 className="page-title">자리 질문에서 우리 브랜드는 어떻게 달라지고 있나?</h1>
      <p className="meta-row">
        <span>
          <i className="ti ti-help-circle" />
          인지 질문 {recognitionQueries.length}개
        </span>
        <span>
          <i className="ti ti-target-arrow" />
          자리 질문 {placementQueries.length}개
        </span>
        <span>
          <i className="ti ti-robot" />
          AI 6개
        </span>
        <span>
          <i className="ti ti-circle-check" />
          {sequence}차 진단 · {formatMD(diagnosis.startedAt)}~{formatMD(diagnosis.endedAt ?? window.periodB.end.slice(0, 10))}
        </span>
      </p>
      <p className="basis-line">
        <b>{window.basisLabel}</b>
        {window.periodBInProgress && (
          <>
            <span className="sep">·</span>
            <span>진행 중인 진단 — 후반 구간이 아직 다 안 채워졌을 수 있어요</span>
          </>
        )}
      </p>

      <section>
        <h2 className="section-title">자리 질문, 이번 주 흐름</h2>
        <p className="section-desc">
          {placementQueries.length}개 자리 질문 중 변화가 뚜렷한 4개예요. 3일 연속 같은 방향으로 확인된 변화를
          우선 보여드리고, 부족한 자리는 변화 폭이 큰 순서로 채웠어요.
        </p>

        <TrendPlacementChart dayLabels={dayLabels} series={chartSeries} />

        <details className="acc-section" open>
          <summary className="acc-head">
            <div>
              <p className="at">자리 질문, 어디서 바뀌었을까?</p>
              <p className="as">전환 유형별 근거 — 브랜드는 {brandName}</p>
            </div>
            <i className="ti ti-chevron-down acc-chev" />
          </summary>
          <div className="acc-body">
            <div className="flist">
              {featured.map((f) => {
                const a = f.periodARate !== null ? `${Math.round(f.periodARate * 100)}%` : '판정 불가';
                const b = f.periodBRate !== null ? `${Math.round(f.periodBRate * 100)}%` : '판정 불가';
                return (
                  <div className="frow" key={f.queryId}>
                    <div>
                      <p className="fname">{queryTextById.get(f.queryId)}</p>
                      <p className="fsub">
                        초반 {a} → 후반 {b}
                        {f.ownTrend.confidence !== 'confirmed' ? ' · 관찰 중인 신호' : ' · 확인된 변화'}
                        {f.dataIncomplete ? ' · 일부 구간 판정 불가' : ''}
                      </p>
                    </div>
                    <div className="right">
                      <span className={`pill ${f.transitionType}`}>
                        {transitionTypeLabel[f.transitionType]}
                        {f.transitionType === 'comp' && f.risingCompetitor ? ` (${f.risingCompetitor.name})` : ''}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {featured.map((f) => {
              const evA = periodAEvidenceById.get(f.queryId);
              const evB = periodBEvidenceById.get(f.queryId);
              return (
                <div className="detail-panel" key={f.queryId}>
                  <div className="dp-top">
                    <div>
                      <p className="dp-eyebrow">자리 질문 변화 근거</p>
                      <h3 className="dp-name">{queryTextById.get(f.queryId)}</h3>
                    </div>
                    <span className={`pill ${f.transitionType}`}>{transitionTypeLabel[f.transitionType]}</span>
                  </div>
                  <div className="dp-track">
                    <div className="tbox">
                      <p className="k">{window.periodA.label} 평균</p>
                      <p className="v">{f.periodARate !== null ? `${Math.round(f.periodARate * 100)}%` : '판정 불가'}</p>
                    </div>
                    <span className="tarrow">→</span>
                    <div className="tbox">
                      <p className="k">{window.periodB.label} 평균</p>
                      <p className="v">{f.periodBRate !== null ? `${Math.round(f.periodBRate * 100)}%` : '판정 불가'}</p>
                    </div>
                  </div>
                  <div className="dp-grid">
                    <div className="dp-card">
                      <p className="t">초반 답변</p>
                      {evA?.representative ? (
                        <>
                          <p className="q">&quot;{evA.representative.excerpt}&quot;</p>
                          <p className="s">
                            {engineLabel(evA.representative.engine)} ·{' '}
                            {formatKstFullDate(evA.representative.executedAt.slice(0, 10))}
                          </p>
                        </>
                      ) : (
                        <p className="q">이 구간에 유효한 답변이 없었어요.</p>
                      )}
                    </div>
                    <div className="dp-card">
                      <p className="t">후반 답변</p>
                      {evB?.representative ? (
                        <>
                          <p className="q">&quot;{evB.representative.excerpt}&quot;</p>
                          <p className="s">
                            {engineLabel(evB.representative.engine)} ·{' '}
                            {formatKstFullDate(evB.representative.executedAt.slice(0, 10))}
                          </p>
                        </>
                      ) : (
                        <p className="q">이 구간에 유효한 답변이 없었어요.</p>
                      )}
                    </div>
                  </div>
                  <div className="dp-fact">
                    <p className="t">현재 확인된 사실</p>
                    <p className="v">
                      {f.ownTrend.confidence === 'confirmed'
                        ? `최근 ${f.ownTrend.consecutiveDays}일 연속 같은 방향으로 움직였어요. 일시적 흔들림이 아니라 확인된 추세로 분류했어요.`
                        : '아직 등락이 섞여있어서, 확인된 추세가 아니라 관찰 중인 신호로 남겨뒀어요 — 다음 진단에서도 같은 방향이면 확인된 추세로 올라가요.'}
                      {f.transitionType === 'comp' && f.risingCompetitor
                        ? ` 같은 기간에 ${f.risingCompetitor.name}이(가) 이 자리에서 함께 관찰됐어요.`
                        : ''}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </section>
    </>
  );
}
