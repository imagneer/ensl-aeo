-- Day 19 — 8단계: brand_competitors 계정 격리 (루아 지적으로 발견된 누락분 보정)
-- 실행 시점: 지금
--
-- brands/queries와 같은 "누구나 읽기" 정책이 brand_competitors에도 남아있었다.
-- 코드에서 이 테이블을 아직 안 읽는다는 건 앱 레벨 얘기고, anon 키는
-- 누구나 REST API로 직접 두드릴 수 있는 공개 키라 DB 레벨 노출은
-- 그대로였다 — 다른 테이블과 같은 이유로 지금 닫는다.
--
-- brand_id 컬럼 확인 완료(2026-08-31, information_schema 실측):
--   id, brand_id, competitor_brand_id, added_at

drop policy if exists "Allow public read access on brand_competitors" on brand_competitors;

grant select on brand_competitors to authenticated;

create policy "brand_competitors_select_own_account" on brand_competitors
  for select using (
    exists (
      select 1 from brands
      where brands.id = brand_competitors.brand_id
        and is_account_member(brands.account_id)
    )
  );

-- 실행 후 확인:
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'brand_competitors';
-- brand_competitors_select_own_account 하나만 남아있어야 정상.

select has_table_privilege('authenticated', 'brand_competitors', 'SELECT') as authenticated_select;
-- true여야 정상.
