import type {
  BrandOneLinerView as BrandOneLinerViewData,
  EvidenceItem,
  SelectedFeatureToSave,
} from '@/lib/supabase';
import { BrandOneLinerFeatureCard } from './BrandOneLinerFeatureCard';
import { HeadlineEvidenceToggle } from './HeadlineEvidenceToggle';

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
  totalQuestions,
  totalDays,
  totalEngines,
  evidenceFor,
}: {
  brandName: string;
  view: BrandOneLinerViewData;
  totalQuestions: number;
  totalDays: number;
  totalEngines: number;
  evidenceFor: (ids: string[]) => EvidenceItem[];
}) {
  const mainFeatures: SelectedFeatureToSave[] =
    view.main.state === '완료' ? view.main.selectedFeatures ?? [] : [];

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

      {view.main.state === '완료' && view.main.status !== '근거부족' && mainFeatures.length > 0 && (
        <>
          <h2 className="section-title">브랜드 한 줄을 만든 특징</h2>
          <p className="section-sub">
            비슷한 표현은 하나로 합쳤어요. 확정 기준(질문 2개·AI 3개·관측 3일 이상)을 넘은 특징만
            보여드려요.
          </p>
          <div className="full-list">
            {mainFeatures.map((f) => (
              <BrandOneLinerFeatureCard
                key={f.feature}
                label={f.feature}
                coverage={f.coverage}
                totalQuestions={totalQuestions}
                totalEngines={totalEngines}
                totalDays={totalDays}
                isRepresentative
                evidence={evidenceFor(f.evidence)}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
