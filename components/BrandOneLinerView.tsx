import type {
  BrandOneLinerView as BrandOneLinerViewData,
  EvidenceItem,
  StoredBrandFeatureCandidate,
} from '@/lib/supabase';
import { BrandOneLinerFeatureCard } from './BrandOneLinerFeatureCard';
import { HeadlineEvidenceToggle } from './HeadlineEvidenceToggle';

/**
 * tier(v1.2)를 화면 문구·스타일로 바꾸는 판단 — 카드 컴포넌트가 아니라
 * 여기(View)에서 한 번만 한다.
 *
 * ⚠️ "반영됨"류 배지는 tier가 아니라 실제 선정 여부(selectedFeatureIds/
 * locationContextId에 이 후보의 id가 들어있는지)로 판단한다(2026-09-02,
 * 루아 지적으로 수정) — tier='확정'이어도 대표 특징 슬롯(최대 3개, 결정 2)
 * 이나 지역 슬롯(최대 1개)에 못 들어가면 실제로는 한 줄에 안 쓰인 것이라
 * "반영됨"이라고 하면 거짓말이 된다.
 *
 * tier='확정'인데 슬롯 부족으로 못 들어간 경우의 배지 문구는 아직 확정
 * 안 됐다 — 실데이터(9/7~8 첫 진단)로 실제 발생 빈도를 본 뒤 정하기로
 * 하고, 그 전까진 기존 '가능성이 보임' 문구를 임시로 재사용한다(루아
 * 확인, 2026-09-02) — 조건을 다 채웠는데 "가능성"으로 표현돼 과소평가로
 * 보일 수 있다는 걸 알면서도, 새 카피를 실데이터 없이 짓지 않기 위한
 * 의도적 임시 선택이다.
 */
function badgeFor(
  candidate: StoredBrandFeatureCandidate,
  selectedFeatureIds: Set<string>,
  locationContextId: string | null
): {
  text: string;
  cls: 'in-headline' | 'possible' | 'watching';
} {
  const isLocation = candidate.category === '지역_조건';

  if (isLocation && candidate.id === locationContextId) {
    return { text: '지역 정보로 반영됨', cls: 'in-headline' };
  }
  if (!isLocation && selectedFeatureIds.has(candidate.id)) {
    return { text: '반영됨', cls: 'in-headline' };
  }
  // tier='확정'인데 위 두 경우에 안 걸림 = 조건은 채웠지만 슬롯 부족으로
  // 대표 선정은 안 된 경우 — 위 주석 참고, 임시로 '가능성이 보임' 재사용.
  if (candidate.tier === '확정') return { text: '가능성이 보임', cls: 'possible' };
  if (candidate.tier === '가능성있음') return { text: '가능성이 보임', cls: 'possible' };
  return { text: '아직 관찰 중', cls: 'watching' };
}

const TIER_RANK: Record<string, number> = { 확정: 0, 가능성있음: 1, 관찰중: 2 };

function EmptyState({ icon, text, sub }: { icon: string; text: string; sub?: string }) {
  return (
    <div className="empty-state">
      <i className={`ti ${icon} es-icon`} />
      <p className="es-text">{text}</p>
      {sub && <p className="es-sub">{sub}</p>}
    </div>
  );
}

/**
 * 브랜드 인지 화면의 실제 렌더링 본체 (Day 20). app/(dashboard)/brand-awareness/page.tsx가
 * 실데이터로, app/dev-preview/brand-awareness/page.tsx가 mock 데이터로 이 컴포넌트를
 * 그대로 재사용한다 — 같은 데이터/렌더링 로직을 여러 진입점이 공유하는 구조
 * (2026-08-31 합의된 "화면/데이터 분리" 원칙).
 */
