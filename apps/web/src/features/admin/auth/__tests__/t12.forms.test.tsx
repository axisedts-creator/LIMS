// @vitest-environment jsdom
// C2.T12 — AU-1..AU-7 components (04-UI-UX §4 copy + field rules), driven with injected action stubs (the real actions are covered in t12.actions.test.ts).
// ASSUMED contract — named exports under features/admin/auth/:
//   LoginForm.tsx            LoginForm({ action, loggedOut?, next? })
//   MfaChallengeForm.tsx     MfaChallengeForm({ action, logoutAction })
//   MfaEnrolment.tsx         MfaEnrolment({ startAction, completeAction, forced? })  — QR step calls startAction when step 2 opens
//   ForgotPasswordForm.tsx   ForgotPasswordForm({ action })
//   SetPasswordForm.tsx      SetPasswordForm({ action, variant: 'invite' | 'recovery', tenantName? })
//   ConfirmLanding.tsx       ConfirmLanding({ action, tokenHash, type })   — calls action({token_hash,type}) once on mount
//   SessionExpiredCard.tsx   SessionExpiredCard({ reason?: 'locked' | 'suspended' | 'role_changed', minutes })
//   action type: (FormData) => Promise<{ ok: true } | { ok: false; code: string; retryAfterSeconds?: number }>  (see t12.actions.test.ts)
// Components are client code: they must never see a token (no prop/arg named *token* other than the one-time link token_hash on ConfirmLanding).
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../LoginForm';
import { MfaChallengeForm } from '../MfaChallengeForm';
import { MfaEnrolment } from '../MfaEnrolment';
import { ForgotPasswordForm } from '../ForgotPasswordForm';
import { SetPasswordForm } from '../SetPasswordForm';
import { ConfirmLanding } from '../ConfirmLanding';
import { SessionExpiredCard } from '../SessionExpiredCard';

afterEach(cleanup);
const fail = (code: string, extra: Record<string, unknown> = {}) => vi.fn(async (_fd?: unknown) => ({ ok: false as const, code, ...extra }));
const okAction = () => vi.fn(async (_fd?: unknown) => ({ ok: true as const }));
const sent = (fn: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries((fn.mock.calls[call]?.[0] as FormData).entries());
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const noAxeViolations = async (el: HTMLElement) => {
  const r = await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

describe('AU-1 LoginForm', () => {
  it('has Email (autocomplete=username) + Password (autocomplete=current-password) + "Log in"; submits both; Enter submits; links to /auth/forgot', async () => {
    const action = okAction();
    const { container } = render(<LoginForm action={action} />);
    const email = screen.getByLabelText(/^email/i) as HTMLInputElement;
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    expect(email.getAttribute('autocomplete')).toBe('username');
    expect(pw.getAttribute('autocomplete')).toBe('current-password');
    expect(pw.type).toBe('password');
    expect(screen.getByRole('link', { name: /forgot password\?/i }).getAttribute('href')).toBe('/auth/forgot');
    const u = userEvent.setup();
    await u.type(email, 'user@example.test');
    await u.type(pw, 'Correct-horse-1{Enter}');
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(sent(action)).toMatchObject({ email: 'user@example.test', password: 'Correct-horse-1' });
    await noAxeViolations(container);
  });

  it('does not call the action for an empty / malformed email or empty password', async () => {
    const action = okAction();
    render(<LoginForm action={action} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await u.type(screen.getByLabelText(/^email/i), 'not-an-email');
    await u.type(screen.getByLabelText('Password'), 'x');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    expect(action).not.toHaveBeenCalled();
  });

  it('enforces max lengths: email 254, password 128', () => {
    render(<LoginForm action={okAction()} />);
    expect((screen.getByLabelText(/^email/i) as HTMLInputElement).maxLength).toBe(254);
    expect((screen.getByLabelText('Password') as HTMLInputElement).maxLength).toBe(128);
  });

  it('shows the lab-neutral wordmark without tenant branding and the ?logged_out=1 info banner only when asked', () => {
    const { rerender } = render(<LoginForm action={okAction()} />);
    expect(text()).not.toContain('You have been logged out.');
    rerender(<LoginForm action={okAction()} loggedOut />);
    expect(text()).toContain('You have been logged out.');
  });

  it('keeps a validated `next` as a hidden field so the action can honour it', () => {
    const { container } = render(<LoginForm action={okAction()} next="/analytics/reports" />);
    expect((container.querySelector('input[name="next"]') as HTMLInputElement | null)?.value).toBe('/analytics/reports');
  });

  it.each([
    ['auth.login_failed', 'Email or password is incorrect.'],
    ['auth.step_up_required', 'Too many failed attempts. Reset your password using “Forgot password”, or ask your lab administrator to unlock your account.'],
    ['auth.account_locked', 'Your account is locked. Contact your lab administrator.'],
    ['identity.membership_inactive', 'Your account is not active. Contact your lab administrator.'],
    ['identity.tenant_suspended', 'Access for your lab is currently suspended. Contact your lab administrator.'],
    ['identity.platform_ip_denied', 'Platform access is not allowed from this network.'],
    ['common.dependency_unavailable', 'Sign-in is temporarily unavailable. Try again in a few minutes.'],
  ])('renders the exact copy for %s', async (code, copy) => {
    render(<LoginForm action={fail(code)} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^email/i), 'user@example.test');
    await u.type(screen.getByLabelText('Password'), 'pw{Enter}');
    await waitFor(() => expect(text()).toContain(copy));
  });

  it('common.rate_limited shows "Too many attempts. Try again in …" with a human duration from retryAfterSeconds', async () => {
    render(<LoginForm action={fail('common.rate_limited', { retryAfterSeconds: 120 })} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^email/i), 'user@example.test');
    await u.type(screen.getByLabelText('Password'), 'pw{Enter}');
    await waitFor(() => expect(text()).toMatch(/Too many attempts\. Try again in 2 minutes\./));
  });

  it('disables the fields while the request is in flight (button spinner) and shows no raw error code', async () => {
    let release!: () => void;
    const action = vi.fn(() => new Promise<{ ok: true }>((r) => { release = () => r({ ok: true }); }));
    render(<LoginForm action={action} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^email/i), 'user@example.test');
    await u.type(screen.getByLabelText('Password'), 'pw{Enter}');
    await waitFor(() => expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(true));
    release();
    expect(text()).not.toMatch(/auth\.[a-z_]+/);
  });
});

