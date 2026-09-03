import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchActiveQueries,
  fetchLatestDiagnosis,
  fetchKnownBrands,
  fetchQuerySnapshotsWithMentionsBatch,
  fetchAggregatedKeywordRowsForQueries,
  type AggregatedKeywordRow,
} from '@/lib/supabase';
import { kstDayBoundsUtc, todayKST } from '@/lib/aggregator';
import {
  buildQueryPositionStats,
  selectHeroQuery,
  selectWorstQuery,
  buildTipDescription,
  sortForQuestionList,
  type QueryPositionStats,
} from '@/lib/brand-position';
import { MIN_RUNS_FOR_JUDGMENT, EXPOSURE_BADGE_LABEL } from '@/lib/badge-thresholds';
import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';
import { PositionTipsModal } from '@/components/PositionTipsModal';

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

/**
 * "이 자리/질문에서 함께·대신 등장한 브랜드" + 해석 문장 + 실제 근거.
 * 히어로와 나머지 질문 목록(펼친 상태)이 내용은 같지만 프로토타입에서
 * 문구·분량이 다르다(원본: docs/prototypes/ensl_brand_position.html) —
 * 히어로는 "이 자리에서", 질문 한 줄은 "이 질문에서"라고 쓰고, 해석
 * 문장("이 자리에서 브랜드들이 기억되는 방식")은 히어로에만 있다. 개별
 * 질문 캡션에는 프롬프트 한계 고지 문구를 안 붙인다(히어로에서 이미
 * 한 번 봤으니 반복 안 함) — 판단 로직은 그대로, variant로 문구만 바꾼다.
 */
function CompetitionSection({
  stats,
  brandIdParam,
  variant,
}: {
  stats: QueryPositionStats;
  brandIdParam: string;
  variant: 'hero' | 'row';
}) {
  const isNone = stats.badge === 'none';
  const rowsToShow = isNone
    ? stats.competitorRows.filter((r) => !r.isTarget).slice(0, 1)
    : stats.competitorRows;

  const place = variant === 'hero' ? '자리' : '질문';
  const title = isNone ? `이 ${place}에서 대신 등장한 브랜드` : `이 ${place}에서 함께 등장한 브랜드`;

  const evidenceBox = stats.representativeSnapshot && (
    <div className="evidence-box">
      <p className="src">
        실제 근거 · {engineLabel(stats.representativeSnapshot.engine)} ·{' '}
        {dateLabel(stats.representativeSnapshot.executedAt)}
      </p>
      <p className="quote">&quot;{stats.representativeSnapshot.excerpt}&quot;</p>
      <a className="expand-btn evidence-cta" href={`/query/${stats.queryId}?brand=${brandIdParam}`}>
        전체 답변과 출처 보기 ↗
      </a>
    </div>
  );

  return (
    <div className="competition">
      <p className="title">{title}</p>
      {variant === 'hero' ? (
        <p className="caption">
          AI가 함께 언급한 특징 ·{' '}
          <em>AI가 실제로 쓴 표현이에요 · 짧은 핵심어로 다듬는 작업은 진행 중이라, 문장 그대로 나올 수 있어요</em>
        </p>
      ) : (
        <p className="cap">AI가 함께 언급한 특징</p>
      )}
      {rowsToShow.length === 0 ? (
        <p className="es-text" style={{ marginBottom: 20 }}>
          아직 확인된 브랜드가 없어요.
        </p>
      ) : (
        <div className={variant === 'hero' ? 'brand-list' : 'brand-list-sm'}>
          {rowsToShow.map((r) => {
            const feature = r.isTarget
              ? stats.targetTopKeywords[0]?.keyword
              : stats.topCompetitor?.name === r.name
                ? stats.topCompetitor.topKeywords[0]?.keyword
                : undefined;
            return (
              <div className="brand-row" key={r.key}>
                <div>
                  <p className="nm">
                    {r.name} {r.isTarget && <span className="ours">(우리)</span>}
                  </p>
                  {feature && <p className="ft">{feature}</p>}
                </div>
                <p className={`pc${r.isTarget ? '' : ' sec'}`}>{Math.round(r.rate * 100)}%</p>
              </div>
            );
          })}
        </div>
      )}
      {/* 해석 문장은 히어로에만 — 프로토타입 원본도 개별 질문 줄엔 없다. */}
      {variant === 'hero' && stats.interpretation && (
        <div className="interpretation">
          <p className="k">이 자리에서 브랜드들이 기억되는 방식</p>
          <p className="v">{stats.interpretation}</p>
        </div>
      )}
      {evidenceBox &&
        (variant === 'hero' ? (
          <details style={{ marginTop: 14 }}>
            <summary className="evidence-toggle">이 자리의 실제 근거 보기 →</summary>
            <div style={{ marginTop: 12 }}>{evidenceBox}</div>
          </details>
        ) : (
          evidenceBox
        ))}
    </div>
  );
}

