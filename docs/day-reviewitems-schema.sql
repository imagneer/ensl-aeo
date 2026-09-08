-- 사람 검증 인프라 — review_items 테이블 (작업지시서_사람검증_인프라_2026-09-08.md §2)
-- 실행: 코난이 DATABASE_URL + pg로 직접 실행 (2026-08-28 결정: 에이전트가 인프라 직접 실행)

create table review_items (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id),
  diagnosis_id uuid not null references diagnoses(id),
  item_type text not null,          -- 'brand_one_liner' | 'brand_one_liner_conflict' | 'feature_conflict_summary' (계속 늘어남, DB check 없음 — 코드가 소스)
  source_table text,                -- 원천 행이 있는 테이블 (예: 'brand_one_liners')
  source_id uuid,                   -- 원천 행 id
  ai_text text not null,            -- AI 초안 (불변)
  final_text text,                  -- 승인 시 최종문. 수정 없이 승인이면 ai_text와 동일 복사
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  edited boolean not null default false,   -- final_text != ai_text
  -- 2026-09-08 코난 제안, 루아 확인(같은 날) — brand_one_liner/brand_one_liner_conflict
  -- 중 '초기한줄'·'잘못된인지' 상태는 LLM이 아니라 고정 문구 템플릿(브랜드/특징
  -- 이름만 대입)이라, 반려해도 재생성 함수를 다시 불러봤자 토씨 하나 안 바뀐
  -- 같은 문장이 또 나온다. 그래서 이 값이 false인 항목은 반려 시 자동 재생성
  -- 큐에 넣지 않고 "수동 처리 필요"로만 표시한다(§4 반려 루프는 이 값이
  -- true인 항목에만 적용). '반복확인' one_liner와 feature_conflict_summary는
  -- 둘 다 진짜 LLM 자유 작성 문장이라 true.
  auto_regeneratable boolean not null default true,
  reason_category text
    check (reason_category in ('과잉해석','사실불일치','표현누락','문체톤','기타')),
  reviewer_note text,
  reviewer_id uuid,                 -- auth user
  reviewed_at timestamptz,
  generation_round smallint not null default 1,
  previous_item_id uuid references review_items(id),  -- 반려 → 재생성 이력 체인
  evidence jsonb,                   -- 검토자 참고용: 관측 수치, 인용 id 목록 등 (표시용, 검증 대상 아님)
  created_at timestamptz not null default now()
);
create index on review_items (brand_id, diagnosis_id, status);
-- "이 원천 행의 현재(최신 회차) 검토 상태"를 빠르게 찾기 위한 인덱스.
-- 화면 게이팅(getApprovedText 등)이 매 요청마다 이 조건으로 조회한다.
create index on review_items (source_table, source_id, generation_round desc);

alter table review_items enable row level security;
grant select on review_items to authenticated;

-- 기존 brand_one_liners_select_own_account와 동일 패턴 (brands.account_id 기준).
create policy "review_items_select_own_account" on review_items
  for select using (
    exists (
      select 1 from brands
      where brands.id = review_items.brand_id
        and is_account_member(brands.account_id)
    )
  );

-- ── 백필: 기존 brand_one_liners 행 → review_items pending으로 이관 ──
-- (2026-09-08 실측: 현재 brand_one_liners는 1행뿐, 상태 '반복확인',
--  reviewed_by_human=false — 백필해도 review_items에 1행만 생김)
insert into review_items (brand_id, diagnosis_id, item_type, source_table, source_id, ai_text, status, auto_regeneratable)
select
  brand_id,
  diagnosis_id,
  case when status = '잘못된인지' then 'brand_one_liner_conflict' else 'brand_one_liner' end,
  'brand_one_liners',
  id,
  one_liner,
  case when reviewed_by_human then 'approved' else 'pending' end,
  status = '반복확인'  -- 초기한줄/잘못된인지는 고정 템플릿 → false
from brand_one_liners
where one_liner is not null;  -- 근거부족(oneLiner=null)은 검증 대상 문장 자체가 없음

-- brand_feature_conflicts(3번 칸, "서로 다르게 설명하는 지점")는 지금 0행이라
-- 백필할 게 없음 — 앞으로 새로 생기는 행부터 lib/brand-one-liner.ts가
-- review_items를 같이 만든다.

-- ── 확인 ──
select item_type, status, auto_regeneratable, count(*) from review_items group by 1,2,3;
