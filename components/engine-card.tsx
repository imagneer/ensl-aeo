import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EngineName, ENGINE_CONFIG } from "@/lib/engine-config";
import { DashboardMetric } from "@/lib/supabase";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function MSCBadge({
  label,
  state,
  nullReason = "확인 불가",
}: {
  label: string;
  state: boolean | null;
  nullReason?: string;
}) {
  if (state === null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="bg-muted text-xs font-mono w-6 justify-center text-muted-foreground border-dashed cursor-help"
          >
          ?
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs max-w-[220px]">{nullReason}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Badge
      variant={state ? "default" : "outline"}
      className={`text-xs font-mono w-6 justify-center ${
        state ? "" : "text-muted-foreground/40"
      }`}
    >
      {label}
    </Badge>
  );
}

export function EngineCard({
  engine,
  metric,
}: {
  engine: EngineName;
  metric: DashboardMetric | undefined;
}) {
  const label = ENGINE_CONFIG[engine].label;

    if (!metric || metric.totalRuns === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{label}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">아직 관측 없음</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        {metric.avgRank !== null && (
          <Badge variant="secondary">{metric.avgRank.toFixed(1)}번째</Badge>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex gap-1 mb-2">
          <MSCBadge label="M" state={metric.mentionCount > 0} />
          <MSCBadge label="S" state={metric.hasSource} nullReason="이 엔진은 참고 자료 목록을 공개하지 않아 확인이 불가능합니다" />
          <MSCBadge label="C" state={metric.hasCitation} nullReason="예전 방식으로 저장된 데이터라 인용 여부가 계산되지 않았습니다" />
        </div>
        <div className="text-2xl font-semibold">
          {metric.visibilityRate !== null
            ? `${Math.round(metric.visibilityRate * 100)}%`
            : "—"}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          노출률 · {metric.mentionCount}/{metric.totalRuns}회 언급
        </p>
        {metric.avgRank !== null && (
          <p className="text-xs text-muted-foreground">
            답변 등장 순서 평균 {metric.avgRank.toFixed(1)}번째
          </p>
        )}
        <div className="flex gap-1 mt-2 flex-wrap">
          {metric.topKeywords && metric.topKeywords.length > 0 ? (


            metric.topKeywords.map((kw, i) => (
            <Badge key={i} variant="outline" className="text-xs font-normal">
            {kw.keyword}
            <span className="ml-1 text-muted-foreground">{kw.count}</span>
            </Badge>
            ))

          ) : (
            <span className="text-xs text-muted-foreground">
              {metric.mentionCount === 0 ? "언급 없음" : "추출된 표현 없음"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}