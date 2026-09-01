-- 브랜드 한 줄 생성 로직 v1.1 — 스키마 (작업지시서_브랜드한줄로직_v1.1.md 3번)
-- 실행 순서: diagnoses가 나머지 전부의 전제라 반드시 먼저.

-- ── 1. 진단 회차 (v1.1 ①) ──
create table diagnoses (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id),
  started_at date not null,
  ended_at date, -- 진행 중이면 null
  status text not null default 'collecting' check (status in ('collecting', 'completed')),
  created_at timestamptz not null default now()
);

-- 365서울원탑치과 1행 시딩. started_at = 오늘(이원화 수집 구조 배포 다음 날,
-- 실제로 12개 쿼리 전체가 도는 첫 09시 배치가 여기서부터 시작됨).
insert into diagnoses (brand_id, started_at, status)
values ('a2498cc7-9068-41c5-ad04-43aa2f6e2d3d', '2026-09-01', 'collecting');

-- ── 2. 추출된 개별 표현 (원안 2번) ──
create table brand_expressions (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references snapshots(id),
  query_id uuid not null references queries(id),
  brand_id uuid not null references brands(id),
  engine text not null,
  observed_date date not null,
  expression text not null,        -- AI가 사용한 원래 표현
  source_sentence text not null,   -- 표현이 포함된 실제 문장
  sentiment text check (sentiment in ('긍정', '중립', '부정')),
  is_induced boolean not null default false,
  conflicts_with_brand_facts boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── 3. 생성된 브랜드 한 줄 (원안 13번) ──
create table brand_one_liners (
  id uuid primary key default gen_random_uuid(),
  diagnosis_id uuid not null references diagnoses(id),
  brand_id uuid not null references brands(id),
  status text not null check (status in ('반복확인', '초기한줄', '근거부족', '잘못된인지')),
  one_liner text,                  -- 근거부족이면 null
  selected_features jsonb,         -- [{feature, coverage:{questions,engines,days}, evidence:[expression_ids]}]
  question_ids uuid[] not null,
  engine_list text[] not null,     -- 실제 유효 관측 있었던 엔진 목록 (④ 분모 정의용)
  logic_version text not null default 'v1.1',
  generated_at timestamptz not null default now(),
  reviewed_by_human boolean not null default false,
  reviewer_note text
);

-- ── 4. 브랜드 사실 정보 (원안 2번 충돌판정용, ⑦) ──
alter table brands add column brand_facts text; -- 없으면 충돌판정 건너뜀

-- ── RLS: 기존 테이블들과 동일 패턴(계정 소속만 조회) ──
alter table diagnoses enable row level security;
alter table brand_expressions enable row level security;
alter table brand_one_liners enable row level security;

grant select on diagnoses to authenticated;
grant select on brand_expressions to authenticated;
grant select on brand_one_liners to authenticated;

create policy "diagnoses_select_own_account" on diagnoses
  for select using (
    exists (
      select 1 from brands
      where brands.id = diagnoses.brand_id
        and is_account_member(brands.account_id)
    )
  );

create policy "brand_expressions_select_own_account" on brand_expressions
  for select using (
    exists (
      select 1 from brands
      where brands.id = brand_expressions.brand_id
        and is_account_member(brands.account_id)
    )
  );

create policy "brand_one_liners_select_own_account" on brand_one_liners
  for select using (
    exists (
      select 1 from brands
      where brands.id = brand_one_liners.brand_id
        and is_account_member(brands.account_id)
    )
  );

-- ── 확인 ──
select * from diagnoses;
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='brands' and column_name='brand_facts';
select tablename, policyname, roles from pg_policies
where schemaname='public' and tablename in ('diagnoses','brand_expressions','brand_one_liners');
