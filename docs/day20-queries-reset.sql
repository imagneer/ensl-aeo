-- Day 20 사전작업 — 질문 세트 12개 확정 + query_type 컬럼 도입
-- 실행 순서 중요: 컬럼 추가 → 기존 행 정리 → 신규 삽입

-- ── 1. query_type 컬럼 추가 ──
alter table queries add column query_type text check (query_type in ('인지', '자리'));

-- ── 2. 기존 행 중 확정 12개와 일치하는 것에 query_type 채우기 ──
-- (마침표 유무만 다르고 내용은 동일 — 실측 확인함, 2026-08-31)
update queries set query_type = '자리'
where query_text = '강서구에서 임플란트 잘하는 치과 알려줘';

update queries set query_type = '자리'
where query_text = '강서구에서 고난도 임플란트 잘하는 치과 추천해줘';

-- ── 3. 확정 12개에 없는 기존 행 비활성화 (소프트 삭제 — 관측 이력 보존) ──
-- 치아교정(444건)·가격(438건)은 지시서에서 이미 언급, 라미네이트(441건)는
-- 실측 대조 중 새로 발견 — 셋 다 루아 확인 받고 비활성화(2026-08-31).
update queries set is_active = false
where query_text in (
  '강서구 치아교정 잘하는 치과 추천해줘',
  '강서구치과에서 라미네이트 전문 치과 알려줘',
  '강서구에서 임플란트 가격 괜찮은 치과 알려줘'
);

-- ── 4. 신규 삽입: 인지 질문 3개 ──
-- brand_id는 365서울원탑치과 고정 (지금 타겟 브랜드가 이거 하나뿐이라 하드코딩
-- 아님 — 유일한 실제 값을 그대로 씀. 브랜드 늘어나면 이 스크립트 재사용 금지).
insert into queries (brand_id, query_text, query_type, is_active)
select 'a2498cc7-9068-41c5-ad04-43aa2f6e2d3d', v.query_text, '인지', true
from (values
  ('365서울원탑치과는 어떤 치과야?'),
  ('365서울원탑치과는 뭐가 유명해?'),
  ('임플란트 치료를 받으려고 하는데 365서울원탑치과는 어때?')
) as v(query_text);

-- ── 5. 신규 삽입: 자리 질문 7개 (기존 2개 제외한 나머지) ──
insert into queries (brand_id, query_text, query_type, is_active)
select 'a2498cc7-9068-41c5-ad04-43aa2f6e2d3d', v.query_text, '자리', true
from (values
  ('강서구에서 임플란트 재수술을 잘하는 치과 추천해줘'),
  ('잇몸뼈가 부족하다고 들었는데 강서구에서 뼈이식 임플란트 잘하는 치과는 어디야?'),
  ('임플란트 말고도 잇몸이나 보철 치료가 같이 필요한데, 강서구에서 이런 복잡한 치료를 잘 보는 치과는 어디야?'),
  ('강서구에서 부모님 임플란트를 믿고 맡길 만한 치과를 추천해줘'),
  ('여러 곳을 다니지 않고 임플란트 진단부터 수술, 보철까지 한곳에서 받을 수 있는 강서구 치과가 있을까?'),
  ('임플란트 비용이 걱정되는데, 강서구에서 비용과 치료 계획을 자세히 설명해주는 치과는 어디야?'),
  ('강서구에서 주말에도 임플란트 진료를 받을 수 있는 치과를 알려줘')
) as v(query_text);

-- ── 확인 ──
select query_type, is_active, count(*) from queries group by query_type, is_active order by query_type, is_active;
-- 기대값: 인지/true=3, 자리/true=9, null(비활성)/false=3

select query_text, query_type, is_active from queries where is_active = true order by query_type, created_at;
-- 인지 3개 + 자리 9개 = 12행이어야 정상.
