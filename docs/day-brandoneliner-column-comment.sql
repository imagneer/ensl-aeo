-- brand_one_liners.one_liner에 경고 주석 (루아 요청, 2026-09-01)
-- Day22·23 등에서 이 필드를 다시 쓸 사람이 실수하지 않도록, Supabase
-- 대시보드에서 컬럼 옆에 바로 보이는 DB 레벨 코멘트로 남긴다.

comment on column brand_one_liners.one_liner is
  'status와 항상 같이 봐야 함. 반복확인=확정된 브랜드 한 줄, 초기한줄=아직 확정 아닌 문장(완성형처럼 인용 금지), 근거부족=null.';
