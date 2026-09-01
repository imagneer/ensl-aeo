import {
  createServerSupabaseClient,
  fetchCurrentAccount,
  fetchTargetBrands,
  fetchLatestBrandOneLiner,
  fetchBrandExpressionsByIds,
  fetchActiveQueries,
  type EvidenceItem,
  type SelectedFeatureToSave,
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

  // 헤드라인 특징 + 잘못된 인지 특징의 근거를 한 번에 미리 조회
  const mainFeatures: SelectedFeatureToSave[] =
    view.main.state === '완료' ? view.main.selectedFeatures ?? [] : [];
  const conflictFeatures: SelectedFeatureToSave[] = view.conflicting?.selectedFeatures ?? [];
  const allEvidenceIds = [...mainFeatures, ...conflictFeatures].flatMap((f) => f.evidence);
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
      totalQuestions={totalQuestions}
      totalDays={totalDays}
      totalEngines={totalEngines}
      evidenceFor={evidenceFor}
    />
  );
}
