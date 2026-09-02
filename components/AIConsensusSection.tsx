/**
 * "AI들이 얼마나 같은 이야기를 하고 있나" 섹션 (Day21).
 * 판단(어떤 후보가 몇 번 칸에 들어가는지, 대립 쌍이 진짜인지)은 전부
 * 데이터 레이어(lib/supabase.ts groupCandidatesByConsensus, lib/brand-one-liner.ts
 * detectAndSaveFeatureConflicts)에서 이미 끝났다 — 이 컴포넌트는 다듬어진
 * 결과를 그대로 그리기만 한다.
 */

export interface ConsensusItem {
  id: string;
  label: string;
  engineTotal: number;
  engineCount: number;
  /** 이 특징을 실제로 언급한 엔진들의 표시용 이름(예: "ChatGPT") — 순서·중복 제거는 호출부가 끝냄. */
  mentionedEngineLabels: string[];
}

export interface ResolvedFeatureConflict {
  id: string;
  summary: string;
  featureA: { label: string; engineLabel: string | null; sourceSentence: string | null };
  featureB: { label: string; engineLabel: string | null; sourceSentence: string | null };
}

function ColumnEmpty({ text }: { text: string }) {
  return <p className="ci-note" style={{ margin: 0 }}>{text}</p>;
}

export function AIConsensusSection({
  allEngineItems,
  someEngineItems,
  totalEngines,
  conflicts,
}: {
  allEngineItems: ConsensusItem[];
  someEngineItems: ConsensusItem[];
  totalEngines: number;
  conflicts: ResolvedFeatureConflict[];
}) {
  return (
    <>
      <h2 className="section-title" style={{ marginBottom: 4, marginTop: 40 }}>
        AI들이 얼마나 같은 이야기를 하고 있나
      </h2>
      <p className="section-sub">
        모든 AI가 공통으로 말하는 것과, 일부만 말하는 것, 서로 다르게 설명하는 지점을 구분했어요.
      </p>

      <div className="consensus-grid">
        <div className="consensus-col">
          <p className="cc-head">
            <i className="ti ti-circles" style={{ color: 'var(--text-success)' }} />
            모든 AI가 공통으로 확인한 정보
          </p>
          <p className="cc-sub">{totalEngines}개 AI 전부가 같은 방향으로 말해요</p>
          {allEngineItems.length === 0 ? (
            <ColumnEmpty text="아직 모든 AI가 공통으로 확인한 특징은 없어요." />
          ) : (
            allEngineItems.map((item) => (
              <div key={item.id} className="consensus-item">
                <p className="ci-name">{item.label}</p>
                <p className="ci-note">{item.engineTotal}개 AI 전체에서 확인, 예외 없음</p>
              </div>
            ))
          )}
        </div>

        <div className="consensus-col">
          <p className="cc-head">
            <i className="ti ti-adjustments" style={{ color: 'var(--text-secondary)' }} />
            일부 AI에서만
          </p>
          <p className="cc-sub">특정 엔진에서만 반복해서 나와요</p>
          {someEngineItems.length === 0 ? (
            <ColumnEmpty text="아직 일부 AI에서만 반복 확인된 특징은 없어요." />
          ) : (
            someEngineItems.map((item) => {
              const notMentioned = item.engineTotal - item.engineCount;
              return (
                <div key={item.id} className="consensus-item">
                  <p className="ci-name">{item.label}</p>
                  <p className="ci-note">
                    {item.mentionedEngineLabels.join(' · ')}에서 확인, 나머지 {notMentioned}개는 언급 없음
                  </p>
                </div>
              );
            })
          )}
        </div>

        <div className="consensus-col conflict">
          <p className="cc-head">
            <i className="ti ti-alert-triangle" />
            서로 다르게 설명하는 지점
          </p>
          <p className="cc-sub">같은 브랜드를 반대되는 인상으로 설명해요</p>
          {conflicts.length === 0 ? (
            <ColumnEmpty text="서로 다르게 설명하는 지점이 없습니다." />
          ) : (
            conflicts.map((c) => (
              <div key={c.id} className="consensus-item">
                <p className="ci-conflict-pair">
                  {c.featureA.engineLabel && <span className="who">{c.featureA.engineLabel} · </span>}
                  <span className="say">
                    &quot;{c.featureA.sourceSentence ?? c.featureA.label}&quot;
                  </span>
                </p>
                <p className="ci-conflict-vs">↕ 상반된 인상</p>
                <p className="ci-conflict-pair">
                  {c.featureB.engineLabel && <span className="who">{c.featureB.engineLabel} · </span>}
                  <span className="say">
                    &quot;{c.featureB.sourceSentence ?? c.featureB.label}&quot;
                  </span>
                </p>
                <p className="ci-note">{c.summary}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
