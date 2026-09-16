-- 작업지시서_표현정규화_2026-09-16_V1.2 — "인지와 추천의 서사" 화면 TOP10 비교 정규화
--
-- 오른쪽(추천 표현) 원자 표현 하나하나에 기존 7개 카테고리(brand_feature_candidates.category와
-- 동일 체계)를 붙이고, 같은 카테고리 안에서 왼쪽(소개 특징) 후보와 구체적으로 같은 특징인지
-- 매칭한 결과를 저장한다. 진단 재실행 시 델리트 후 재삽입(brand_feature_candidates와 동일 패턴,
-- lib/supabase.ts deleteBrandOneLinerArtifacts 근처 참고).

create table placement_expression_classifications (
  id uuid primary key default gen_random_uuid(),
  diagnosis_id uuid not null references diagnoses(id),
  brand_id uuid not null references brands(id),

  -- 자리질문 mentions 원문에서 원자 단위로 분해한 표현. 같은 진단 안에서 유일.
  expression text not null,
  occurrence_count int not null,
  -- 비율 표기용 분모(이 진단 기간 자리질문 유효 관측 수) — 화면에서 분모 항상 표시 원칙(매니페스토 3원칙) 때문에 같이 저장.
  appeared_runs int not null,

  -- null = brand_feature_candidates.category와 같은 7개 중 어디에도 안 맞음("기타"로 뭉개지
  -- 말고 별도 기록" — 2026-09-16 루아 지시). 값이 있으면 반드시 이 7개 중 하나.
  category text check (
    category is null or category in ('치료분야','진료체계','의료역량','환자상황','이용편의성','지역_조건','일반적표현')
  ),

  -- 카테고리 안에서 왼쪽 특징 후보와 세부 의미가 같다고 판정된 경우만 채움. 카테고리만 같고
  -- 구체적으로 다른 특징이면 null (2026-09-16 루아 지시: "카테고리 일치만으로 동일 특징 판정 금지").
  matched_feature_id uuid references brand_feature_candidates(id),

  judged_by text not null,   -- 1차 판정 모델
  reviewed_by text,          -- 2차 독립 재판정 모델(reason_stated 패턴과 동일하게 전건 재검수)

  created_at timestamptz not null default now()
);

create index idx_placement_expr_class_diagnosis on placement_expression_classifications(diagnosis_id);
create index idx_placement_expr_class_matched_feature on placement_expression_classifications(matched_feature_id);
-- 미분류(category is null) 표현이 브랜드 단위로 반복되는지 확인할 때 씀(작업지시서 §2, "반복되면 카테고리 보완 검토").
create index idx_placement_expr_class_brand_uncategorized on placement_expression_classifications(brand_id, expression) where category is null;

-- ── RLS + GRANT (day21-brandfeatureconflicts-schema.sql과 동일 패턴) ──
alter table placement_expression_classifications enable row level security;

grant select on placement_expression_classifications to authenticated;
grant all on placement_expression_classifications to service_role;

create policy "placement_expression_classifications_select_own_account" on placement_expression_classifications
  for select using (
    exists (
      select 1 from brands
      where brands.id = placement_expression_classifications.brand_id
        and is_account_member(brands.account_id)
    )
  );

comment on column placement_expression_classifications.category is
  '7개 중 어디에도 안 맞으면 null — 일반적표현으로 뭉개지 않는다(2026-09-16 루아 지시). null이 브랜드별로 반복되면 카테고리 보완 검토 대상.';
comment on column placement_expression_classifications.matched_feature_id is
  '같은 카테고리 안에서도 구체적으로 다른 특징일 수 있어(예: "365일 진료"와 "일요일 진료"는 둘 다 이용편의성이지만 다른 특징), 카테고리 일치와 별개로 판정한다.';

-- ── 확인 ──
select table_name,
  has_table_privilege('authenticated', table_name, 'SELECT') as auth_select,
  has_table_privilege('service_role', table_name, 'SELECT') as service_select,
  has_table_privilege('anon', table_name, 'SELECT') as anon_select
from (values ('placement_expression_classifications')) as t(table_name);
