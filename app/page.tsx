import { ENGINE_NAMES, EngineName } from "@/lib/engine-config";
import { EngineCard } from "@/components/engine-card";
import {
  fetchActiveQueries,
  fetchTargetBrands,
  fetchLatestDashboardMetrics,
} from "@/lib/supabase";

export const dynamic = 'force-dynamic';   // ← 여기

export default async function Home() {
  const brands = await fetchTargetBrands();

  if (brands.length === 0) {
    return (
      <main className="p-6">
        <p className="text-sm text-muted-foreground">등록된 브랜드가 없습니다.</p>
      </main>
    );
  }

  const brandId = brands[0].id;
  const [queries, metrics] = await Promise.all([
    fetchActiveQueries(),
    fetchLatestDashboardMetrics(brandId),
  ]);

  const brandQueries = queries.filter((q) => q.brandId === brandId);
  const periodStart = metrics[0]?.periodStart ?? null;

  return (
    <main className="p-6 space-y-8">
      {periodStart ? (
        <p className="text-sm text-muted-foreground">
          {new Date(periodStart).toLocaleDateString("ko-KR", {
            timeZone: "Asia/Seoul",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}{" "}
          하루치 · 아침·점심·저녁 3회 관측 통합          
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">아직 집계된 데이터가 없습니다.</p>
      )}
 <p className="text-xs text-muted-foreground/70">
        M(멘션)·S(소스)·C(인용) — 엔진마다 제공하는 정보가 달라요. ChatGPT는 참고 출처
        목록을 공개하지 않아 S 항목이 &quot;?&quot;(확인 불가)로 표시됩니다.
      </p>

      {brandQueries.map((query) => (
        <section key={query.id} className="space-y-3">
          <h2 className="text-base font-medium">{query.queryText}</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {ENGINE_NAMES.map((engine: EngineName) => (
              <EngineCard
                key={engine}
                engine={engine}
                metric={metrics.find(
                  (m) => m.queryId === query.id && m.engine === engine
                )}
              />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}