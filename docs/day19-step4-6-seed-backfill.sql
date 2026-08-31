-- Day 19 — 4~6단계: 워크스페이스 시딩 + brands 백필
-- 실행 시점: 3번(루아가 실제로 매직링크 로그인 완료) 이후에만 실행 가능.
-- 로그인 전에 이 SQL을 돌리면 4단계에서 쓸 user_id가 없어서 막힌다.

-- ── 0. 루아의 user_id 확인 ──
-- 로그인 링크를 한 번이라도 눌렀다면 auth.users에 행이 생겨있다.
-- 이메일로 찾아서 user_id(uuid)를 복사해둔다.
select id as user_id, email, created_at
from auth.users
order by created_at desc;

-- ── 4. 워크스페이스 생성 + 소속 등록 ──
-- 아래 <루아의 user_id>를 위에서 복사한 값으로 바꿔서 실행.

insert into accounts (name) values ('365서울원탑치과') returning id;
-- ↑ 방금 나온 id를 아래 <account id>에 붙여넣는다.

insert into account_members (account_id, user_id, role, status)
values ('<account id>', '<루아의 user_id>', 'owner', 'active');

-- ── 5. 기존 brands 행에 account_id 채우기 ──
-- 지금은 브랜드가 365서울원탑치과 하나뿐이라 전체 업데이트로 충분하다.
-- 브랜드가 여러 개로 늘어난 뒤에 이 스크립트를 재사용하면 안 됨 —
-- 그때는 브랜드별로 어느 워크스페이스 소속인지 구분해서 채워야 한다.

update brands set account_id = '<account id>';

-- ── 6. 전부 채워졌는지 확인 후 NOT NULL 추가 ──

select id, name, account_id from brands;
-- account_id가 비어있는 행이 하나도 없는 것 확인한 다음에만 아래 실행.

alter table brands alter column account_id set not null;
