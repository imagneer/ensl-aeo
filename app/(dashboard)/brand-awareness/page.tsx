import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchLatestBrandOneLiner,
  fetchBrandExpressionsByIds,
  fetchBrandFeatureCandidatesForDiagnosis,
  fetchBrandFeatureConflictsForDiagnosis,
  groupCandidatesByConsensus,
  fetchQuestionEvidenceSummary,
  fetchActiveQueries,
  type EvidenceItem,
  type StoredBrandFeatureCandidate,
  type QuestionEvidenceSummary,
} from '@/lib/supabase';
import { diagnosisDurationDays } from '@/lib/brand-one-liner';
import { kstDayBoundsUtc } from '@/lib/aggregator';
import { BrandOneLinerView } from '@/components/BrandOneLinerView';
import {
  AIConsensusSection,
  type ConsensusItem,
  type ResolvedFeatureConflict,
} from '@/components/AIConsensusSection';
import {
  QuestionEvidenceSection,
  type QuestionEvidenceRow,
} from '@/components/QuestionEvidenceSection';
import { ENGINE_CONFIG, type EngineName } from '@/lib/engine-config';

function engineLabel(engine: string): string {
  return ENGINE_CONFIG[engine as EngineName]?.label ?? engine;
}

export default async function BrandAwarenessPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const { brand: brandId } = await searchParams;

  if (!brandId) {
    return <div className="empty-state"><p className="es-text">먼저 사이드바에서 진단할 브랜드를 선택해주세요.</p></div>;
  }

  const sessionClient = await createServerSupabaseClient();
  const account = await fetchCurrentAccount(sessionClient);

  if (!account) {
    return <div className="empty-state"><p className="es-text">계정 정보를 확인할 수 없습니다. 다시 로그인해주세요.</p></div>;
  }

  const [view, brands, recognitionQuestions] = await Promise.all([
    fetchLatestBrandOneLiner(brandId, account.role, sessionClient),
    fetchTargetBrands(account.id, sessionClient),
    fetchActiveQueries(['인지']),
  ]);

  const brandName = brands.find((b) => b.id === brandId)?.name ?? '이 브랜드';
  const totalQuestions = recognitionQuestions.length;

  // 전체 특징 후보(brand_feature_candidates, v1.2) — 헤드라인에 실제로 쓰인
  // 3개뿐 아니라 tier가 낮아 아직 확정 안 된 것까지 화면에 다 보여준다.
  // '잘못된인지' 행이 가리키는 후보는 일반 목록에서 제외한다.
  const allCandidates: StoredBrandFeatureCandidate[] =
    view.main.state === '완료'
      ? await fetchBrandFeatureCandidatesForDiagnosis(view.main.diagnosis.id, sessionClient)
      : [];
  const conflictCandidateIds = new Set(view.conflicting?.featureCandidateIds ?? []);
  const candidates = allCandidates.filter((c) => !conflictCandidateIds.has(c.id));

  const allEvidenceIds = allCandidates.flatMap((c) => c.evidenceExpressionIds);
  const evidenceRows = await fetchBrandExpressionsByIds(allEvidenceIds, sessionClient);
  const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
  function evidenceFor(ids: string[]): EvidenceItem[] {
    return ids.map((id) => evidenceById.get(id)).filter((e): e is EvidenceItem => !!e);
  }

  const totalDays =
    view.main.state === '완료'
      ? diagnosisDurationDays(
          {
            id: view.main.diagnosis.id,
            brandId,
            startedAt: view.main.diagnosis.startedAt,
            endedAt: view.main.diagnosis.endedAt,
            status: 'completed',
          },
          view.main.diagnosis.endedAt ?? view.main.diagnosis.startedAt
        )
      : 0;
  const totalEngines = view.main.state === '완료' ? view.main.engineList.length : 0;

  // AI 일치도 섹션(Day21) — 1·2번 칸은 candidates(잘못된인지 제외된 목록)를
  // 그대로 재사용해 필터링만 한다(새 쿼리 없음, lib/supabase.ts 주석 참고).
  const consensus = groupCandidatesByConsensus(candidates);
  function toConsensusItem(c: StoredBrandFeatureCandidate): ConsensusItem {
    const mentionedEngineLabels = Array.from(
      new Set(evidenceFor(c.evidenceExpressionIds).map((e) => e.engine))
    ).map(engineLabel);
    return {
      id: c.id,
      label: c.featureName,
      engineTotal: c.engineTotal,
      engineCount: c.engineCount,
      mentionedEngineLabels,
    };
  }
  const allEngineItems = consensus.allEngines.map(toConsensusItem);
  const someEngineItems = consensus.someEngines.map(toConsensusItem);

  // 3번 칸(서로 다르게 설명하는 지점) — brand_feature_conflicts는 후보의
  // id 참조만 갖고 있어서, 위에서 이미 불러온 allCandidates/evidence로 라벨과
  // 대표 근거 문장을 붙여 화면에 바로 그릴 수 있는 형태로 만든다.
  const conflictRows =
    view.main.state === '완료'
      ? await fetchBrandFeatureConflictsForDiagnosis(view.main.diagnosis.id, sessionClient)
      : [];
  const candidateById = new Map(allCandidates.map((c) => [c.id, c]));
  const resolvedConflicts: ResolvedFeatureConflict[] = conflictRows
    .map((row): ResolvedFeatureConflict | null => {
      const a = candidateById.get(row.featureAId);
      const b = candidateById.get(row.featureBId);
      if (!a || !b) return null; // 참조 무결성이 깨진 경우 조용히 스킵(방어적)
      const aEvidence = evidenceFor(a.evidenceExpressionIds)[0] ?? null;
      const bEvidence = evidenceFor(b.evidenceExpressionIds)[0] ?? null;
      return {
        id: row.id,
        summary: row.conflictSummary,
        featureA: {
          label: a.featureName,
          engineLabel: aEvidence ? engineLabel(aEvidence.engine) : null,
          sourceSentence: aEvidence?.sourceSentence ?? null,
        },
        featureB: {
          label: b.featureName,
          engineLabel: bEvidence ? engineLabel(bEvidence.engine) : null,
          sourceSentence: bEvidence?.sourceSentence ?? null,
        },
      };
    })
    .filter((c): c is ResolvedFeatureConflict => !!c);

  // 4번 섹션 "무엇을 근거로 판단했을까?"(Day21) — 새 판단 로직 없이
  // snapshots를 진단 기간(KST) 기준으로 그대로 집계만 한다.
  const questionEvidenceSummaries: QuestionEvidenceSummary[] =
    view.main.state === '완료'
      ? await fetchQuestionEvidenceSummary(
          recognitionQuestions.map((q) => q.id),
          kstDayBoundsUtc(view.main.diagnosis.startedAt).periodStart,
          kstDayBoundsUtc(view.main.diagnosis.endedAt ?? view.main.diagnosis.startedAt).periodEnd
        )
      : [];
  const evidenceSummaryByQueryId = new Map(questionEvidenceSummaries.map((s) => [s.queryId, s]));
  const questionEvidenceRows: QuestionEvidenceRow[] = recognitionQuestions.map((q) => {
    const summary = evidenceSummaryByQueryId.get(q.id);
    return {
      queryId: q.id,
      queryText: q.queryText,
      respondedDays: summary?.respondedDays ?? 0,
      totalDays,
      respondedEngineLabels: (summary?.respondedEngines ?? []).map(engineLabel),
      representative: summary?.representative
        ? {
            engineLabel: engineLabel(summary.representative.engine),
            dateLabel: new Date(summary.representative.executedAt).toLocaleDateString('ko-KR', {
              timeZone: 'Asia/Seoul',
              month: 'long',
              day: 'numeric',
            }),
            excerpt: summary.representative.excerpt,
          }
        : null,
    };
  });

  return (
    <>
      <BrandOneLinerView
        brandName={brandName}
        view={view}
        candidates={candidates}
        totalQuestions={totalQuestions}
        totalDays={totalDays}
        totalEngines={totalEngines}
        evidenceFor={evidenceFor}
      />
      {view.main.state === '완료' && (
        <>
          <AIConsensusSection
            allEngineItems={allEngineItems}
            someEngineItems={someEngineItems}
            totalEngines={totalEngines}
            conflicts={resolvedConflicts}
          />
          <QuestionEvidenceSection rows={questionEvidenceRows} />
        </>
      )}
    </>
  );
}
