import { fetchTargetBrands } from "@/lib/supabase";

export async function Header() {
  const brands = await fetchTargetBrands();

  return (
    <header className="flex items-center gap-3 border-b px-4 py-2.5">
      <span className="text-sm font-medium">ensl</span>
      <span className="text-sm text-muted-foreground">|</span>
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        브랜드 시그널 레이더
      </span>

      <div className="ml-auto">
        {brands.length > 0 ? (
          <select className="h-9 rounded-md border bg-background px-3 text-sm">
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-muted-foreground">
            등록된 브랜드 없음
          </span>
        )}
      </div>
    </header>
  );
}