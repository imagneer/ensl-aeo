-- 긴급 수정 — service_role에 brands/queries GRANT 누락 (2026-09-01)
--
-- 무슨 일이 있었나:
--   Day19에서 fetchKnownBrands()/fetchActiveQueries()를 anon → supabaseAdmin
--   (service_role)으로 바꿨다. 계정 격리 RLS가 켜지면 세션 없는 cron
--   파이프라인이 anon으로는 아무것도 못 읽게 되기 때문이었다.
--   그런데 service_role에는 brands/queries에 대한 테이블 GRANT 자체가
--   없었다 — day19-step1b에서 authenticated 것만 채우고 service_role은
--   확인하지 않았다. service_role은 BYPASSRLS라 RLS는 통과하지만,
--   GRANT가 없으면 그 전에 permission denied로 막힌다.
--
-- 실측 피해(2026-09-01 확인):
--   snapshots 일별 수집량 8/24~8/30 = 180건/일 → 8/31 = 120건 → 9/1 = 0건.
--   fetchActiveQueries()가 빈 배열을 돌려주고 collector가 "활성 쿼리가
--   없습니다"만 남긴 채 조용히 아무것도 수집하지 않았다. 크래시가 안 나서
--   더 늦게 발견됐다 — CLAUDE.md가 경고한 "틀린 줄 모르고 돌아가는 코드"의
--   정확한 사례.

grant all on brands to service_role;
grant all on queries to service_role;
grant all on brand_competitors to service_role;

-- 확인
select table_name,
  has_table_privilege('service_role', table_name, 'SELECT') as service_role_select
from (values ('brands'),('queries'),('brand_competitors'),('snapshots'),('mentions'),
             ('aggregated_metrics'),('alerts'),('accounts'),('account_members'),
             ('diagnoses'),('brand_expressions'),('brand_one_liners')) as t(table_name);
-- 전부 true여야 정상.
