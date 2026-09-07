-- Day22 후속 작업지시서 — why-box/counter-box 문구 저장용 신규 테이블
-- 작업지시서: Day22_작업지시서_후속_문구생성및화면구현.md §1, 1-6
--
-- 페이지를 열 때마다 LLM으로 새로 생성하면(지연·비용 발생 + 매번 문구가
-- 조금씩 달라짐) brand_one_liners와 같은 문제가 생긴다 — 그래서 한 번
-- 생성+검수해서 저장해두고 화면은 읽기만 한다(2026-09-07 확인).

create table gap_feature_narratives (
  id uuid primary key default gen_random_uuid(),
  diagnosis_id uuid not null references diagnoses(id),
  brand_id uuid not null references brands(id),
  feature_text text not null,
  why_box_sentences text[] not null,      -- 1~2개
  counter_box_cases jsonb,                 -- 0~3개, [{mentionId, explanation}] 형태. 없으면 null
  generated_by text not null,              -- 생성(Haiku)에 쓴 모델명
  reviewed boolean not null default false,
  reviewed_by text,                        -- 검수(Sonnet)에 쓴 모델명 — generated_by와 달라야 함
  created_at timestamptz not null default now()
);

comment on column gap_feature_narratives.why_box_sentences is
  '작업지시서 §1-2 판정 텍스트 규칙을 근거로 서술 — "선택"·"골랐다" 등 AI 내부 인과 언어 금지(이 화면 전체의 핵심 원칙).';
comment on column gap_feature_narratives.counter_box_cases is
  'co_mentioned 사례 중 근거 연결 표현이 없어서 제외된 것. "확신 못해서" 같은 표현 금지 — 반드시 "답변 문장에 근거 연결 표현이 없어서"로 서술.';
comment on column gap_feature_narratives.reviewed is
  '검수(Sonnet)를 통과 못하면(재시도 1회 포함) 이 행 자체를 저장하지 않는다 — 화면은 "판단할 데이터가 부족함"으로 처리.';

-- ── RLS + GRANT (brand_feature_conflicts와 동일 패턴 — diagnosis_id/brand_id를
-- 직접 갖고 있어서 brands만 한 번 거치면 됨) ──
alter table gap_feature_narratives enable row level security;

grant select on gap_feature_narratives to authenticated;
grant all on gap_feature_narratives to service_role;

create policy "gap_feature_narratives_select_own_account" on gap_feature_narratives
  for select using (
    exists (
      select 1 from brands
      where brands.id = gap_feature_narratives.brand_id
        and is_account_member(brands.account_id)
    )
  );

-- ── 확인 ──
select table_name,
  has_table_privilege('authenticated', table_name, 'SELECT') as auth_select,
  has_table_privilege('service_role', table_name, 'SELECT') as service_select,
  has_table_privilege('anon', table_name, 'SELECT') as anon_select
from (values ('gap_feature_narratives')) as t(table_name);
