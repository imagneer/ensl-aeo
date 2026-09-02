import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchLatestBrandOneLiner,
  fetchBrandExpressionsByIds,
  fetchBrandFeatureCandidatesForDiagnosis,
  fetchActiveQueries,
  type EvidenceItem,
  type StoredBrandFeatureCandidate,
} from '@/lib/supabase';
import { diagnosisDurationDays } from '@/lib/brand-one-liner';
import { BrandOneLinerView } from '@/components/BrandOneLinerView';

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

  return (
    <BrandOneLinerView
      brandName={brandName}
      view={view}
      candidates={candidates}
      totalQuestions={totalQuestions}
      totalDays={totalDays}
      totalEngines={totalEngines}
      evidenceFor={evidenceFor}
    />
  );
}