describe('AU-2 MfaChallengeForm', () => {
  it('shows the prompt, a 6-cell OtpInput (one-time-code) and "Verify"; paste of 6 digits then Verify submits {code}', async () => {
    const action = okAction();
    const { container } = render(<MfaChallengeForm action={action} logoutAction={okAction()} />);
    expect(text()).toContain('Enter the 6-digit code from your authenticator app.');
    const cells = screen.getAllByRole('textbox');
    expect(cells).toHaveLength(6);
    expect(cells[0]?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(cells.every((c) => c.getAttribute('inputmode') === 'numeric')).toBe(true);
    const u = userEvent.setup();
    await u.click(cells[0]!);
    await u.paste('123456');
    await u.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(sent(action, action.mock.calls.length - 1)).toMatchObject({ code: '123456' });
    await noAxeViolations(container);
  });

  it('does not submit an incomplete code', async () => {
    const action = okAction();
    render(<MfaChallengeForm action={action} logoutAction={okAction()} />);
    const u = userEvent.setup();
    await u.type(screen.getAllByRole('textbox')[0]!, '123');
    await u.click(screen.getByRole('button', { name: 'Verify' }));
    expect(action).not.toHaveBeenCalled();
  });

  it('auth.mfa_invalid shows the exact copy; "Use a different account" calls the logout action', async () => {
    const logout = okAction();
    render(<MfaChallengeForm action={fail('auth.mfa_invalid')} logoutAction={logout} />);
    const u = userEvent.setup();
    await u.click(screen.getAllByRole('textbox')[0]!);
    await u.paste('000000');
    await u.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(text()).toContain("That code didn't work. Check your phone's time is correct and try the newest code."));
    await u.click(screen.getByRole('button', { name: /use a different account/i }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });
});

describe('AU-3 MfaEnrolment', () => {
  const start = () => vi.fn(async (_fd?: unknown) => ({ ok: true as const, factor_id: '0190f3a2-7b1c-7d3e-8a4f-5b6c7d8e9f01', otpauth_uri: 'otpauth://totp/LIMS:u?secret=JBSWY3DPEHPK3PXP', qr_svg_base64: 'PHN2Zy8+', secret_base32: 'JBSWY3DPEHPK3PXP' }));
  const ack = async (u: ReturnType<typeof userEvent.setup>) => {
    const box = screen.queryByRole('checkbox');
    if (box) await u.click(box);
  };

  it('walks 3 steps: install text -> QR (DataUriImage, alt) + secret + Device name default "Authenticator" -> OtpInput + Confirm -> "Two-step verification is on."', async () => {
    const startAction = start();
    const completeAction = okAction();
    const { container } = render(<MfaEnrolment startAction={startAction} completeAction={completeAction} />);
    const u = userEvent.setup();
    expect(text()).toMatch(/Step 1 of 3/);
    expect(text()).toContain('Install an authenticator app on your phone (any TOTP app).');
    await u.click(screen.getByRole('button', { name: /^continue$/i }));
    const img = await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    expect(img.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    expect(container.querySelector('svg[role="img"], svg[aria-label*="QR"]')).toBeNull(); // never inline SVG markup
    expect(text()).toMatch(/Step 2 of 3/);
    expect(text()).toContain('JBSWY3DPEHPK3PXP');
    expect((screen.getByLabelText(/device name/i) as HTMLInputElement).value).toBe('Authenticator');
    expect((screen.getByLabelText(/device name/i) as HTMLInputElement).maxLength).toBe(40);
    await ack(u);
    await u.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(text()).toMatch(/Step 3 of 3/));
    await u.click(screen.getAllByRole('textbox')[0]!);
    await u.paste('654321');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(completeAction).toHaveBeenCalled());
    expect(sent(completeAction, completeAction.mock.calls.length - 1)).toMatchObject({ factor_id: '0190f3a2-7b1c-7d3e-8a4f-5b6c7d8e9f01', code: '654321' });
    await waitFor(() => expect(text()).toContain('Two-step verification is on.'));
    expect(screen.queryByRole('link', { name: /continue to lims/i }) ?? screen.queryByRole('button', { name: /continue to lims/i })).not.toBeNull();
  });

  it('forced enrolment shows the banner; voluntary (ME-1) does not (AC-A3.3 shares the same flow)', () => {
    const { rerender } = render(<MfaEnrolment startAction={start()} completeAction={okAction()} forced />);
    expect(text()).toContain('Your role requires two-step verification before you can continue.');
    rerender(<MfaEnrolment startAction={start()} completeAction={okAction()} />);
    expect(text()).not.toContain('Your role requires two-step verification before you can continue.');
  });

  it('a wrong code shows the AU-2 error copy and stays on step 3', async () => {
    render(<MfaEnrolment startAction={start()} completeAction={fail('auth.mfa_invalid')} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /^continue$/i }));
    await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    await ack(u);
    await u.click(screen.getByRole('button', { name: /^continue$/i }));
    await u.click(screen.getAllByRole('textbox')[0]!);
    await u.paste('111111');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(text()).toMatch(/didn't work/));
    expect(text()).not.toContain('Two-step verification is on.');
  });
});

