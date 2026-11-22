// @vitest-environment jsdom
// T0D-FIX-10 (LD-455, D-219; founder 2026-11-22 21:40 NPT: invitation links expired, the admin needs a resend option).
// Proves: (1) /admin/users row action "Resend invitation" only for status Invited + identity.user.manage, same confirm dialog as the detail page,
// one POST .../resend-invitation with an Idempotency-Key, "Invitation sent." / inline error with the reference; (2) the one-line lifetime copy on the
// users page and the user detail page, built from ONE constant INVITE_LINK_MINUTES = 60 in features/admin/lib.ts (never the 72 h expires_at);
// (3) the same sentence after inviting a user; (4) the three help files carry it. Synthetic data only; no outside provider.
// ASSUMED selectors: the row action is a button named /resend invitation/i inside the row, OR a row menu button (/actions|more|row/i) whose menuitem is /resend invitation/i.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ID, USER_M, USER_M2, FEATURE, api, callsTo, resetApi, routes, json, problem, page, userSummary, userDetail,
  show, gridNamed, rowTexts, dataRows, pageText, norm, router,
} from './t20.harness';
import { INVITE_LINK_MINUTES } from '../lib';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterAll(() => api.close());
beforeEach(() => resetApi());
afterEach(() => cleanup());

const LIST = `${ID}/users`;
const INVITED_M = USER_M2;
const SENTENCE = 'Invitation links work for about 60 minutes. If one has expired, use Resend invitation.';
const RESEND = `${LIST}/${INVITED_M}/resend-invitation`;
const REF = '01a1a98a-ac40-7000-8000-00000000f10a';
const DIALOG_BODY = 'A new invitation email is sent; the old link stops working.';
const MANAGE = ['identity.user.read', 'identity.user.manage'];

const people = [
  userSummary({ membership_id: USER_M, display_name: 'Synthetic Active Asha', status: 'active' }),
  userSummary({ membership_id: INVITED_M, display_name: 'Synthetic Invited Ila', status: 'invited' }),
  userSummary({ membership_id: 'm4', display_name: 'Synthetic Locked Lal', status: 'active', is_locked: true }),
  userSummary({ membership_id: 'm5', display_name: 'Synthetic Deactivated Dev', status: 'deactivated' }),
];
const rowOf = (name: RegExp) => dataRows(gridNamed(/users/i)).find((r) => name.test(norm(r.textContent)))!;
const dlg = async () => screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));

/** True when the row offers Resend invitation, by button or by its row menu. Leaves any opened menu closed. */
async function rowOffersResend(user: ReturnType<typeof userEvent.setup>, row: HTMLElement): Promise<boolean> {
  if (within(row).queryByRole('button', { name: /resend invitation/i })) return true;
  const trigger = within(row).queryByRole('button', { name: /actions|more|row/i });
  if (!trigger) return false;
  await user.click(trigger);
  const found = screen.queryByRole('menuitem', { name: /resend invitation/i }) !== null;
  await user.keyboard('{Escape}');
  return found;
}
async function openResend(user: ReturnType<typeof userEvent.setup>, row: HTMLElement) {
  const direct = within(row).queryByRole('button', { name: /resend invitation/i });
  if (direct) { await user.click(direct); return; }
  await user.click(within(row).getByRole('button', { name: /actions|more|row/i }));
  await user.click(await screen.findByRole('menuitem', { name: /resend invitation/i }));
}

describe('INVITE_LINK_MINUTES — one honest constant (D-219, LD-455)', () => {
  it('is 60', () => { expect(INVITE_LINK_MINUTES).toBe(60); });
  it('lib.ts declares it once with a comment that points at GOTRUE_MAILER_OTP_EXP', () => {
    const src = readFileSync(join(FEATURE, 'lib.ts'), 'utf8');
    const lines = src.split('\n');
    const at = lines.findIndex((l) => /export const INVITE_LINK_MINUTES\s*=\s*60\b/.test(l));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(Math.max(0, at - 4), at + 1).join('\n')).toMatch(/GOTRUE_MAILER_OTP_EXP/);
  });
  it('the three components never hard-code 60 or 72 hours (the number comes from the constant)', () => {
    for (const f of ['UsersTable.tsx', 'UserDetailView.tsx', 'InviteForm.tsx']) {
      const src = readFileSync(join(FEATURE, 'components', f), 'utf8');
      expect(src, f).not.toMatch(/\b60 minutes\b|\b72\s*(h|hours)\b|INVITE_TTL/i);
    }
  });
});

