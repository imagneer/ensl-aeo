-- Day22 작업지시서 — "인지와 위치의 간극" 화면, 자리질문 역할판정 신규 테이블
-- 작업지시서: Day22_작업지시서_간극화면.md §2
--
-- role이 없는 조합(=행 자체가 없음)은 "브랜드 등장·특징 없음"으로 자연스럽게
-- 유추된다 — 별도 상태값을 안 만드는 이유는 작업지시서 §2 그대로.

create table mention_feature_roles (
  id uuid primary key default gen_random_uuid(),
  mention_id uuid references mentions(id) not null,
  feature_text text not null,
  role text not null check (role in ('reason_stated', 'co_mentioned')),
  judged_by text not null,       -- 판정에 쓴 모델명
  reviewed boolean not null default false,
  reviewed_by text,              -- 검수에 쓴 모델명 (judged_by와 달라야 함)
  created_at timestamptz not null default now()
);

comment on column mention_feature_roles.role is
  '텍스트 구조 기반 판정(작업지시서 §1-2) — "AI 내부 선택 이유"가 아니라 "답변 문장 안에서 인과·근거 연결 표현으로 묶여 있는지"만 본다. 애매하면 반드시 co_mentioned로 낮춘다.';
comment on column mention_feature_roles.reviewed is
  '판정(judged_by)과 검수(reviewed_by)를 분리한다(작업지시서 §1-3, "자기 판정을 자기가 승인하지 않게"). false인 행은 화면에 노출하지 않는다.';
comment on column mention_feature_roles.judged_by is
  '판정 호출에 쓴 모델명. reviewed_by와 값이 같으면 안 된다(자기검수 방지 — 애플리케이션 단에서 강제, DB 제약은 아님).';

-- ── RLS + GRANT (Day19 패턴 그대로) ──
-- mentions.brand_id가 null일 수 있어서(경쟁사 멘션 등) mentions 자체의
-- RLS 정책처럼 mention_id → snapshot_id → queries → brands로 타고 올라간다.
alter table mention_feature_roles enable row level security;

grant select on mention_feature_roles to authenticated;
grant all on mention_feature_roles to service_role;

create policy "mention_feature_roles_select_own_account" on mention_feature_roles
  for select using (
    exists (
      select 1 from mentions
      join snapshots on snapshots.id = mentions.snapshot_id
      join queries on queries.id = snapshots.query_id
      join brands on brands.id = queries.brand_id
      where mentions.id = mention_feature_roles.mention_id
        and is_account_member(brands.account_id)
    )
  );

-- ── 확인 ──
select table_name,
  has_table_privilege('authenticated', table_name, 'SELECT') as auth_select,
  has_table_privilege('service_role', table_name, 'SELECT') as service_select,
  has_table_privilege('anon', table_name, 'SELECT') as anon_select
from (values ('mention_feature_roles')) as t(table_name);
