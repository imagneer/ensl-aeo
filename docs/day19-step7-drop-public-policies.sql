-- Day 19 — 7단계: 기존 "누구나 읽기" 정책 제거 (마이그레이션의 실제 마무리)
--
-- ⚠️ 지금 실행하면 안 됨. 아래 순서가 전부 끝난 걸 확인한 뒤에만 실행:
--   1. docs/day19-step1-schema-rls.sql 실행 완료 (2026-08-31 완료됨)
--   2. 로그인 코드 배포 완료
--   3. 루아가 실제로 매직링크 로그인 완료
--   4. docs/day19-step4-6-seed-backfill.sql 실행 완료 (계정 시딩 + brands.account_id 백필)
--   5. (dashboard) 사이드바에 365서울원탑치과가 정상 노출되는 것 확인
--
-- 이 SQL을 실행하기 전까지는 brands/queries/brand_competitors가
-- is_account_member 정책과 "누구나 읽기" 정책이 같이 걸린 상태라,
-- 실제로는 계정 격리가 전혀 적용되고 있지 않다(OR로 합쳐지기 때문).
-- 이 SQL을 실행해야 그 격리가 실제로 걸린다 — 그리고 그 순간부터
-- `/`(기존 데모 홈페이지)는 영구적으로 "등록된 브랜드가 없습니다"로
-- 보이게 된다(2026-08-31, 이미 알고 그대로 두기로 확인됨).

drop policy "Allow public read access on brands" on brands;
drop policy "Allow public read access on queries" on queries;

-- brand_competitors는 Day19 작업지시서 범위 밖(코드에서 아직 안 씀,
-- lib/parser.ts 주석에만 언급됨) — 계정 필터링 정책 자체가 없어서
-- 지금 이 정책만 지우면 그 테이블은 완전히 막힌다. 이 테이블을
-- 실제로 쓰게 될 때 brand_id → brands.account_id 경유 정책을
-- 새로 만들고 나서 지울 것.
-- drop policy "Allow public read access on brand_competitors" on brand_competitors;

-- 실행 후 확인:
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename in ('brands', 'queries')
order by tablename, policyname;
-- brands/queries에 각각 *_select_own_account 정책 하나씩만 남아있어야 정상.
