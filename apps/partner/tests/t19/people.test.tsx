// C13.T19 — PF-1 Referring doctors, PU-1 Users, PX-1 Account (04-UI-UX §3), static-markup component tests (T05 harness).
// ACs: US-13.1/13.2 (admin adds + switches doctors, members only read), US-13.3 (lab check states Waiting/Confirmed/Please check), US-13.6 ("Samples this month", counts only, never money), US-02.x partner_admin-only Users (US-15.3 actor gate),
//      PU-1 "403 auth.mfa_required -> /auth/mfa", PX-1 account (name, masked e-mail, role, organisation, 2-step, sign out). Copy rules: never "commission".
// SEAMS: pages (app)/referrers/page.tsx, (app)/users/page.tsx, (app)/account/page.tsx. Role/permission come from GET /v1/partners/me (permissions[]): partners.referrer.manage = admin doctor actions,
//  partners.partner_user.manage = Users screen. PF-1 GET /v1/partners/referrers; PU-1 GET /v1/partners/users (not called at all for a user without the permission); PX-1 GET /v1/partners/me.
//  Dialogs (Add doctor / Invite user), row menus and ConfirmDialogs are closed in static markup -> covered by tests/e2e/partner-screens.spec.ts.
import { createElement } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMBER_PERMS, attempt, boot, buttons, calls, chipTone, failing, headers, helpKey, id, primaries, renderPage, resetApi, restoreFetch, seen, serve, title, urls } from './kit';
import { AUTH, run } from '../t05/harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => ({ ...(await import('../t05/harness')).navigationMock, useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/referrers', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never) }));

beforeAll(boot);
afterAll(restoreFetch);
beforeEach(() => { resetApi(); urls.length = 0; });
const list = (rows: unknown[]) => ({ data: rows, page: { limit: 50 } });
const ref = (n: number, o: Record<string, unknown> = {}) => ({ id: id(n, 500), display_name: `Dr Synthetic ${n}`, qualification: 'MD', registration_council: 'NMC', registration_no: `1000${n}`, is_active: true, mapping_state: 'unmapped', samples_this_month: 30, version: 1, ...o });
const usr = (n: number, o: Record<string, unknown> = {}) => ({ id: id(n, 600), display_name: `Synthetic User ${n}`, email_masked: `u${n}***@example.test`, partner_role: 'partner_member', status: 'active', mfa_enrolled: false, last_login_at: '2026-11-13T04:00:00.000Z', version: 1, ...o });

