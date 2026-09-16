import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchLatestDiagnosis,
  fetchActiveQueries,
  fetchKnownBrands,
  fetchQuerySnapshotsWithMentionsBatch,
  fetchAggregatedKeywordRowsForQueries,
  fetchLatestBrandOneLiner,
  fetchPlacementNarrativeTop10,
  fetchPlacementExpressionClassificationsForDiagnosis,
  fetchBrandOwnedChannels,
  fetchAnswerSourceUrls,
  fetchCurrentReviewItemsForDiagnosis,
  type AggregatedKeywordRow,
} from '@/lib/supabase';
import { kstDayBoundsUtc, todayKST } from '@/lib/aggregator';
import { fetchGapFeatureUniverse } from '@/lib/mention-feature-roles';
import { buildCategoryComparison } from '@/lib/gap';
import { buildQueryPositionStats, selectHeroQuery } from '@/lib/brand-position';
import { buildSourceAnalysis, type SourceAnalysisResult } from '@/lib/source-analysis';

/** "9월 8일" — 사람 검토 완료 배지용. reviewed_at은 UTC ISO라 KST로 바꿔서 표시. */
function formatKstDate(isoUtc: string): string {
  return new Date(isoUtc).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
}

function SourceAnalysisCard({
  title,
  totalLabel,
  analysis,
}: {
  title: string;
  totalLabel: string;
  analysis: SourceAnalysisResult;
}) {
  const top5 = analysis.topDomains.slice(0, 5);
  const rest = analysis.topDomains.slice(5, 15);
  const ownedPct = Math.round(analysis.ownedRate * 100);

  return (
    <div className="narrative-card" style={{ background: 'var(--surface-2)', border: '0.5px solid var(--border-strong)' }}>
      <p className="n-label">{title}</p>
      <div style={{ display: 'flex', height: 10, borderRadius: 4, overflow: 'hidden', margin: '10px 0 8px' }}>
        <div style={{ width: `${ownedPct}%`, background: 'var(--text-brand)' }} />
        <div style={{ width: `${100 - ownedPct}%`, background: 'var(--border-strong)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 14 }}>
        <span style={{ color: 'var(--text-brand)', fontWeight: 600 }}>소유 {ownedPct}%</span>
        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>외부 {100 - ownedPct}%</span>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        {totalLabel}에 달린 인용 전체 기준(우리 브랜드 언급 부분만이 아니라 같이 등장한 다른 치과 인용도 포함) ·
        판정 가능 {analysis.resolvableCount}건(판정불가 {analysis.unresolvableCount}건 제외)
      </p>
      <p className="dp-eyebrow" style={{ marginBottom: 8 }}>
        출처 상위
      </p>
      <div className="expr-list">
        {top5.map((d) => (
          <div className="expr-row" key={d.domain}>
            <p className="en">{d.domain}</p>
            <span className="ec">{d.count}</span>
          </div>
        ))}
      </div>
      {rest.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
            출처 6~{5 + rest.length}위 더 보기
          </summary>
          <div className="expr-list" style={{ marginTop: 6 }}>
            {rest.map((d) => (
              <div className="expr-row" key={d.domain}>
                <p className="en">{d.domain}</p>
                <span className="ec">{d.count}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default async function GapPage({ searchParams }: { searchParams: Promise<{ brand?: string }> }) {
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

  const [brands, diagnosis, recognitionQueriesAll, placementQueriesAll] = await Promise.all([
    fetchTargetBrands(account.id, sessionClient),
    fetchLatestDiagnosis(brandId, sessionClient),
    fetchActiveQueries(['인지']),
    fetchActiveQueries(['자리']),
  ]);

  const brandName = brands.find((b) => b.id === brandId)?.name ?? '이 브랜드';
  const recognitionQueries = recognitionQueriesAll.filter((q) => q.brandId === brandId);
  const placementQueries = placementQueriesAll.filter((q) => q.brandId === brandId);

  if (!diagnosis) {
    return (
      <div className="empty-state">
        <p className="es-text">이 브랜드의 진단 데이터가 아직 없어요.</p>
      </div>
    );
  }

  // 이 화면의 핵심 데이터(브랜드 한 줄, 추천 표현 TOP10)는 전부 진단 완료
  // 시점에 한 번 만들어지는 값이라, 진단 중엔 보여줄 게 없다.
  if (diagnosis.status !== 'completed') {
    return (
      <div className="empty-state">
        <p className="es-text">진단이 아직 진행 중이에요.</p>
        <p className="es-sub">진단이 끝나면 소개와 추천을 나란히 비교해서 보여드려요.</p>
      </div>
    );
  }

  const periodEndDate = diagnosis.endedAt ?? todayKST();
  const periodStart = kstDayBoundsUtc(diagnosis.startedAt).periodStart;
  const periodEnd = kstDayBoundsUtc(periodEndDate).periodEnd;

  // 관측 라벨 — 다른 화면과 같은 공식(CLAUDE.md 알려진 정합성 이슈 2번).
  const diagnosisStart = new Date(`${diagnosis.startedAt}T00:00:00Z`);
  const todayForCount = new Date(`${todayKST()}T00:00:00Z`);
  const daysElapsed =
    Math.round((todayForCount.getTime() - diagnosisStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dayCount = Math.min(Math.max(daysElapsed, 1), 7);
  const observationLabel = '7일 관측 완료';
  void dayCount; // 완료 상태에서만 이 화면을 보여주므로 항상 "완료" 문구 — 변수는 향후 재사용 대비 보존

  const knownBrands = await fetchKnownBrands();
  const brandNameById = new Map(knownBrands.map((b) => [b.brandId, b.name]));
  const knownBrandIdByName = new Map(knownBrands.map((b) => [b.name, b.brandId]));

  const placementQueryIds = placementQueries.map((q) => q.id);

  const [
    oneLinerView,
    recordsByQuery,
    keywordRows,
    candidates,
    placementTop10,
    expressionClassifications,
    ownedChannels,
    awarenessUrls,
    placementUrls,
    narrativeLessons,
  ] = await Promise.all([
    fetchLatestBrandOneLiner(brandId, account.role, sessionClient, diagnosis.id),
    fetchQuerySnapshotsWithMentionsBatch(placementQueryIds, periodStart, periodEnd, sessionClient),
    fetchAggregatedKeywordRowsForQueries(placementQueryIds, periodStart, periodEnd),
    fetchGapFeatureUniverse(brandId, diagnosis.id),
    fetchPlacementNarrativeTop10(diagnosis.id),
    fetchPlacementExpressionClassificationsForDiagnosis(diagnosis.id, sessionClient),
    fetchBrandOwnedChannels(brandId),
    fetchAnswerSourceUrls(brandId, '인지', periodStart, periodEnd),
    fetchAnswerSourceUrls(brandId, '자리', periodStart, periodEnd),
    fetchCurrentReviewItemsForDiagnosis(diagnosis.id, 'narrative_lesson', sessionClient),
  ]);

  // 카드2("추천") — 브랜드 현 위치 화면의 hero 선정 로직을 그대로 재사용.
  const keywordRowsByQuery = new Map<string, AggregatedKeywordRow[]>();
  for (const row of keywordRows) {
    if (!keywordRowsByQuery.has(row.queryId)) keywordRowsByQuery.set(row.queryId, []);
    keywordRowsByQuery.get(row.queryId)!.push(row);
  }
  const positionStats = placementQueries.map((q) =>
    buildQueryPositionStats({
      queryId: q.id,
      queryText: q.queryText,
      records: recordsByQuery.get(q.id) ?? [],
      brandNameById,
      keywordRows: keywordRowsByQuery.get(q.id) ?? [],
      targetBrandName: brandName,
      knownBrandIdByName,
    })
  );
  const heroQuery = selectHeroQuery(positionStats);

  const categoryComparison = buildCategoryComparison(candidates, expressionClassifications);

  const ownedPatterns = ownedChannels.map((c) => c.pattern);
  const awarenessSource = buildSourceAnalysis(awarenessUrls, ownedPatterns);
  const placementSource = buildSourceAnalysis(placementUrls, ownedPatterns);

  const narrativeLesson = narrativeLessons[0] ?? null;

  const oneLinerMain = oneLinerView.main;
  const oneLinerText = oneLinerMain.state === '완료' ? oneLinerMain.oneLiner : null;
  const oneLinerReviewedAt = oneLinerMain.state === '완료' ? oneLinerMain.reviewedAt : null;

  return (
    <>
      <div className="eyebrow-row">
        <span className="eyebrow">인지와 추천, 그 사이</span>
      </div>
      <h1 className="page-title">우리가 하는 말이 실제로 퍼지고 있을까?</h1>
      <p className="subtitle">
        AI가 우리 브랜드를 소개할 때 쓰는 표현이, 우리 브랜드를 추천하는 상황에도 함께 나타나는지 확인해 보아요.
      </p>
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
          {observationLabel}
        </span>
      </p>

      {/* 두 서사 나란히 */}
      <div className="pair-connected">
        <div className="narrative-card">
          <p className="n-label">
            AI가 우리를 <strong style={{ color: 'var(--text-primary)' }}>소개할 때</strong>
          </p>
          {oneLinerText ? (
            <>
              <p className="n-sentence">&quot;{oneLinerText}&quot;</p>
              {oneLinerReviewedAt ? (
                <span className="reviewed-badge">✓ 사람 검토 완료 · {formatKstDate(oneLinerReviewedAt)}</span>
              ) : (
                <span className="pending-badge">검토 대기 중</span>
              )}
            </>
          ) : (
            <p className="n-sentence" style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)' }}>
              아직 브랜드 한 줄이 준비되지 않았어요.
            </p>
          )}
        </div>

        <div className="mid-connector">
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-secondary)', border: 'none', background: 'var(--surface-0)', padding: '5px 10px' }}>
            VS
          </span>
        </div>

        <div className="narrative-card">
          <p className="n-label">
            AI가 우리를 <strong style={{ color: 'var(--text-primary)' }}>추천할 때</strong>
          </p>
          {heroQuery ? (
            <>
              <p style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
                가장 강하게 등장한 자리 질문:
              </p>
              <p className="n-sentence" style={{ fontSize: 16 }}>
                &quot;{heroQuery.queryText}&quot;
              </p>
              <span className="reviewed-badge" style={{ background: 'var(--bg-success)', color: 'var(--text-success)', marginTop: 8 }}>
                등장률 {Math.round(heroQuery.visibilityRate * 100)}% · {heroQuery.totalRuns}회 중 {heroQuery.appearedRuns}회 등장
              </span>
            </>
          ) : (
            <p className="n-sentence" style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)' }}>
              아직 등장 데이터가 충분하지 않아요.
            </p>
          )}
        </div>
      </div>

      {/* 전제 설명 */}
      <div className="narrative-card" style={{ marginBottom: 24 }}>
        <p style={{ fontSize: 15, fontWeight: 500, lineHeight: 1.65, margin: '0 0 10px' }}>
          AI들이 우리 브랜드를 소개할 때 나타나는 대표적인 특징과, 우리 브랜드를 추천할 때 등장하는 특징이
          비슷할수록 브랜드 메시지가 잘 퍼지고 있다고 볼 수 있습니다.
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          *전제: 브랜드 한 줄이 실제 브랜드 메시지와 같다고 볼 때의 해석이에요.
        </p>
      </div>

      {/* 카테고리별 비교 (작업지시서_표현정규화_2026-09-16_V1.2 §5단계 — TOP10 순위 대조를 대체) */}
      <p className="section-title">카테고리별 비교 — 소개 vs 추천</p>
      <p className="section-desc">
        브랜드 한 줄 특징 후보 {candidates.length}개 전체 vs 자리질문 {placementQueries.length}개 답변 전체
        {placementTop10 ? `(${placementTop10.appearedRuns}건)` : ''}에서 뽑은 표현을, 소개 특징에 이미 쓰인
        7개 카테고리 기준으로 나란히 봅니다.
      </p>

      {expressionClassifications.length === 0 ? (
        <p className="es-text" style={{ fontSize: 13, marginBottom: 24 }}>
          아직 계산되지 않았어요 — 진단 완료 다음날 자동으로 채워져요.
        </p>
      ) : (
        <div style={{ marginBottom: 8 }}>
          {categoryComparison.map((row) => (
            <div
              className="narrative-card"
              key={row.category}
              style={{ background: 'var(--surface-2)', border: '0.5px solid var(--border-strong)', marginBottom: 10 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                <p className="n-label" style={{ margin: 0 }}>
                  {row.category}
                </p>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  소개 특징 {row.awarenessCount}개 · 추천 등장 {Math.round(row.placementRate * 100)}% (
                  {row.placementOccurrence}/{row.appearedRuns}건 중)
                </span>
              </div>
              {row.topAwarenessFeatureNames.length > 0 && (
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '8px 0 0' }}>
                  소개: {row.topAwarenessFeatureNames.join(', ')}
                </p>
              )}
              {row.matchedFeatureNames.length > 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-brand)', fontWeight: 500, margin: '4px 0 0' }}>
                  추천에서도 구체적으로 확인됨: {row.matchedFeatureNames.join(', ')}
                </p>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  카테고리는 겹치지만, 추천에서 구체적으로 같은 특징까지 확인되진 않았어요.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="caption-note" style={{ marginBottom: 24 }}>
        &quot;추천에서도 구체적으로 확인됨&quot;은 카테고리가 같다는 이유만으로 묶은 게 아니라, 같은 카테고리
        안에서 세부 의미까지 같다고 판정된 것만 표시해요(예: &quot;365일 연중무휴 진료&quot;와 &quot;일요일
        진료&quot;는 같은 특징으로 보지만, 같은 카테고리라도 서로 다른 구체적 주장이면 묶지 않아요). 7개 카테고리
        어디에도 안 맞는 추천 표현은 이 비교에서 빠져요 — 반복해서 나타나면 카테고리를 보완할지 별도로 검토해요.
      </p>

      {/* AI는 어디서 정보를 가져올까 */}
      <p className="section-title">AI는 어디서 정보를 가져올까</p>
      <p className="section-desc">소개와 추천 특징이 서로 달라지는 이유.</p>

      {ownedChannels.length === 0 ? (
        <div
          className="narrative-card"
          style={{ marginBottom: 20, background: 'var(--surface-2)', border: '1px dashed var(--border-strong)', textAlign: 'center', padding: 28 }}
        >
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '0 0 6px' }}>
            아직 소유 채널이 등록되지 않았어요.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            홈페이지 외 채널(인스타·블로그·유튜브 등)을 등록하면, AI가 브랜드를 소개·추천할 때 어디를 더 많이
            참고하는지 볼 수 있어요.
          </p>
        </div>
      ) : (
        <div className="narrative-pair" style={{ marginBottom: 8, alignItems: 'stretch' }}>
          <SourceAnalysisCard
            title={`소개할 때 인용된 출처 (${awarenessUrls.length}건)`}
            totalLabel="인지 질문 답변 전체"
            analysis={awarenessSource}
          />
          <SourceAnalysisCard
            title={`추천할 때 인용된 출처 (${placementUrls.length}건)`}
            totalLabel="자리 질문 답변 전체"
            analysis={placementSource}
          />
        </div>
      )}

      {/* 엔슬의 제안 */}
      <p className="section-title">엔슬의 제안</p>
      {narrativeLesson ? (
        <div className="narrative-card">
          <p style={{ fontSize: 16, fontWeight: 500, lineHeight: 1.6, margin: 0 }}>
            {narrativeLesson.finalText ?? narrativeLesson.aiText}
          </p>
        </div>
      ) : (
        <p className="es-text" style={{ fontSize: 13 }}>
          아직 제안이 준비되지 않았어요.
        </p>
      )}

      <div className="tip-box">
        <span className="tip-badge">TIP</span>
        <p className="tip-title">같은 표현이 양쪽에 있다면, 눈여겨볼 신호예요.</p>
        <p className="tip-desc">
          AI는 브랜드가 스스로 하는 말(소유 채널)보다, 제3자가 쓴 말(외부 채널)을 더 많이 참고해서 추천 답변을
          만듭니다. 소개할 때 쓰는 표현이 추천할 때도 함께 나타난다면, 그게 우리가 원래 하려던 말이었는지
          확인해볼 만해요.
        </p>
      </div>
    </>
  );
}
