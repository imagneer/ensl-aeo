// lib/email-alert.ts

/**
 * 예산/API 사고 발생 시 즉시 이메일로 알린다.
 * (claude/tasks/done/2026-09-14-incident-email-alert.md)
 *
 * ─────────────────────────────────────────────────────────
 * 왜 만들었나
 * ─────────────────────────────────────────────────────────
 * 2026-09-04 Anthropic 크레딧 소진 사고가 루아에게 실시간으로 보고되지
 * 않고 열흘 뒤 예산 점검에서야 뒤늦게 발견됨. 매주 점검은 스냅샷이라
 * 발생했다가 그 전에 끝난 사고는 놓친다 — "즉시"를 원하면 사고 나는 그
 * 순간 앱 자체가 메일을 보내야 한다.
 *
 * ⚠️ 이 파일의 실패는 절대 본 기능을 막으면 안 된다(작업지시서 "하지 말
 *    것" 1번). sendIncidentAlert는 무슨 일이 있어도 throw하지 않는다 —
 *    Resend 호출 실패든 Supabase 조회 실패든 전부 여기서 삼키고 로그만
 *    남긴다.
 */

import { supabaseAdmin } from './supabase';

export type IncidentErrorType = 'auth_credit' | 'rate_limit' | 'llm_call_cap' | 'unhandled_exception';

const RESEND_API_URL = 'https://api.resend.com/emails';

/** 같은 (플랫폼, 에러유형) 조합으로는 이 시간 안에 또 안 보낸다. */
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6시간

interface SendIncidentAlertParams {
  /** 어느 플랫폼/엔진에서 났는지. 예: 'anthropic', 'perplexity', 'cron:aggregate-daily' */
  platform: string;
  errorType: IncidentErrorType;
  /** 에러 메시지 원문 */
  message: string;
  /** "지금 자동으로 막힌 건지 계속 재시도 중인지" 등, 사람이 바로 판단할 수 있는 한 줄 상태 설명 */
  status: string;
}

const ERROR_TYPE_LABEL: Record<IncidentErrorType, string> = {
  auth_credit: '인증/크레딧 문제',
  rate_limit: 'rate limit',
  llm_call_cap: 'LLM 호출 상한 도달',
  unhandled_exception: '처리되지 않은 예외로 크론 실패',
};

/**
 * 마지막 발송 이후 쿨다운이 지났는지 확인하고, 지났으면 즉시 last_sent_at을
 * 갱신한다(발송 직전이 아니라 여기서 먼저 찍는 이유: Resend 호출이 오래
 * 걸리는 동안 같은 사고가 또 들어와서 이중 발송되는 걸 막기 위함 —
 * 완벽한 락은 아니지만 실제 재현 가능성이 낮은 경합이라 이 정도로 충분함).
 *
 * @returns true면 "이번엔 보내도 됨", false면 "쿨다운 중이라 스킵"
 */
async function passedCooldownAndMarkSent(platform: string, errorType: IncidentErrorType): Promise<boolean> {
  const { data: existing } = await supabaseAdmin
    .from('alert_log')
    .select('last_sent_at')
    .eq('platform', platform)
    .eq('error_type', errorType)
    .maybeSingle();

  if (existing) {
    const elapsed = Date.now() - new Date(existing.last_sent_at).getTime();
    if (elapsed < COOLDOWN_MS) {
      console.log(
        `[email-alert] 쿨다운 중이라 발송 스킵 (platform=${platform}, errorType=${errorType}, ` +
          `마지막 발송 ${Math.round(elapsed / 60000)}분 전)`
      );
      return false;
    }
  }

  const { error } = await supabaseAdmin
    .from('alert_log')
    .upsert(
      { platform, error_type: errorType, last_sent_at: new Date().toISOString() },
      { onConflict: 'platform,error_type' }
    );

  if (error) {
    // alert_log 갱신이 실패해도 이메일 자체는 보낸다 — 쿨다운 추적이
    // 안 되는 것보다, 사고를 못 알리는 게 훨씬 나쁘다.
    console.error('[email-alert] alert_log 갱신 실패(발송은 계속 진행):', error);
  }

  return true;
}

/**
 * 예산/API 사고를 이메일로 보고한다. 실패해도 절대 throw하지 않는다 —
 * 호출부(크론·어댑터)는 이 함수의 결과를 기다리거나 확인할 필요 없다.
 */
export async function sendIncidentAlert(params: SendIncidentAlertParams): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.ALERT_EMAIL_TO;
    const from = process.env.ALERT_EMAIL_FROM;

    if (!apiKey || !to || !from) {
      console.warn(
        '[email-alert] RESEND_API_KEY/ALERT_EMAIL_TO/ALERT_EMAIL_FROM 중 하나라도 없어서 발송 스킵 ' +
          `(platform=${params.platform}, errorType=${params.errorType})`
      );
      return;
    }

    const shouldSend = await passedCooldownAndMarkSent(params.platform, params.errorType);
    if (!shouldSend) return;

    const occurredAtKST = new Date().toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      dateStyle: 'medium',
      timeStyle: 'medium',
    });

    const subject = `[엔슬 AEO 사고] ${params.platform} — ${ERROR_TYPE_LABEL[params.errorType]}`;
    const text = [
      `발생 시각(KST): ${occurredAtKST}`,
      `플랫폼/크론: ${params.platform}`,
      `에러 유형: ${ERROR_TYPE_LABEL[params.errorType]}`,
      `상태: ${params.status}`,
      '',
      '에러 메시지 원문:',
      params.message,
    ].join('\n');

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[email-alert] Resend 발송 실패 (${response.status}): ${body}`);
      return;
    }

    console.log(`[email-alert] 발송 완료 (platform=${params.platform}, errorType=${params.errorType})`);
  } catch (error) {
    // 이 함수는 절대 밖으로 에러를 던지지 않는다.
    console.error('[email-alert] sendIncidentAlert 자체 실패(무시하고 계속 진행):', error);
  }
}

/**
 * 엔진 어댑터 에러 메시지를 보고 "이메일까지 보낼 사고"인지 분류한다.
 * null이면 이 알림 대상이 아니라는 뜻(네트워크 순간 끊김 등 — 이미
 * status='failed'로 DB에 남으니 별도 이메일까지는 안 보냄).
 *
 * 401/403과 429를 분리하는 이유(2026-09-14 루아 확인): 전자는 사람이
 * 직접 조치해야 하는 문제(키 만료·크레딧 소진)고, 후자는 자동 재시도로
 * 해결될 수 있는 문제라 — CLAUDE.md "재시도는 나아질 수 있는 에러에만"과
 * 같은 구분이다. 같은 유형으로 묶으면 이 구분이 사라진다.
 */
export function classifyEngineErrorType(errorMessage: string): 'auth_credit' | 'rate_limit' | null {
  const msg = errorMessage.toLowerCase();

  if (/\b429\b/.test(msg) || /rate limit/.test(msg)) return 'rate_limit';
  if (
    /\b401\b/.test(msg) ||
    /\b403\b/.test(msg) ||
    /unauthorized|forbidden|insufficient|credit|quota/.test(msg)
  ) {
    return 'auth_credit';
  }

  return null;
}