describe('PF-1 Referring doctors (US-13.1/13.2/13.3/13.6)', () => {
  const rows = [ref(1), ref(2, { mapping_state: 'mapped' }), ref(3, { mapping_state: 'rejected' }), ref(4, { is_active: false })];
  it('title, helpKey, specified columns, lab-check words with tones, samples count', async () => {
    serve({ '/v1/partners/referrers': list(rows) });
    const html = await renderPage('referrers');
    expect(title(html)).toBe('Referring doctors');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const h of ['Name', 'Qualification', 'Council reg. no.', 'Lab check', 'Samples this month', 'Active']) expect(headers(html), h).toContain(h);
    expect(chipTone(html, 'Waiting for lab')).toBe('neutral');
    expect(chipTone(html, 'Confirmed')).toBe('success');
    expect(chipTone(html, 'Please check')).toBe('warning');
    expect(html).toContain('Dr Synthetic 1');
    expect(html).toMatch(/>30</);
  });
  it('rejected rows say "Edit to send again"; other rows do not', async () => {
    serve({ '/v1/partners/referrers': list([ref(3, { mapping_state: 'rejected' })]) });
    expect(await renderPage('referrers')).toContain('Edit to send again');
    serve({ '/v1/partners/referrers': list([ref(1), ref(2, { mapping_state: 'mapped' })]) });
    expect(await renderPage('referrers')).not.toContain('Edit to send again');
  });
  it('partner_admin: "Add doctor" action and an Active switch per row', async () => {
    serve({ '/v1/partners/referrers': list(rows) });
    const html = await renderPage('referrers');
    expect(buttons(html).some((b) => b.text.includes('Add doctor'))).toBe(true);
    expect((html.match(/role="switch"/g) ?? []).length).toBe(rows.length);
    expect(primaries(html)).toBeLessThanOrEqual(1);
  });
  it('partner_member: read-only (no Add doctor, no switches; Active is text)', async () => {
    serve({ '/v1/partners/referrers': list(rows) }, { role: 'partner_member' });
    const html = await renderPage('referrers');
    expect(buttons(html).some((b) => b.text.includes('Add doctor'))).toBe(false);
    expect(html).not.toMatch(/role="switch"/);
    expect(html).toMatch(/>(Yes|Active)</);
  });
  it('copy: counts only, never "commission" or money (US-13.6 / 04 L19)', async () => {
    serve({ '/v1/partners/referrers': list(rows) });
    const html = await renderPage('referrers');
    expect(html).not.toMatch(/commission/i);
    expect(html).not.toMatch(/\bRs\.|\bNPR\b/);
  });
  it('failure: ErrorState without upstream detail; names escaped (ST16); read-only render', async () => {
    serve({ '/v1/partners/referrers': list([ref(1, { display_name: '<img src=x onerror=alert(1)>' })]) });
    expect(await renderPage('referrers')).not.toContain('<img src=x');
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
    serve({ '/v1/partners/referrers': failing(500) });
    const o = await attempt('referrers');
    if (o.err) expect(String(o.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
    else { expect(o.html).toContain('data-tone="danger"'); expect(o.html).not.toContain('UPSTREAM-SECRET-DETAIL'); }
  });
});

describe('PU-1 Users (partner_admin only)', () => {
  const rows = [usr(1, { partner_role: 'partner_admin', mfa_enrolled: true }), usr(2, { status: 'invited', last_login_at: undefined }), usr(3, { status: 'deactivated' })];
  it('title, helpKey, specified columns, masked e-mail verbatim, role badges, status words with tones, two-step Yes/No', async () => {
    serve({ '/v1/partners/users': list(rows) });
    const html = await renderPage('users');
    expect(title(html)).toBe('Users');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const h of ['Name', 'Email', 'Role', 'Status', 'Two-step sign-in', 'Last sign-in']) expect(headers(html), h).toContain(h);
    expect(html).toContain('u1***@example.test');
    expect(html).toMatch(/>Admin</);
    expect(html).toMatch(/>Member</);
    expect(chipTone(html, 'Invitation sent')).toBe('info');
    expect(chipTone(html, 'Active')).toBe('success');
    expect(chipTone(html, 'Deactivated')).toBe('neutral');
    expect(html).toMatch(/>Yes</);
    expect(html).toMatch(/>No</);
  });
  it('"Invite user" is the single primary action', async () => {
    serve({ '/v1/partners/users': list(rows) });
    const html = await renderPage('users');
    expect(buttons(html).some((b) => b.text.includes('Invite user'))).toBe(true);
    expect(primaries(html)).toBeLessThanOrEqual(1);
  });
  it('a user without partners.partner_user.manage never gets the list: no /users call, no user rows', async () => {
    serve({ '/v1/partners/users': list(rows) }, { role: 'partner_member', perms: MEMBER_PERMS });
    const o = await attempt('users');
    expect(calls('/v1/partners/users')).toEqual([]);
    expect(String(o.err ?? o.html)).not.toContain('u1***@example.test');
    expect(String(o.err ?? o.html)).toMatch(/NEXT_NOT_FOUND|forbidden|not allowed|permission|data-tone="danger"/i);
  });
  it('403 auth.mfa_required -> redirect to /auth/mfa', async () => {
    serve({ '/v1/partners/users': failing(403, 'auth.mfa_required') });
    const r = await run(() => renderPage('users'));
    expect(r.redirect ?? '').toMatch(/^\/auth\/mfa(\?|$)/);
  });
  it('e-mail / name escaped (ST16); no write while rendering', async () => {
    serve({ '/v1/partners/users': list([usr(1, { display_name: '<script>alert(1)</script>', email_masked: '<img src=x onerror=alert(2)>' })]) });
    const html = await renderPage('users');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
  });
  it('failure: ErrorState without upstream detail', async () => {
    serve({ '/v1/partners/users': failing(500) });
    const o = await attempt('users');
    if (o.err) expect(String(o.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
    else { expect(o.html).toContain('data-tone="danger"'); expect(o.html).not.toContain('UPSTREAM-SECRET-DETAIL'); }
  });
});

describe('PX-1 Account', () => {
  it('name, role, organisation, two-step state, "Sign out" and "Sign out of all devices"', async () => {
    serve({});
    const html = await renderPage('account');
    expect(title(html)).toBe('Account');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const t of ['Name', 'Email', 'Role', 'Organisation', 'Two-step sign-in']) expect(html, t).toContain(t);
    expect(html).toContain('Synthetic Admin');
    expect(html).toContain('Synthetic Partner X');
    expect(html).toMatch(/>Admin</);
    expect(buttons(html).some((b) => b.text === 'Sign out')).toBe(true);
    expect(html).toContain('Sign out of all devices');
    expect(primaries(html)).toBeLessThanOrEqual(1);
  });
  it('a member sees "Member"; two-step off offers enrolment, on offers removal', async () => {
    serve({}, { role: 'partner_member', mfa: false });
    let html = await renderPage('account');
    expect(html).toMatch(/>Member</);
    expect(html).toMatch(/[Ee]nrol|Set up/);
    serve({}, { mfa: true });
    html = await renderPage('account');
    expect(html).toMatch(/[Rr]emove/);
  });
  it('no token, session id or cookie value in the markup; user-supplied names escaped', async () => {
    serve({});
    const html = await renderPage('account');
    expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|psid-existing/);
    const { me } = await import('./kit');
    const evil = me();
    evil.user.display_name = '<script>alert(1)</script>';
    serve({ '/v1/partners/me': evil });
    expect(await renderPage('account')).not.toContain('<script>alert');
  });
  it('a suspended partner (403 partners.partner_inactive) gets an ErrorState and no data', async () => {
    serve({ '/v1/partners/me': failing(403, 'partners.partner_inactive') });
    const o = await attempt('account');
    expect(String(o.err ?? o.html)).not.toMatch(/UPSTREAM-SECRET-DETAIL|Synthetic Admin/);
  });
});