describe('AU-4 ForgotPasswordForm (AC-A7.1)', () => {
  it('submits {email} and then ALWAYS shows the constant message echoing the typed email', async () => {
    const action = okAction();
    render(<ForgotPasswordForm action={action} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^email/i), 'anyone@example.test');
    await u.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() => expect(text()).toContain('If an account exists for anyone@example.test, we have sent a reset link. The link works once and expires in 60 minutes.'));
    expect(sent(action)).toMatchObject({ email: 'anyone@example.test' });
  });

  it('shows the same message even if the action reports an error code (no existence oracle)', async () => {
    render(<ForgotPasswordForm action={fail('common.rate_limited')} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^email/i), 'anyone@example.test');
    await u.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() => expect(text()).toContain('If an account exists for anyone@example.test'));
  });
});

describe('AU-5 SetPasswordForm (AC-A7.3, AC-A8.1)', () => {
  const NEW = 'a-long-new-passphrase-2026';
  it('invite variant title uses the tenant name; recovery variant is "Choose a new password"', () => {
    const { rerender } = render(<SetPasswordForm action={okAction()} variant="invite" tenantName="Alpha Diagnostics" />);
    expect(screen.getByRole('heading').textContent).toContain('Welcome to Alpha Diagnostics');
    rerender(<SetPasswordForm action={okAction()} variant="recovery" />);
    expect(screen.getByRole('heading').textContent).toContain('Choose a new password');
  });

  it('fields use autocomplete=new-password (12–128) and the live checklist items exist', async () => {
    const { container } = render(<SetPasswordForm action={okAction()} variant="recovery" />);
    const np = screen.getByLabelText('New password') as HTMLInputElement;
    expect(np.getAttribute('autocomplete')).toBe('new-password');
    expect(np.maxLength).toBe(128);
    expect((screen.getByLabelText('Confirm password') as HTMLInputElement).getAttribute('autocomplete')).toBe('new-password');
    expect(text()).toContain('At least 12 characters');
    expect(text()).toContain('Not a commonly leaked password (checked when you save)');
    await noAxeViolations(container);
  });

  it('does not call the action for <12 chars or a mismatched confirmation; submits when both are valid', async () => {
    const action = okAction();
    render(<SetPasswordForm action={action} variant="recovery" />);
    const u = userEvent.setup();
    const np = screen.getByLabelText('New password');
    const cp = screen.getByLabelText('Confirm password');
    await u.type(np, 'short');
    await u.type(cp, 'short');
    await u.click(screen.getByRole('button', { name: /save|set password|continue/i }));
    expect(action).not.toHaveBeenCalled();
    await u.clear(np); await u.clear(cp);
    await u.type(np, NEW);
    await u.type(cp, `${NEW}x`);
    await u.click(screen.getByRole('button', { name: /save|set password|continue/i }));
    expect(action).not.toHaveBeenCalled();
    await u.clear(cp);
    await u.type(cp, NEW);
    await u.click(screen.getByRole('button', { name: /save|set password|continue/i }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(sent(action)).toMatchObject({ new_password: NEW, confirm_password: NEW });
  });

  it.each([
    ['auth.password_policy_violation', 'Use at least 12 characters (and no more than 72 bytes).'],
    ['auth.password_breached', 'This password appears in known data breaches. Choose a different one.'],
  ])('%s shows the exact copy', async (code, copy) => {
    render(<SetPasswordForm action={fail(code)} variant="recovery" />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('New password'), NEW);
    await u.type(screen.getByLabelText('Confirm password'), NEW);
    await u.click(screen.getByRole('button', { name: /save|set password|continue/i }));
    await waitFor(() => expect(text()).toContain(copy));
  });
});

describe('/auth/confirm landing — token errors (AC-A7.2, AC-A8.2)', () => {
  it('calls the action once with {token_hash,type} on mount (no UI beyond a spinner)', async () => {
    const action = vi.fn(async () => ({ ok: true as const }));
    render(<ConfirmLanding action={action} tokenHash="pkce_abc" type="recovery" />);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith({ token_hash: 'pkce_abc', type: 'recovery' });
  });

  it('auth.reset_token_invalid -> exact copy + a link to /auth/forgot', async () => {
    render(<ConfirmLanding action={vi.fn(async () => ({ ok: false as const, code: 'auth.reset_token_invalid' }))} tokenHash="used" type="recovery" />);
    await waitFor(() => expect(text()).toContain('This reset link is invalid or has expired. Request a new one.'));
    expect(screen.getByRole('link', { name: /forgot password/i }).getAttribute('href')).toBe('/auth/forgot');
  });

  it('auth.invite_invalid -> exact copy', async () => {
    render(<ConfirmLanding action={vi.fn(async () => ({ ok: false as const, code: 'auth.invite_invalid' }))} tokenHash="used" type="invite" />);
    await waitFor(() => expect(text()).toContain('This invitation link is invalid or has expired. Ask your administrator to resend it.'));
  });

  it('the invalid-token bodies are identical for unknown / used / expired (no oracle): same code -> same rendered text', async () => {
    const mk = () => vi.fn(async () => ({ ok: false as const, code: 'auth.reset_token_invalid' }));
    const a = render(<ConfirmLanding action={mk()} tokenHash="unknown" type="recovery" />);
    await waitFor(() => expect(a.container.textContent).toContain('invalid or has expired'));
    const first = a.container.textContent;
    a.unmount();
    const b = render(<ConfirmLanding action={mk()} tokenHash="expired" type="recovery" />);
    await waitFor(() => expect(b.container.textContent).toContain('invalid or has expired'));
    expect(b.container.textContent).toBe(first);
  });
});

describe('AU-7 SessionExpiredCard', () => {
  it('default copy with {n} minutes and a "Log in again" link to /auth/login', () => {
    render(<SessionExpiredCard minutes={30} />);
    expect(text()).toContain('For your security you were logged out after 30 minutes without activity, or because your session ended.');
    expect(screen.getByRole('link', { name: /log in again/i }).getAttribute('href')).toMatch(/^\/auth\/login/);
  });

  it('role_changed variant', () => {
    render(<SessionExpiredCard minutes={30} reason="role_changed" />);
    expect(text()).toContain('Your access was changed by an administrator. Log in again.');
  });

  it.each(['locked', 'suspended'] as const)('%s variant differs from the default copy', (reason) => {
    const d = render(<SessionExpiredCard minutes={30} />);
    const def = d.container.textContent;
    d.unmount();
    render(<SessionExpiredCard minutes={30} reason={reason} />);
    expect(document.body.textContent).not.toBe(def);
  });
});
