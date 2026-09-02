-- 브랜드 한 줄 로직 v1.2 보완 — 스키마 (작업지시서 결정 1~4)
-- v1.1의 brand_one_liners.selected_features(jsonb)를 참조 방식으로 교체.

-- ── 결정 1: 특징 후보 2계층 저장 ──
create table brand_feature_candidates (
  id uuid primary key default gen_random_uuid(),
  diagnosis_id uuid not null references diagnoses(id),
  brand_id uuid not null references brands(id),
  feature_name text not null,
  category text not null check (category in (
    '치료분야','진료체계','의료역량','환자상황','이용편의성','지역_조건','일반적표현'
  )),
  question_count int not null,
  question_total int not null,
  engine_count int not null,
  engine_total int not null,          -- v1.1 ④ 동적 분모(유효 관측 엔진 수)
  day_count int not null,
  day_total int not null,
  passed_min_criteria boolean not null,
  tier text check (tier in ('확정', '가능성있음', '관찰중')),
  intensity_score numeric,            -- 정렬용, 화면 비노출
  evidence_expression_ids uuid[] not null,
  created_at timestamptz not null default now()
);

-- brand_one_liners: jsonb 폐기 → 참조 방식
alter table brand_one_liners drop column selected_features;
alter table brand_one_liners
  add column selected_feature_ids uuid[],       -- brand_feature_candidates.id, 최대 3개, category≠'지역_조건'
  add column location_context_id uuid references brand_feature_candidates(id); -- 결정 3

-- ── RLS + GRANT (Day19/hotfix에서 배운 대로 anon/authenticated/service_role 전부 확인) ──
alter table brand_feature_candidates enable row level security;

grant select on brand_feature_candidates to authenticated;
grant all on brand_feature_candidates to service_role;

create policy "brand_feature_candidates_select_own_account" on brand_feature_candidates
  for select using (
    exists (
      select 1 from brands
      where brands.id = brand_feature_candidates.brand_id
        and is_account_member(brands.account_id)
    )
  );

comment on column brand_feature_candidates.tier is
  '확정=3개 조건(질문2+/AI3+/날짜3+) 전부 충족, 가능성있음=2개 충족, 관찰중=0~1개 충족. 세 조건을 각각 독립 판정 후 합산한 개수 기준(하나만 보고 판단 금지).';
comment on column brand_feature_candidates.category is
  '지역_조건은 selected_feature_ids 풀에서 제외 — location_context_id로 별도 저장(결정 2·3).';

-- ── 확인 ──
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='brand_one_liners' order by ordinal_position;

select table_name,
  has_table_privilege('authenticated', table_name, 'SELECT') as auth_select,
  has_table_privilege('service_role', table_name, 'SELECT') as service_select,
  has_table_privilege('anon', table_name, 'SELECT') as anon_select
from (values ('brand_feature_candidates')) as t(table_name);
