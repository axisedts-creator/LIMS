// @vitest-environment jsdom
// AUTH-MFA-PERSIST-1 (LD-248): startMfaEnrolment answers 409 (common.version_conflict) when the user already has a verified factor; the page must not dead-end.
// ASSUMED contract (the implementer may not deviate without a ruling):
//   MfaEnrolment gets two OPTIONAL props:
//     refreshAction: () => Promise<{ ok: true; state: string } | { ok: false; code: string }>   (a BFF server action: POST session/resolve {touch:false}; see t12.mfa-409.actions.test.ts)
//     navigate: (to: string) => void                                                               (default: window.location.assign)
//   On a start failure with code common.version_conflict the page calls refreshAction ONCE, then:
//     state 'mfa_pending' -> navigate('/auth/mfa')    state 'active' -> navigate('/')
//     any other state, or refreshAction failing / throwing -> NOT a dead end: ONE line in a role=status element that mentions "authenticator" and a link "Sign in" to /auth/login
//     (a new login now reaches the code step because the login context finds the verified factor); never the generic danger alert, never "Loading…" for good.
//   Any other start failure keeps today's behaviour (danger alert) and does NOT call refreshAction.
// Expected now: fail (no refreshAction / navigate props: the 409 shows the generic "temporarily unavailable" alert and the user is stuck).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MfaEnrolment } from '../MfaEnrolment';

afterEach(cleanup);
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const conflict = () => vi.fn(async (_fd?: unknown) => ({ ok: false as const, code: 'common.version_conflict' }));
const okAction = () => vi.fn(async (_fd?: unknown) => ({ ok: true as const }));
const GENERIC = 'Sign-in is temporarily unavailable';

async function open(o: { start?: any; refresh?: any; navigate?: any }) {
  const props: any = { startAction: o.start ?? conflict(), completeAction: okAction(), ...(o.refresh ? { refreshAction: o.refresh } : {}), ...(o.navigate ? { navigate: o.navigate } : {}) };
  render(<MfaEnrolment {...props} />); const u = userEvent.setup();
  await u.click(screen.getByRole('button', { name: /^continue$/i })); return u;
}

describe('AU-3 MfaEnrolment: a 409 from startMfaEnrolment is not a dead end (AUTH-MFA-PERSIST-1)', () => {
  it('state mfa_pending after the refresh -> refreshAction called once and navigate("/auth/mfa") (the code step)', async () => {
    const refresh = vi.fn(async () => ({ ok: true as const, state: 'mfa_pending' })); const navigate = vi.fn();
    await open({ refresh, navigate }); await waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/mfa'));
    expect(refresh).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledTimes(1); expect(text()).not.toContain(GENERIC);
  });
  it('state active after the refresh -> navigate("/")', async () => {
    const navigate = vi.fn(); await open({ refresh: vi.fn(async () => ({ ok: true as const, state: 'active' })), navigate }); await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it('state still mfa_enrolment_required -> no navigation; ONE status line about the authenticator and a "Sign in" link to /auth/login; no generic danger alert', async () => {
    const navigate = vi.fn(); await open({ refresh: vi.fn(async () => ({ ok: true as const, state: 'mfa_enrolment_required' })), navigate });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/authenticator/i)); const status = screen.getByRole('status'); expect(status.textContent!.trim().length).toBeLessThanOrEqual(160); expect(status.textContent).not.toMatch(/\n/);
    const link = screen.getByRole('link', { name: /sign in/i }); expect(link.getAttribute('href')).toBe('/auth/login');
    expect(navigate).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull(); expect(text()).not.toContain(GENERIC); expect(text()).not.toContain('Loading…');
  });
  it.each([['returns ok:false', async () => ({ ok: false as const, code: 'common.dependency_unavailable' })], ['throws', async () => { throw new Error('network'); }]])('refreshAction %s -> same recovery message and link (never stuck)', async (_n, impl) => {
    const navigate = vi.fn(); await open({ refresh: vi.fn(impl as any), navigate });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/authenticator/i)); expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/auth/login'); expect(navigate).not.toHaveBeenCalled(); expect(text()).not.toContain('Loading…');
  });
  it('another start failure keeps the danger alert and never calls refreshAction', async () => {
    const refresh = vi.fn(async () => ({ ok: true as const, state: 'mfa_pending' })); const navigate = vi.fn();
    await open({ start: vi.fn(async (_fd?: unknown) => ({ ok: false as const, code: 'common.dependency_unavailable' })), refresh, navigate });
    expect((await screen.findByRole('alert')).textContent).toContain(GENERIC); expect(refresh).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it('a successful start is unchanged (secret shown, refreshAction not called)', async () => {
    const refresh = vi.fn(); const start = vi.fn(async (_fd?: unknown) => ({ ok: true as const, factor_id: '0190f3a2-7b1c-7d3e-8a4f-5b6c7d8e9f01', otpauth_uri: 'otpauth://totp/LIMS:u', secret_base32: 'JBSWY3DPEHPK3PXP' }));
    await open({ start, refresh }); await waitFor(() => expect(text()).toContain('JBSWY3DPEHPK3PXP')); expect(refresh).not.toHaveBeenCalled();
  });
});
