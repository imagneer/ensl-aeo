-- 브랜드 한 줄 — 자동검수 재시도 로그 컬럼 추가 (루아 제안, 2026-09-01)
-- 화면엔 안 보여주지만, "왜 이 한 줄은 근거가 약하지?" 디버깅용으로 남긴다.

alter table brand_one_liners add column generation_log jsonb;
-- 예: {"original_feature_count": 3, "retry_count": 1, "excluded_by_review": ["고난도 임플란트"]}

select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='brand_one_liners' and column_name='generation_log';
