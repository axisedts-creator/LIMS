// PA-1..PA-6 copy by error code (C13 04-UI-UX §2, C2 AU copy). Shared by client forms and actions; no secrets here.
export type ActionResult = { ok: true } | { ok: false; code: string; retryAfterSeconds?: number };

export function humanDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return 'a few minutes';
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(Math.ceil(seconds), 'second');
  if (seconds < 3600) return unit(Math.ceil(seconds / 60), 'minute');
  return unit(Math.ceil(seconds / 3600), 'hour');
}

const COPY: Record<string, string> = {
  'auth.login_failed': 'Email or password is incorrect.',
  'auth.step_up_required': 'Too many failed attempts. Reset your password using “Forgot password”, or ask your administrator to unlock your account.',
  'auth.account_locked': 'Your account is locked. Contact your administrator.',
  'identity.tenant_suspended': 'Access for your laboratory is currently suspended. Contact your administrator.',
  'partners.partner_inactive': 'Your organisation’s access is currently suspended. Contact your laboratory.',
  'common.dependency_unavailable': 'Sign-in is temporarily unavailable. Try again in a few minutes.',
  'auth.csrf_failed': 'Your request could not be verified. Reload the page and try again.',
  'auth.mfa_invalid': "That code didn't work. Check your phone's time is correct and try the newest code.",
  'auth.password_policy_violation': 'Use at least 12 characters.',
  'auth.password_breached': 'This password appears in known data breaches. Choose a different one.',
  'auth.reset_token_invalid': 'This link is no longer valid. Ask your administrator to send a new invitation.',
  'auth.invite_invalid': 'This link is no longer valid. Ask your administrator to send a new invitation.',
  'common.validation_failed': 'Check the highlighted fields and try again.',
};

// [CONV] codes without spec copy fall back to the generic "temporarily unavailable" line (never a raw code).
export function errorCopy(r: { code: string; retryAfterSeconds?: number }): string {
  if (r.code === 'common.rate_limited') return `Too many attempts. Try again in ${humanDuration(r.retryAfterSeconds)}.`;
  return COPY[r.code] ?? COPY['common.dependency_unavailable']!;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
