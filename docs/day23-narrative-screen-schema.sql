-- Day23 "인지와 추천, 그 사이" 화면 교체 — 신규 테이블 2개
-- 작업지시서: 작업지시서_간극화면_교체_2026-09-09_V1.0.md
--
-- 1) brand_owned_channels — "소유 채널" 목록. 지금은 브랜드마다 코난이
--    직접 조사해서 시드로 넣지만, 온보딩 Step2(A안, 개발 미착수)가 붙으면
--    거기서 사용자가 등록한 값이 이 테이블에 들어간다 — 그래서 코드에
--    하드코딩하지 않고 처음부터 테이블로 둔다(CLAUDE.md "브랜드 목록·설정을
--    코드에 하드코딩 금지" 원칙).
-- 2) placement_narrative_top10 — 자리질문 mentions 원문 전체를 재분석한
--    "추천 표현 TOP10"을 진단 완료 시점에 한 번 계산해서 저장한다
--    (brand_one_liners와 같은 이유 — 페이지 열 때마다 LLM 호출하면 느리고
--    비싸고 매번 결과가 조금씩 달라진다, 2026-09-10 루아 확인).

create table brand_owned_channels (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id),
  -- 인용 URL을 정규화(프로토콜·www.·m. 제거)한 문자열에 이 값이 부분
  -- 포함되면 "소유"로 판정한다. 도메인 전체를 소유하면 도메인만
  -- ("onetopdental.com"), 공유 플랫폼 안의 특정 계정만 소유하면 계정
  -- 경로까지("instagram.com/seoulonetop_dentist") 넣는다.
  pattern text not null,
  label text not null, -- 사람이 읽을 이름 (예: "공식 홈페이지", "인스타그램")
  created_at timestamptz not null default now()
);

comment on column brand_owned_channels.pattern is
  '정규화된 URL에 대한 부분일치 패턴. 공유 플랫폼(instagram.com 등)은 반드시 계정 경로까지 포함해야 한다 — 도메인만 넣으면 그 플랫폼의 모든 게시물이 소유로 잘못 잡힌다.';

create table placement_narrative_top10 (
  id uuid primary key default gen_random_uuid(),
  diagnosis_id uuid not null unique references diagnoses(id),
  brand_id uuid not null references brands(id),
  -- [{keyword, count, rate}] — count는 "이 표현이 등장한 관측 수"
  -- (한 관측 안 중복은 1회로만, lib/gap.ts의 기존 규칙과 동일),
  -- appeared_runs(아래 컬럼)이 분모.
  items jsonb not null,
  appeared_runs integer not null,
  computed_at timestamptz not null default now()
);

comment on column placement_narrative_top10.appeared_runs is
  '이 진단 기간, 자리질문 전체에서 우리 브랜드가 실제로 등장한 관측 수 — items[].count의 분모. aggregated_metrics 기반이 아니라 mentions/snapshots 원문 재분석 기준(집계 지연 영향 없음, 2026-09-09 확인).';

-- ── RLS + GRANT (gap_feature_narratives와 동일 패턴) ──

alter table brand_owned_channels enable row level security;
alter table placement_narrative_top10 enable row level security;

grant select on brand_owned_channels to authenticated;
grant all on brand_owned_channels to service_role;
grant select on placement_narrative_top10 to authenticated;
grant all on placement_narrative_top10 to service_role;

create policy "brand_owned_channels_select_own_account" on brand_owned_channels
  for select using (
    exists (
      select 1 from brands
      where brands.id = brand_owned_channels.brand_id
        and is_account_member(brands.account_id)
    )
  );

create policy "placement_narrative_top10_select_own_account" on placement_narrative_top10
  for select using (
    exists (
      select 1 from brands
      where brands.id = placement_narrative_top10.brand_id
        and is_account_member(brands.account_id)
    )
  );

-- ── 365서울원탑치과 소유 채널 시드 (2026-09-10, 인용 URL 직접 대조로 확인) ──
-- 확인 방법: 인지 질문 mentions.source_urls 296개 중 "365/onetop/원탑"이
-- URL 자체에 들어간 것만 추려서 사람이 눈으로 확인. instagram.com/p/... 같은
-- 게시물 단위 링크는 어느 계정 것인지 URL만으로 구분 안 돼서 제외했다
-- (owned로 잘못 넣으면 소유 비율이 과대평가된다) — seoulonetop_dentist
-- 프로필 자체를 직접 가리키는 링크만 owned로 확정.

insert into brand_owned_channels (brand_id, pattern, label) values
  ('a2498cc7-9068-41c5-ad04-43aa2f6e2d3d', 'onetopdental.com', '공식 홈페이지'),
  ('a2498cc7-9068-41c5-ad04-43aa2f6e2d3d', 'instagram.com/seoulonetop_dentist', '인스타그램'),
  ('a2498cc7-9068-41c5-ad04-43aa2f6e2d3d', 'facebook.com/onetopdental', '페이스북');
