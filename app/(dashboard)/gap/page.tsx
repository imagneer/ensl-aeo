import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchLatestDiagnosis,
  fetchActiveQueries,
  fetchQuerySnapshotsWithMentionsBatch,
  fetchAggregatedKeywordRowsForQueries,
  fetchBrandExpressionsByIds,
  fetchMentionFeatureRolesForPlacement,
  fetchPlacementMentionsForRoleJudgment,
  fetchGapFeatureNarratives,
  fetchKnownBrands,
  type PlacementMentionForRoleJudgment,
  type MentionFeatureRoleRow,
} from '@/lib/supabase';
import { kstDayBoundsUtc, todayKST } from '@/lib/aggregator';
import { fetchGapFeatureUniverse, getBrandSegmentText } from '@/lib/mention-feature-roles';
import {
  buildFeatureGapStats,
  sumPlacementTotalValidRuns,
  sumPlacementAppearedRuns,
  buildPlacementFeatureFrequencyTop10,
  selectGapHero,
  sortForFeatureList,
  visibleGapFeatures,
  buildHeroSentence,
  buildFeatureConclusionSentence,
  computeCompetitorFeatureMentions,
  computeCompetitorFeatureExpressions,
  GAP_PILL_LABEL,
  type FeatureGapStat,
} from '@/lib/gap';
import {
  MIN_RUNS_FOR_JUDGMENT,
  classifyObservationConfidence,
  OBSERVATION_CONFIDENCE_LABEL,
} from '@/lib/badge-thresholds';
import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';
import type { KnownBrand } from '@/lib/parser';
import { GapTipsModal } from '@/components/GapTipsModal';
import { GapFeatureList, GapFeatureRow, GapFeatureDetailPanel } from '@/components/GapFeatureList';

function engineLabel(engine: string): string {
  return ENGINE_CONFIG[engine as EngineName]?.label ?? engine;
}

function dateLabel(executedAt: string): string {
  return new Date(executedAt).toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
  });
}

interface RepresentativeMention {
  engine: string;
  executedAt: string;
  excerpt: string;
}

