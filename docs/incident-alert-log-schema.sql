-- 사고 이메일 알림 쿨다운용 로그 테이블
-- (claude/tasks/done/2026-09-14-incident-email-alert.md)
--
-- 왜 이 표가 필요한가: 같은 사고(같은 플랫폼 + 같은 에러 유형)로 짧은
-- 시간 안에 여러 번 이메일이 가지 않게 막는 유일한 방법이 "마지막으로
-- 언제 보냈는지"를 어딘가에 기억해두는 것이다. Vercel 서버리스 함수는
-- 요청마다 프로세스가 새로 뜨므로 메모리 변수로는 못 막는다.
--
-- platform + error_type 조합을 유니크 키로 잡는 이유: "Anthropic 인증
-- 실패"와 "Anthropic rate limit"은 대응 방법이 다른 별개 사고라 각자
-- 독립적으로 쿨다운을 센다(lib/email-alert.ts 참고).

create table if not exists alert_log (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  error_type text not null,
  message text,
  last_sent_at timestamptz not null default now(),
  unique (platform, error_type)
);
