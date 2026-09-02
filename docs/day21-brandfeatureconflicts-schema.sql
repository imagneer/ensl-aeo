-- Day21 작업지시서 — "AI들이 얼마나 같은 이야기를 하고 있나" 3번 칸
-- brand_feature_candidates(v1.2)에 이미 있는 tier/engine_count 조합으로
-- 1·2번 칸(공통/일부)은 새 테이블 없이 처리한다(코드 쪽 groupCandidatesByConsensus
-- 참고). 3번 칸(서로 다르게 설명하는 지점)만 신규 테이블이 필요하다.

create table brand_feature_conflicts (
  id uuid primary key default gen_random_uuid(),
  diagnosis_id uuid not null references diagnoses(id),
  brand_id uuid not null references brands(id),
  feature_a_id uuid not null references brand_feature_candidates(id),
  feature_b_id uuid not null references brand_feature_candidates(id),
  conflict_summary text not null,
  created_at timestamptz not null default now()
);

-- ── RLS + GRANT (Day19/hotfix에서 배운 대로 anon/authenticated/service_role 전부 확인) ──
alter table brand_feature_conflicts enable row level security;

grant select on brand_feature_conflicts to authenticated;
grant all on brand_feature_conflicts to service_role;

create policy "brand_feature_conflicts_select_own_account" on brand_feature_conflicts
  for select using (
    exists (
      select 1 from brands
      where brands.id = brand_feature_conflicts.brand_id
        and is_account_member(brands.account_id)
    )
  );

comment on column brand_feature_conflicts.conflict_summary is
  '화면에 그대로 노출되는 문구 — "모순"/"오류" 등 부정적 단정 표현 금지(작업지시서 3-4). LLM 자동검수(reviewFeatureConflicts)를 통과한 것만 저장됨.';

-- ── 확인 ──
select table_name,
  has_table_privilege('authenticated', table_name, 'SELECT') as auth_select,
  has_table_privilege('service_role', table_name, 'SELECT') as service_select,
  has_table_privilege('anon', table_name, 'SELECT') as anon_select
from (values ('brand_feature_conflicts')) as t(table_name);
