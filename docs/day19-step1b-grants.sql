-- Day 19 — 1b단계: authenticated 역할에 테이블 SELECT 권한 부여 (step1 SQL 누락분 보정)
-- 실행 시점: 이미 실행 완료 (2026-08-31)
--
-- ⚠️ RLS 정책은 "접근 권한이 있는 상태에서 어느 행을 보여줄지"만 거른다.
-- 애초에 테이블 자체에 대한 SELECT 권한(GRANT)이 없으면 RLS 정책까지
-- 가지도 못하고 "permission denied for table ..."로 막힌다. step1 SQL이
-- accounts/account_members 테이블을 새로 만들면서 이 GRANT를 빠뜨렸고,
-- 나머지 테이블(snapshots/mentions/aggregated_metrics/alerts)도 지금까지
-- anon/authenticated 어느 쪽에도 GRANT가 걸린 적이 없었다(둘 다 지금까지
-- supabaseAdmin으로만 읽었기 때문에 안 드러났던 문제).
--
-- 실측 확인(2026-08-31, 루아 실제 로그인 후 사이드바 빈 화면으로 발견):
--   accounts/account_members: authenticated·anon 둘 다 SELECT 권한 없음
--   brands/queries: anon만 SELECT 권한 있음 (Day7), authenticated는 없음
--   snapshots/mentions/aggregated_metrics/alerts: 둘 다 없음

grant select on accounts to authenticated;
grant select on account_members to authenticated;
grant select on brands to authenticated;
grant select on queries to authenticated;
grant select on snapshots to authenticated;
grant select on mentions to authenticated;
grant select on aggregated_metrics to authenticated;
grant select on alerts to authenticated;

-- 실행 후 확인:
select table_name,
  has_table_privilege('authenticated', table_name, 'SELECT') as authenticated_select
from (values ('accounts'),('account_members'),('brands'),('queries'),('snapshots'),('mentions'),('aggregated_metrics'),('alerts')) as t(table_name);
-- 전부 true여야 정상.
