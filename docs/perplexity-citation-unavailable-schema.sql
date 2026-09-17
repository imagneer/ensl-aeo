-- Perplexity Agent API 전환에 따른 citation_confidence 예외값 추가
-- (docs/claude_day8-decision-citation-linking.md "2026-09-14 갱신" 참고)
--
-- 왜 새 컬럼이 아니라 기존 체크 제약 확장인가:
-- 'unavailable'은 citation_confidence가 이미 표현하는 개념(이 멘션에
-- 출처를 얼마나 확신할 수 있는가)의 네 번째 값일 뿐, 별도 축이 아니다.
-- 새 컬럼을 추가하면 "citation_confidence는 'none'인데 citation_status는
-- 'unavailable'"처럼 두 컬럼이 서로 모순되는 상태가 가능해져 오히려
-- 실수를 유발한다.
--
-- 'none'과 'unavailable'의 차이 (반드시 구분할 것):
--   none        = 이 답변엔 출처 마커 자체가 없었다(AI가 근거 없이 언급함) —
--                 다른 엔진에서도 발생할 수 있는 정상적인 개별 관측치
--   unavailable = 이 엔진(현재는 Perplexity만) 자체가 구조적으로 "사용한 것"을
--                 알려주지 않는다 — 개별 관측이 아니라 엔진 차원의 한계

alter table mentions
  drop constraint mentions_citation_confidence_check;

alter table mentions
  add constraint mentions_citation_confidence_check
  check (citation_confidence in ('confirmed', 'estimated', 'none', 'unavailable'));