export function BrandOneLinerView({
  brandName,
  view,
  candidates,
  totalQuestions,
  totalDays,
  totalEngines,
  evidenceFor,
}: {
  brandName: string;
  view: BrandOneLinerViewData;
  /** brand_feature_candidates 전체 목록(v1.2) — '잘못된인지'가 가리키는
   *  후보는 호출부(page.tsx)가 이미 걸러서 준다. */
  candidates: StoredBrandFeatureCandidate[];
  totalQuestions: number;
  totalDays: number;
  totalEngines: number;
  evidenceFor: (ids: string[]) => EvidenceItem[];
}) {
  const sortedCandidates = [...candidates].sort(
    (a, b) => (TIER_RANK[a.tier ?? '관찰중'] ?? 2) - (TIER_RANK[b.tier ?? '관찰중'] ?? 2)
  );
  const selectedFeatureIdSet = new Set(
    view.main.state === '완료' ? view.main.selectedFeatureIds : []
  );
  const locationContextId = view.main.state === '완료' ? view.main.locationContextId : null;

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">브랜드 한 줄</p>
          <h1 className="page-title">AI는 {brandName}를 어떻게 인지하고 있나</h1>
        </div>
      </div>

      {totalQuestions > 0 && (
        <div className="meta-row">
          <span>
            <i className="ti ti-help-circle" />
            인지 질문 {totalQuestions}개
          </span>
        </div>
      )}

      {/* 잘못된 인지 — 본문 상태와 별개로, 검토·role 조건을 통과했으면 항상 노출 */}
      {view.conflicting && (
        <div className="conflict-box">
          <p className="cb-head">
            <i className="ti ti-alert-triangle" />
            잘못된 인지
          </p>
          <p className="cb-sentence">{view.conflicting.oneLiner}</p>
        </div>
      )}

      {view.main.state === '진단중' && (
        <EmptyState
          icon="ti-loader-2"
          text="AI가 아직 관측 중이에요."
          sub={`인지 질문 관측 ${view.main.daysElapsed ?? '?'}일째 (최소 3일 필요)`}
        />
      )}

      {view.main.state === '완료' && view.main.status === '근거부족' && (
        <EmptyState icon="ti-search-off" text="아직 반복 확인된 브랜드 한 줄을 만들기 어려워요." />
      )}

      {/* 반복확인·초기한줄 둘 다 one_liner를 그대로 표시만 한다 — 문장 조합
          판단은 데이터 레이어(lib/brand-one-liner.ts)에서 이미 끝났고,
          여기서는 status에 따라 배지·강조 정도(매니페스토 4번 원칙)만
          다르게 한다. */}
      {view.main.state === '완료' && (view.main.status === '반복확인' || view.main.status === '초기한줄') && (
        <div className="headline-card">
          <i className="ti ti-quote quote-icon" />
          <p className="sub-label">
            {view.main.status === '반복확인'
              ? 'AI가 기억하는 우리 브랜드의 한 줄'
              : '지금까지 AI가 가장 강하게 연결한 특징'}
          </p>
          <p className="headline-sentence">
            {view.main.status === '반복확인' ? `"${view.main.oneLiner}"` : view.main.oneLiner}
          </p>
          <div className="badge-row">
            {view.main.status === '반복확인' ? (
              <span className="conf-badge confirmed">
                <i className="ti ti-check" />
                반복 확인됨
              </span>
            ) : (
              <span className="conf-badge possible">
                <i className="ti ti-hourglass-low" />
                아직 확정 아님
              </span>
            )}
            {!view.main.reviewed && (
              <span className="conf-badge pending">
                <i className="ti ti-eye" />
                검토 대기
              </span>
            )}
            {view.main.status === '반복확인' && (
              <HeadlineEvidenceToggle>
                <p className="note" style={{ margin: '0 0 10px' }}>
                  서로 다른 인지 질문 2개, AI 3개, 3일 이상에서 반복되면 확정해요.
                </p>
                <p className="panel-title">지금 진단은 확정 기준과 비교하면</p>
                <div className="criteria-grid">
                  <div className="criteria-cell">
                    <p className="k">인지 질문</p>
                    <p className="v">
                      {totalQuestions} / {totalQuestions}개
                    </p>
                    <p className="t">기준 2개 이상</p>
                  </div>
                  <div className="criteria-cell">
                    <p className="k">AI 엔진</p>
                    <p className="v">{totalEngines}개 (유효 관측)</p>
                    <p className="t">기준 3개 이상</p>
                  </div>
                  <div className="criteria-cell">
                    <p className="k">관측 일수</p>
                    <p className="v">{totalDays}일</p>
                    <p className="t">기준 3일 이상</p>
                  </div>
                </div>
                <p className="note">각 특징은 아래 특징 목록에서 실제 관측 수를 하나씩 확인할 수 있어요.</p>
              </HeadlineEvidenceToggle>
            )}
          </div>
        </div>
      )}

      {view.main.state === '완료' && sortedCandidates.length > 0 && (
        <>
          <h2 className="section-title">브랜드 한 줄을 만든 특징</h2>
          <p className="section-sub">
            비슷한 표현은 하나로 합쳤어요. 서로 다른 인지 질문 2개·AI 3개·관측 3일 이상 반복되면
            &quot;반영됨&quot;으로 확정해요 — 아직 못 미친 것도 신호가 보이는 만큼 같이 보여드려요.
          </p>
          <div className="full-list">
            {sortedCandidates.map((c) => {
              const badge = badgeFor(c, selectedFeatureIdSet, locationContextId);
              return (
                <BrandOneLinerFeatureCard
                  key={c.id}
                  label={c.featureName}
                  coverage={{ questions: c.questionCount, engines: c.engineCount, days: c.dayCount }}
                  totalQuestions={c.questionTotal}
                  totalEngines={c.engineTotal}
                  totalDays={c.dayTotal}
                  badgeText={badge.text}
                  badgeClass={badge.cls}
                  evidence={evidenceFor(c.evidenceExpressionIds)}
                />
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