/** roleRows에서 이 특징·역할에 해당하는 mention 하나를 찾아 구간 텍스트를 재구성한다. */
function findRepresentativeMention(
  featureName: string,
  role: 'reason_stated' | 'co_mentioned',
  roleRows: MentionFeatureRoleRow[],
  mentionById: Map<string, PlacementMentionForRoleJudgment>,
  knownBrands: KnownBrand[],
  ourBrandName: string
): RepresentativeMention | null {
  const row = roleRows.find((r) => r.featureText === featureName && r.role === role);
  if (!row) return null;
  const mention = mentionById.get(row.mentionId);
  if (!mention) return null;
  const text = getBrandSegmentText(mention.rawResponse, knownBrands, ourBrandName);
  if (!text) return null;
  return {
    engine: mention.engine,
    executedAt: mention.executedAt,
    excerpt: text.length > 220 ? `${text.slice(0, 220)}…` : text,
  };
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

  const [brands, diagnosis, knownBrands, recognitionQueries] = await Promise.all([
    fetchTargetBrands(account.id, sessionClient),
    fetchLatestDiagnosis(brandId, sessionClient),
    fetchKnownBrands(),
    fetchActiveQueries(['인지']),
  ]);

  const brandName = brands.find((b) => b.id === brandId)?.name ?? '이 브랜드';
  const ourBrand = knownBrands.find((b) => b.brandId === brandId);

  if (!diagnosis) {
    return (
      <div className="empty-state">
        <p className="es-text">이 브랜드의 진단 데이터가 아직 없어요.</p>
      </div>
    );
  }

  const placementQueries = (await fetchActiveQueries(['자리'])).filter((q) => q.brandId === brandId);

  if (placementQueries.length === 0) {
    return (
      <div className="empty-state">
        <p className="es-text">아직 등록된 자리 질문이 없어요.</p>
      </div>
    );
  }

  const periodEndDate = diagnosis.endedAt ?? todayKST();
  const periodStart = kstDayBoundsUtc(diagnosis.startedAt).periodStart;
  const periodEnd = kstDayBoundsUtc(periodEndDate).periodEnd;

  // 관측 라벨 — brand-position.ts(Day21)와 같은 공식(CLAUDE.md 알려진 정합성
  // 이슈 2번: 화면마다 다른 날짜 계산을 쓰면 같은 진단이 다른 숫자로 보인다).
  const diagnosisStart = new Date(`${diagnosis.startedAt}T00:00:00Z`);
  const todayForCount = new Date(`${todayKST()}T00:00:00Z`);
  const daysElapsed =
    Math.round((todayForCount.getTime() - diagnosisStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dayCount = Math.min(Math.max(daysElapsed, 1), 7);
  const observationLabel = diagnosis.status === 'completed' ? '7일 관측 완료' : `${dayCount}일차 관측 중`;

  const placementQueryIds = placementQueries.map((q) => q.id);

  const [candidates, roleRows, recordsByQuery, aggregatedRows, narratives, placementMentions] = await Promise.all([
    fetchGapFeatureUniverse(brandId, diagnosis.id),
    fetchMentionFeatureRolesForPlacement(brandId, periodStart, periodEnd),
    fetchQuerySnapshotsWithMentionsBatch(placementQueryIds, periodStart, periodEnd, sessionClient),
    fetchAggregatedKeywordRowsForQueries(placementQueryIds, periodStart, periodEnd),
    fetchGapFeatureNarratives(diagnosis.id, sessionClient),
    fetchPlacementMentionsForRoleJudgment(brandId, periodStart, periodEnd),
  ]);

  // candidates는 brand_feature_candidates(v1.1) 기반이라, 진단이 아직
  // 'collecting'이라 브랜드 한 줄이 한 번도 합성 안 됐으면 항상 빈
  // 배열이다(Day20 화면과 같은 게이팅 — view.main.state==='완료' 조건과
  // 동일한 이유).
  if (candidates.length === 0) {
    return (
      <div className="empty-state">
        <p className="es-text">아직 인지 쪽 특징이 확인되지 않았어요.</p>
        <p className="es-sub">브랜드 인지 화면에서 첫 브랜드 한 줄이 만들어지면 이 화면도 채워져요.</p>
      </div>
    );
  }

  const totalValidRuns = sumPlacementTotalValidRuns([...recordsByQuery.values()]);
  const totalAppearedRuns = sumPlacementAppearedRuns([...recordsByQuery.values()]);
  const placementFeatureTop10 = buildPlacementFeatureFrequencyTop10(aggregatedRows, totalAppearedRuns);
  // ⚠️ (2026-09-09 확인) aggregated_metrics 집계가 실시간 데이터보다 밀려 있어서,
  // "우리 브랜드 등장"(totalAppearedRuns)만큼 표현 데이터가 다 있지는 않다 —
  // 화면에 이 차이를 숨기지 않기 위해 별도로 세서 캡션에 보여준다.
  const placementFeatureDataRuns = aggregatedRows.filter(
    (r) => r.topKeywords !== null && r.topKeywords !== undefined
  ).length;
  const allStats = buildFeatureGapStats(candidates, roleRows, totalValidRuns);
  const visible = visibleGapFeatures(allStats);
  const sorted = sortForFeatureList(visible);
  const hero = selectGapHero(visible);

  const narrativeByFeature = new Map(narratives.map((n) => [n.featureText, n]));
  const mentionById = new Map(placementMentions.map((m) => [m.mentionId, m]));

  const allEvidenceIds = candidates.flatMap((c) => c.evidenceExpressionIds);
  const evidenceRows = await fetchBrandExpressionsByIds(allEvidenceIds, sessionClient);
  const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));

  const heroSentence = hero ? buildHeroSentence(brandName, hero) : null;
  const heroCompetitors = hero ? computeCompetitorFeatureMentions(hero.featureName, aggregatedRows) : [];

  function awarenessEvidence(stat: FeatureGapStat) {
    const candidate = candidateById.get(stat.featureId);
    const firstId = candidate?.evidenceExpressionIds[0];
    return firstId ? evidenceById.get(firstId) : undefined;
  }

  function renderFeatureDetail(stat: FeatureGapStat) {
    const narrative = narrativeByFeature.get(stat.featureName);
    const evidence = awarenessEvidence(stat);
    const reasonEvidence = ourBrand
      ? findRepresentativeMention(stat.featureName, 'reason_stated', roleRows, mentionById, knownBrands, ourBrand.name)
      : null;
    const competitorExpressions = computeCompetitorFeatureExpressions(stat.featureName, aggregatedRows);

    return (
      <div className="detail-panel">
        <div className="dp-top">
          <div>
            <p className="dp-eyebrow">선택한 특징의 판정 근거</p>
            <h3 className="dp-name">{stat.featureName}</h3>
          </div>
          <span className={`pill ${stat.pill}`}>{GAP_PILL_LABEL[stat.pill!]}</span>
        </div>

        {stat.isLocationContext && (
          <div className="dp-card" style={{ marginBottom: 14 }}>
            <p className="t">왜 조건 정보로 분류했나</p>
            <p className="q">
              &apos;{stat.featureName}&apos;은(는) 자리 질문 문구 자체에 이미 포함된 지역·조건이에요. 답변에
              등장하는 게 추천 근거인지, 질문 조건을 그대로 되풀이한 것인지 구분할 수 없어서, 이런 표현은
              &apos;특징&apos;이 아니라 &apos;조건 정보&apos;로 따로 분리해요.
            </p>
          </div>
        )}

        {!narrative ? (
          <p className="note">
            이 특징은 자리질문 답변에 등장한 횟수(근거 연결 + 동시 언급 합계)가 아직 최소 기준(
            {MIN_RUNS_FOR_JUDGMENT}회)에 못 미쳐서 판단하기 일러요. {stat.placementReasonStatedCount + stat.placementCoMentionedCount}회 중
            기준 미달.
          </p>
        ) : (
          <>
            <div className="stat3">
              <div className="stat3-card">
                <p className="k">인지 답변</p>
                <p className="v">
                  {stat.awarenessEngineCount}/{stat.awarenessEngineTotal}개 AI
                </p>
                <p className="d">인지 질문 답변에서 특징으로 확인</p>
              </div>
              <div className="stat3-card">
                <p className="k">자리 질문 답변</p>
                <p className="v">
                  {stat.placementReasonStatedCount}/{stat.placementTotalValidRuns}건
                </p>
                <p className="d">추천 근거로 확인 {stat.placementReasonStatedCount}건</p>
              </div>
              <div className="stat3-card">
                <p className="k">판정 신뢰도</p>
                <p className="v">
                  {OBSERVATION_CONFIDENCE_LABEL[
                    classifyObservationConfidence(stat.placementReasonStatedCount + stat.placementCoMentionedCount)
                  ]}
                </p>
                <p className="d">
                  자리 질문 답변 {stat.placementReasonStatedCount + stat.placementCoMentionedCount}건 관측 기준
                </p>
              </div>
            </div>

            <div className={`why-box${narrative.whyBoxSentences.length < 2 ? ' why-box-single' : ''}`}>
              <p className="k">왜 이렇게 판정했을까?</p>
              <p className="headline">{narrative.whyBoxSentences[0]}</p>
              {narrative.whyBoxSentences.length > 1 && (
                <ul>
                  {narrative.whyBoxSentences.slice(1).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </div>

            {competitorExpressions.length > 0 && (
              <>
                <div className="expr-header">
                  <div>
                    <p className="expr-eyebrow">다른 브랜드 답변에서 반복된 표현</p>
                    <p className="expr-title">이 특징, 다른 브랜드 답변에서 반복된 표현</p>
                  </div>
                  <span className="expr-meta">{stat.placementTotalValidRuns}개 유효 답변</span>
                </div>
                <div className="expr-list">
                  {competitorExpressions.map((e, i) => (
                    <div className="expr-row" key={i}>
                      <div>
                        <p className="en">{e.keyword}</p>
                        <p className="eb" style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                          {e.brandName}
                        </p>
                      </div>
                      <span className="ec">{e.count}회</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="dp-grid">
              <div className="dp-card">
                <p className="t">인지 답변의 대표 근거</p>
                {evidence ? (
                  <>
                    <p className="q">
                      &quot;{evidence.queryText}&quot;
                      <br />
                      <br />
                      &quot;{evidence.sourceSentence}&quot;
                    </p>
                    <p className="s">
                      {engineLabel(evidence.engine)} · {dateLabel(evidence.observedDate)}
                    </p>
                  </>
                ) : (
                  <p className="q">인지 질문 답변에서 확인된 근거가 아직 없어요.</p>
                )}
              </div>
              <div className="dp-card">
                <p className="t">추천 근거로 확인된 답변</p>
                {reasonEvidence ? (
                  <>
                    <p className="q">&quot;{reasonEvidence.excerpt}&quot;</p>
                    <p className="s">
                      {engineLabel(reasonEvidence.engine)} · {dateLabel(reasonEvidence.executedAt)} · 추천 근거로
                      판정
                    </p>
                  </>
                ) : (
                  <p className="q">아직 추천 답변에서 근거로 확인된 사례가 없어요.</p>
                )}
              </div>
            </div>

            {narrative.counterBoxCases.length > 0 && (
              <details className="counter-box">
                <summary className="counter-head">
                  <span className="l">
                    <span className="chev">▾</span>반대 증거와 제외된 사례
                  </span>
                  <span className="n">{narrative.counterBoxCases.length}건</span>
                </summary>
                <div className="counter-body">
                  <ul>
                    {narrative.counterBoxCases.map((c, i) => (
                      <li key={i}>{c.explanation}</li>
                    ))}
                  </ul>
                </div>
              </details>
            )}

            {!stat.isLocationContext && (
              <div className="dp-fact" style={{ marginTop: 16 }}>
                <p className="t">현재 확인된 사실</p>
                <p className="v">{buildFeatureConclusionSentence(stat)}</p>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="eyebrow-row">
        <span className="eyebrow">인지와 위치의 간극</span>
        <span className="approved-badge">✓ 자동 검수 완료</span>
      </div>
      <h1 className="page-title">알고 있는 특징은 추천 답변까지 이어지고 있을까?</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '-4px 0 20px' }}>
        AI가 아는 것 중 무엇이 실제{' '}
        <strong style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>추천 근거</strong>로 쓰이는지
        확인해요.
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

      {hero ? (
        <div className="hero">
          <p className="sub-label">가장 큰 간극</p>
          <p className="fname">{hero.featureName}</p>

          <div className="split">
            <div className="split-box">
              <p className="k">AI가 알고 있음</p>
              <p className="v">
                {hero.awarenessEngineCount}/{hero.awarenessEngineTotal}개 AI
              </p>
              <p className="d">인지 질문 답변에서 브랜드 특징으로 확인</p>
            </div>
            <div className="gap-connector">
              <div className="line" />
              <span className="tag">추천 근거로 아직 연결되지 않음</span>
            </div>
            <div className="split-box">
              <p className="k">추천 답변에서 근거로 확인됨</p>
              <p className="v">
                {hero.placementReasonStatedCount}/{hero.placementTotalValidRuns}건
              </p>
              <p className="d">자리 질문 {placementQueries.length}개 답변 전체 유효 관측 중 근거로 확인된 건수</p>
            </div>
          </div>

          <p className="sentence">{heroSentence}</p>

          <div className="compare-box">
            <p className="compare-head">이 특징, 다른 브랜드 답변에도 함께 등장한 횟수</p>
            <p className="compare-sub">경쟁 브랜드는 이 자리에서 어떤 특징으로 함께 언급됐을까?</p>
            <div className="compare-row">
              <span className="who">
                {brandName} <span className="tag-ours">(우리)</span>
              </span>
              <span className={`reason${hero.placementReasonStatedCount === 0 ? ' none' : ''}`}>
                {hero.featureName} · {hero.placementReasonStatedCount}/{hero.placementTotalValidRuns}건
              </span>
            </div>
            {heroCompetitors.slice(0, 3).map((c) => (
              <div key={c.name}>
                <div className="compare-divider" />
                <div className="compare-row">
                  <span className="who">{c.name}</span>
                  <span className="reason">함께 언급 · {c.count}회</span>
                </div>
              </div>
            ))}
            <p className="compare-caption">
              경쟁사 데이터는 아직 근거 연결 여부까지 판정되지 않았어요. 함께 언급된 횟수만 보여드려요.
            </p>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <p className="es-text">뚜렷한 간극이 아직 확인되지 않았어요.</p>
          <p className="es-sub">인지된 특징이 자리 질문에서도 고르게 근거로 확인되고 있어요.</p>
        </div>
      )}

      <section style={{ marginBottom: 0 }}>
        <h2 className="sec">특징은 어디까지 이어졌을까?</h2>
        <p className="sec-sub">중요한 간극부터 보여드려요. 항목을 누르면 아래 근거가 바뀌어요.</p>

        <GapFeatureList defaultSelectedId={hero?.featureId ?? null}>
          <div className="flist">
            {sorted.map((stat) => (
              <GapFeatureRow
                key={stat.featureId}
                featureId={stat.featureId}
                featureName={stat.featureName}
                fsub={`인지 ${stat.awarenessEngineCount}/${stat.awarenessEngineTotal} · 추천 근거 ${stat.placementReasonStatedCount}/${stat.placementTotalValidRuns}`}
                pillClassName={stat.pill!}
                pillLabel={GAP_PILL_LABEL[stat.pill!]}
              />
            ))}
          </div>

          <GapFeatureDetailPanel>
            {sorted.map((stat) => (
              <div key={stat.featureId} data-feature-id={stat.featureId}>
                {renderFeatureDetail(stat)}
              </div>
            ))}
          </GapFeatureDetailPanel>
        </GapFeatureList>
      </section>

      {placementFeatureTop10.length > 0 && (
        <section>
          <h2 className="sec">자리 질문에서 반복된 표현 TOP10</h2>
          <p className="sec-sub">
            자리 질문 {placementQueries.length}개에서 우리 브랜드가 등장한 관측 {totalAppearedRuns}건 중, 브랜드를
            설명할 때 반복된 표현을 빈도순으로 모았어요. 완전히 똑같은 글자로만 묶었어서, 뜻은 같은데 표현이 조금
            다르면(예: &quot;협진&quot; · &quot;협진 시스템&quot;) 따로 잡힐 수 있어요.
            {placementFeatureDataRuns < totalAppearedRuns && (
              <>
                {' '}
                ⚠️ 표현 데이터는 {placementFeatureDataRuns}건까지만 집계돼 있어요 — 나머지{' '}
                {totalAppearedRuns - placementFeatureDataRuns}건은 표현이 없어서가 아니라, 그 날짜 집계가 아직
                안 돼 있어서예요.
              </>
            )}
          </p>
          <div className="expr-list">
            {placementFeatureTop10.map((f, i) => (
              <div className="expr-row" key={f.keyword}>
                <p className="en">
                  {i + 1}. {f.keyword}
                </p>
                <span className="ec">
                  {Math.round(f.rate * 100)}% · {f.appearedRuns}회 중 {f.count}회
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {heroSentence && (
        <div className="tip-box">
          <span className="tip-badge">TIP</span>
          <p className="tip-title">AI도 근거를 대는 데는 이유가 있어요.</p>
          <p className="tip-desc">{heroSentence}</p>
          <GapTipsModal />
        </div>
      )}
    </>
  );
}
