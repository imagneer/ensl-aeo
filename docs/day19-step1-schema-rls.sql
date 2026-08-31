-- Day 19 — 1단계: 멀티테넌시 스키마 + RLS
-- 실행 시점: 지금 (작업지시서 6번 순서 그대로 진행하기로 결정, 2026-08-31)
-- 실행 방법: Supabase 대시보드 → SQL Editor에 그대로 붙여넣고 실행
--
-- ⚠️ 이 SQL을 실행하는 순간, anon 키로 brands/queries를 읽는 곳(기존
-- 홈페이지 `/`, 그리고 로그인 연동 전까지의 (dashboard) 사이드바)은
-- auth.uid()가 없어서 즉시 빈 결과를 받게 된다. `/`는 계속 이 상태로
-- 두기로 했고(2026-08-31 확인), (dashboard)는 Day19 코드 배포 +
-- 실제 로그인(3번)까지 끝나야 정상화된다.

-- ── 1. 신규 테이블 ──

create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table account_members (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  status text not null default 'active' check (status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  unique (account_id, user_id)
);

-- ── 2. brands 변경 (기존 데이터 있음 — nullable로 추가, 백필은 4단계에서) ──

alter table brands add column account_id uuid references accounts(id);

-- ── 3. RLS 헬퍼 함수 ──
-- ⚠️ account_members 자체의 정책에는 이 함수를 쓰지 않는다 (순환 참조).
-- 자세한 이유는 Day19 작업지시서 5번 참고.

create or replace function public.is_account_member(target_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from account_members
    where account_id = target_account_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$;

-- ── 4. RLS 활성화 ──

alter table accounts enable row level security;
alter table account_members enable row level security;
alter table brands enable row level security;
alter table queries enable row level security;
alter table snapshots enable row level security;
alter table mentions enable row level security;
alter table aggregated_metrics enable row level security;
alter table alerts enable row level security;

-- ── 5. RLS 정책 (전부 select만 — 쓰기 권한 차등은 다음 단계) ──

create policy "accounts_select_own" on accounts
  for select using (is_account_member(id));

-- account_members 자체는 순환 참조 피하려고 auth.uid() 직접 비교 (함수 안 씀)
create policy "account_members_select_own" on account_members
  for select using (user_id = auth.uid());

create policy "brands_select_own_account" on brands
  for select using (is_account_member(account_id));

create policy "queries_select_own_account" on queries
  for select using (
    exists (
      select 1 from brands
      where brands.id = queries.brand_id
        and is_account_member(brands.account_id)
    )
  );

-- snapshots는 brand_id가 없고 query_id만 있어서 queries를 한 번 더 거쳐간다.
create policy "snapshots_select_own_account" on snapshots
  for select using (
    exists (
      select 1 from queries
      join brands on brands.id = queries.brand_id
      where queries.id = snapshots.query_id
        and is_account_member(brands.account_id)
    )
  );

-- mentions.brand_id는 null일 수 있어서(경쟁사 멘션 등) brand_id로 직접
-- 거르지 않고 snapshot_id → queries → brands로 타고 올라간다.
create policy "mentions_select_own_account" on mentions
  for select using (
    exists (
      select 1 from snapshots
      join queries on queries.id = snapshots.query_id
      join brands on brands.id = queries.brand_id
      where snapshots.id = mentions.snapshot_id
        and is_account_member(brands.account_id)
    )
  );

-- aggregated_metrics, alerts는 brand_id를 직접 갖고 있어서(Day9/Day13
-- 설계) brands만 한 번 거치면 된다.
create policy "aggregated_metrics_select_own_account" on aggregated_metrics
  for select using (
    exists (
      select 1 from brands
      where brands.id = aggregated_metrics.brand_id
        and is_account_member(brands.account_id)
    )
  );

create policy "alerts_select_own_account" on alerts
  for select using (
    exists (
      select 1 from brands
      where brands.id = alerts.brand_id
        and is_account_member(brands.account_id)
    )
  );