describe('/admin/users — Resend invitation row action', () => {
  beforeEach(() => {
    resetApi(MANAGE);
    routes[`GET ${LIST}`] = json(page(people));
    routes[`POST ${RESEND}`] = json({}, 202);
  });

  it('Invited row with identity.user.manage has Resend invitation; Active, Locked and Deactivated rows do not', async () => {
    await show('users');
    const user = userEvent.setup();
    expect(await rowOffersResend(user, rowOf(/Invited Ila/))).toBe(true);
    expect(await rowOffersResend(user, rowOf(/Active Asha/))).toBe(false);
    expect(await rowOffersResend(user, rowOf(/Locked Lal/))).toBe(false);
    expect(await rowOffersResend(user, rowOf(/Deactivated Dev/))).toBe(false);
  });

  it('without identity.user.manage no row offers it, and the list still renders', async () => {
    resetApi(['identity.user.read']);
    routes[`GET ${LIST}`] = json(page(people));
    await show('users');
    const user = userEvent.setup();
    expect(rowTexts(gridNamed(/users/i)).some((t) => /Invited Ila/.test(t))).toBe(true);
    expect(await rowOffersResend(user, rowOf(/Invited Ila/))).toBe(false);
    expect(screen.queryByRole('menuitem', { name: /resend invitation/i })).toBeNull();
    expect(callsTo('POST', RESEND)).toHaveLength(0);
  });

  it('opens the same confirm dialog as the detail page; Cancel sends nothing', async () => {
    await show('users');
    const user = userEvent.setup();
    await openResend(user, rowOf(/Invited Ila/));
    const d = await dlg();
    expect(norm(d.textContent)).toContain('Resend invitation?');
    expect(norm(d.textContent)).toContain(DIALOG_BODY);
    await user.click(within(d).getByRole('button', { name: /cancel/i }));
    expect(callsTo('POST', RESEND)).toHaveLength(0);
  });

  it('Confirm → exactly ONE POST /resend-invitation with an Idempotency-Key and the bearer token; shows "Invitation sent."', async () => {
    await show('users');
    const user = userEvent.setup();
    await openResend(user, rowOf(/Invited Ila/));
    await user.click(within(await dlg()).getByRole('button', { name: /^resend$/i }));
    await waitFor(() => expect(callsTo('POST', RESEND)).toHaveLength(1));
    const c = callsTo('POST', RESEND)[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic-t20');
    expect(await screen.findByText(/Invitation sent\./)).toBeTruthy();
    expect(callsTo('POST', RESEND)).toHaveLength(1);
  });

  it('failure shows the error with its reference inside the dialog and never "Invitation sent."', async () => {
    routes[`POST ${RESEND}`] = () => problem('common.internal', 500, { request_id: REF });
    await show('users');
    const user = userEvent.setup();
    await openResend(user, rowOf(/Invited Ila/));
    await user.click(within(await dlg()).getByRole('button', { name: /^resend$/i }));
    await waitFor(() => expect(pageText()).toContain(REF));
    expect(pageText()).not.toMatch(/Invitation sent\./);
    expect(pageText()).not.toMatch(/Error:|at \w+ \(|stack/);
    expect(callsTo('POST', RESEND)).toHaveLength(1);
  });

  it('bad input: a hostile membership_id never reaches the api as a path (only the row id is posted)', async () => {
    routes[`GET ${LIST}`] = json(page([userSummary({ membership_id: '../x/lock', display_name: 'Synthetic Hostile Hal', status: 'invited' })]));
    await show('users');
    const user = userEvent.setup();
    if (await rowOffersResend(user, rowOf(/Hostile Hal/))) {
      await openResend(user, rowOf(/Hostile Hal/));
      await user.click(within(await dlg()).getByRole('button', { name: /^resend$/i }));
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(callsTo('POST', `${LIST}/../x/lock/resend-invitation`)).toHaveLength(0);
    expect(callsTo('POST', `${LIST}/x/lock/resend-invitation`)).toHaveLength(0);
  });
});

describe('lifetime line — users page and user detail page', () => {
  it('users page shows the sentence when the list has an Invited user', async () => {
    resetApi(MANAGE);
    routes[`GET ${LIST}`] = json(page(people));
    await show('users');
    expect(pageText()).toContain(SENTENCE);
  });

  it('users page does not show it when nobody is Invited', async () => {
    resetApi(MANAGE);
    routes[`GET ${LIST}`] = json(page([people[0]!, people[2]!, people[3]!]));
    await show('users');
    expect(pageText()).not.toMatch(/Invitation links work/);
  });

  describe('user detail', () => {
    const P = { params: { membership_id: INVITED_M } };
    const ONE = `${LIST}/${INVITED_M}`;
    beforeEach(() => {
      resetApi(MANAGE);
      routes[`GET ${ONE}`] = json(userDetail({ membership_id: INVITED_M, status: 'invited' }));
      routes[`GET ${ID}/sessions`] = json(page([]));
      routes[`GET ${ID}/audit-entries`] = json(page([]));
      routes[`POST ${ONE}/resend-invitation`] = json({}, 202);
    });

    it('Invited user: the sentence is shown and no text claims the invitation (72 h expires_at) is when the link stops working', async () => {
      await show('users/[membership_id]', P);
      expect(pageText()).toContain(SENTENCE);
      expect(pageText()).not.toMatch(/\b72\b/);
      expect(pageText()).not.toMatch(/invitation (link )?(expires|expiry)|link (expires|stops working) (on|at|in)/i);
    });

    it('Active user: the sentence is not shown', async () => {
      routes[`GET ${ONE}`] = json(userDetail({ membership_id: INVITED_M, status: 'active' }));
      await show('users/[membership_id]', P);
      expect(pageText()).not.toMatch(/Invitation links work/);
    });

    it('Resend invitation from the Actions menu: same dialog, ONE POST with an Idempotency-Key, "Invitation sent."', async () => {
      await show('users/[membership_id]', P);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /actions|more/i }));
      await user.click(await screen.findByRole('menuitem', { name: /resend invitation/i }));
      const d = await dlg();
      expect(norm(d.textContent)).toContain(DIALOG_BODY);
      await user.click(within(d).getByRole('button', { name: /^resend$/i }));
      await waitFor(() => expect(callsTo('POST', `${ONE}/resend-invitation`)).toHaveLength(1));
      expect(callsTo('POST', `${ONE}/resend-invitation`)[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(await screen.findByText(/Invitation sent\./)).toBeTruthy();
    });
  });
});

describe('/admin/users/new — success message after inviting', () => {
  it('carries the lifetime sentence (toast or success view) and the form still returns to the list', async () => {
    resetApi(MANAGE);
    routes[`POST ${LIST}`] = () => json(userDetail({ status: 'invited' }), 201)();
    await show('users/new');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email/i), 'test.user.0099@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'Synthetic Tika Rai');
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /front desk/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByLabelText(/centres/i));
    await user.click(await screen.findByRole('option', { name: new RegExp('Synthetic Centre A1', 'i') }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(callsTo('POST', LIST)).toHaveLength(1));
    await waitFor(() => expect(pageText()).toContain(SENTENCE));
    expect(router.push.mock.calls.length + router.replace.mock.calls.length).toBeGreaterThan(0);
  });

  it('a failed invite does not claim success or show the sentence as a success message', async () => {
    resetApi(MANAGE);
    routes[`POST ${LIST}`] = () => problem('common.internal', 500, { request_id: REF });
    await show('users/new');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email/i), 'test.user.0098@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'Synthetic Tika Rai');
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /front desk/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('radio', { name: /all centres/i }));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(pageText()).toContain(REF));
    expect(pageText()).not.toContain(SENTENCE);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('help files carry the sentence', () => {
  for (const f of ['users', 'user-detail', 'user-new']) {
    it(`help/${f}.md`, () => {
      expect(norm(readFileSync(join(FEATURE, 'help', `${f}.md`), 'utf8'))).toContain(SENTENCE);
    });
  }
});