export default async function BrandPositionPage({
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

  const [brands, positionQueries, diagnosis, knownBrands] = await Promise.all([
    fetchTargetBrands(account.id, sessionClient),
    fetchActiveQueries(['자리']),
    fetchLatestDiagnosis(brandId, sessionClient),
    fetchKnownBrands(),
  ]);

  const brandName = brands.find((b) => b.id === brandId)?.name ?? '이 브랜드';

  if (!diagnosis) {
    return (
      <div className="empty-state">
        <p className="es-text">이 브랜드의 진단 데이터가 아직 없어요.</p>
      </div>
    );
  }

  if (positionQueries.length === 0) {
    return (
      <div className="empty-state">
        <p className="es-text">아직 등록된 자리 질문이 없어요.</p>
      </div>
    );
  }

  const periodEndDate = diagnosis.endedAt ?? todayKST();
  const periodStart = kstDayBoundsUtc(diagnosis.startedAt).periodStart;
  const periodEnd = kstDayBoundsUtc(periodEndDate).periodEnd;

  // 헤더 3번째 메타 항목("N일 관측 완료"/"N일차 관측 중") — 상단바
  // (DashboardTopbar/dashboard-status)와 같은 공식(시작일부터 경과일,
  // 최대 7일)으로 계산한다. 화면마다 다른 공식을 쓰면 같은 진단을 두고
  // 숫자가 어긋나는 정합성 문제가 생기기 때문(CLAUDE.md 알려진 이슈 2번)
  // — app/api/dashboard-status/route.ts의 dayCount 계산과 반드시 맞출 것.
  const diagnosisStart = new Date(`${diagnosis.startedAt}T00:00:00Z`);
  const todayForCount = new Date(`${todayKST()}T00:00:00Z`);
  const daysElapsed =
    Math.round((todayForCount.getTime() - diagnosisStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dayCount = Math.min(Math.max(daysElapsed, 1), 7);
  const observationLabel = diagnosis.status === 'completed' ? '7일 관측 완료' : `${dayCount}일차 관측 중`;

  const queryIds = positionQueries.map((q) => q.id);
  const [recordsByQuery, keywordRows] = await Promise.all([
    fetchQuerySnapshotsWithMentionsBatch(queryIds, periodStart, periodEnd, sessionClient),
    fetchAggregatedKeywordRowsForQueries(queryIds, periodStart, periodEnd),
  ]);

  const brandNameById = new Map(knownBrands.map((b) => [b.brandId, b.name]));
  const knownBrandIdByName = new Map(knownBrands.map((b) => [b.name, b.brandId]));

  const keywordRowsByQuery = new Map<string, AggregatedKeywordRow[]>();
  for (const row of keywordRows) {
    if (!keywordRowsByQuery.has(row.queryId)) keywordRowsByQuery.set(row.queryId, []);
    keywordRowsByQuery.get(row.queryId)!.push(row);
  }

  const stats: QueryPositionStats[] = positionQueries.map((q) =>
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

  const hero = selectHeroQuery(stats);
  const rest = sortForQuestionList(stats.filter((s) => s.queryId !== hero?.queryId));

  // 팁 박스 설명 — 히어로/워스트 둘 다 있어야 대비 문장을 만들 수 있다.
  // 진단 극초반(히어로 없음)이거나 판단 가능한 질문이 1개뿐이면(워스트
  // 없음) 일반적인 안내 문장으로 대체한다 — 없는 대비를 지어내지 않는다.
  const worst = hero ? selectWorstQuery(stats, hero.queryId) : null;
  const tipDescription =
    hero && worst
      ? buildTipDescription(brandName, hero, worst)
      : '자리 질문마다 등장 여부와 등장률이 달라질 수 있어요. 여러 질문을 함께 관찰하면 브랜드의 강점과 빈자리를 더 정확히 파악할 수 있어요.';

  return (
    <>
      <p className="eyebrow">브랜드 현 위치</p>
      <h1 className="page-title">우리 브랜드는 어떤 자리 질문에서 등장하고 있나?</h1>
      <p className="meta-row">
        <span>
          <i className="ti ti-robot" />
          AI 6개
        </span>
        <span>
          <i className="ti ti-target-arrow" />
          자리 질문 {positionQueries.length}개
        </span>
        <span>
          <i className="ti ti-circle-check" />
          {observationLabel}
        </span>
      </p>

      {hero ? (
        <div className="hero">
          <p className="sub-label">가장 강하게 등장한 자리 질문</p>
          <p className="question">&quot;{hero.queryText}&quot;</p>
          <span className="rate-badge">
            등장률 {Math.round(hero.visibilityRate * 100)}% · {hero.totalRuns}회 중 {hero.appearedRuns}회 등장
          </span>
          <CompetitionSection stats={hero} brandIdParam={brandId} variant="hero" />
        </div>
      ) : (
        <div className="empty-state">
          <p className="es-text">아직 데이터가 충분히 쌓이지 않았어요.</p>
          <p className="es-sub">
            각 질문이 최소 {MIN_RUNS_FOR_JUDGMENT}회 관측되면 등장 여부를 판단해서 보여드려요.
          </p>
        </div>
      )}

      <h2 className="section-title">{hero ? '나머지 자리 질문' : '전체 자리 질문'}</h2>
      <p className="section-sub">
        {hero
          ? `가장 강한 질문 하나는 위에서 먼저 보여드렸어요. 나머지 ${rest.length}개 질문을 등장률 높은 순으로 정리했어요.`
          : '등장률이 높은 순으로 정리했어요.'}
      </p>

      <div className="qlist">
        {rest.map((s) => (
          <details className="qitem" key={s.queryId}>
            <summary className="qhead">
              <div style={{ flex: 1, minWidth: 0 }}>
                <p className="qtext">{s.queryText}</p>
                <span className={`badge ${s.badge}`}>{EXPOSURE_BADGE_LABEL[s.badge]}</span>
              </div>
              <div className="row-tail">
                <div className="stat-col">
                  {s.badge === 'insufficient' ? (
                    <>
                      <p className="pct muted">—</p>
                      <p className="frac">{s.totalRuns}회 중 기준 미달</p>
                    </>
                  ) : (
                    <>
                      <p className="pct">{Math.round(s.visibilityRate * 100)}%</p>
                      <p className="frac">
                        {s.totalRuns}회 중 {s.appearedRuns}회
                      </p>
                    </>
                  )}
                </div>
                <span className="chev">▾</span>
              </div>
            </summary>
            <div className="qdetail">
              {s.badge === 'insufficient' ? (
                <p className="note">
                  이 질문은 아직 관측이 부족해서 판단하기 일러요. 최소 {MIN_RUNS_FOR_JUDGMENT}회가 쌓이면 다른
                  질문처럼 상태가 표시돼요.
                </p>
              ) : (
                <CompetitionSection stats={s} brandIdParam={brandId} variant="row" />
              )}
            </div>
          </details>
        ))}
      </div>

      <div className="tip-box">
        <span className="tip-badge">TIP</span>
        <p className="tip-title">질문이 달라지면, 자리도 달라져요.</p>
        <p className="tip-desc">{tipDescription}</p>
        <PositionTipsModal />
      </div>
    </>
  );
}
