-- Day21 작업지시서 — 브랜드 인지 화면 누락 요소 3가지 (팁 박스)
-- 데이터 기반 인사이트 판정 결과를 4-2 합성 시점에 저장한다.
-- null이면 화면에서 일반 팁 풀 중 랜덤 하나를 쓴다(저장 대상 아님).

alter table brand_one_liners add column tip_content jsonb;

comment on column brand_one_liners.tip_content is
  '데이터 기반 팁 인사이트. {"type":"data","wide_feature":..,"narrow_engine":..,"narrow_feature":..,"total_features":..,"n":..} 또는 {"type":"generic"} 또는 null(둘 다 화면에서 일반 팁 풀 랜덤 사용).';
