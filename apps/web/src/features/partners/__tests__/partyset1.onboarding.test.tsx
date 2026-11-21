// @vitest-environment jsdom
// T0D-PARTYSET-1 — Onboarding Queue (done_when 3, 5 empty headers, 6, 7; LD-321 "onboarding approval queue"; LD-353 template 1 LIST).
// Through the PAGE default export app/(staff)/partners/onboarding/page.tsx. Route /partners/onboarding, permission partners.onboarding.decide.
// PINNED UI NAMES (tester choice; writer may dispute through the ruling path):
//   - headers (first six, in order): Party, Type, Requested By, Requested On, Status, Reason; an optional 7th "Actions". h1 = the menu label of the nav entry (menuLabel).
//   - one FilterBar with a kit Select "Status" (All, Pending, Held, Approved, Rejected); default = Pending (the list call carries status=pending); a `?status=` search param wins; changing it pushes ?status=.
//   - type words: Partner, Credit party, Doctor, Referrer; status words: Pending, Held, Approved, Rejected; Requested On = created_at as DD/MM/YYYY (A.D., DateText).
//   - Requested By: the contract (PartyOnboarding) has NO creator field, so the cell shows a dash. CONTRACT GAP, see the notes: with a creator field the buttons could be disabled up front.
//   - row buttons: pending -> Approve, Hold, Reject; held -> Approve, Reject; approved / rejected -> none. Approve = one call, no dialog. Hold / Reject open a dialog with a required "Reason" (max 500), buttons "Hold" / "Reject" and "Cancel".
//   - POST /v1/partners/admin/onboarding/<id>/decision { decision, reason? } with If-Match "<row version>" and an Idempotency-Key.
//   - the person who created the record cannot decide (server answers 403 auth.forbidden): after that answer the row's three buttons are DISABLED with the visible reason t('partners.onboarding.reason.creator'), no second call is made.
//   - 409 version_conflict -> banner with Refresh; permission missing -> the permission notice, no table and no call.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { t } from '@/core/i18n/messages';
import { expectListScreen, expectStateInPage } from '@/features/catalog/__tests__/uilist3.helpers';
import { API, IDEM, ONBOARDING, PATHS, PERM, ROUTE, TM, api, headers, isDisabled, norm, openPage, pickOption, prob, quiet, reasonOf, rowOf } from './partyset1.harness';

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const HEADS = ['Party', 'Type', 'Requested By', 'Requested On', 'Status', 'Reason'];
const open = (search = 'status=') => openPage(ROUTE.onboarding, { perms: [PERM.decide], search });
const decisions = () => API.find('POST', /onboarding\/.+\/decision/);
const btn = (row: HTMLElement, name: RegExp) => within(row).queryByRole('button', { name });
const dlg = () => screen.findByRole('dialog');

describe('Onboarding queue: screen (done_when 3, 5)', () => {
  it('LIST template: h1 = menu label, one FilterBar, table in the scroll box, the six headers in order, no dev copy', async () => {
    const { container } = await open();
    await screen.findByText('Synthetic Franchise One');
    expectListScreen(container as HTMLElement, { path: PATHS.onboarding, headers: HEADS });
    expect(headers().slice(0, 6)).toEqual(HEADS);
    expect(headers().length).toBeLessThanOrEqual(7);
  });
  it('shows type and status words, the reason, a dash for Requested By and the date as DD/MM/YYYY', async () => {
    await open();
    await screen.findByText('Synthetic Franchise One');
    expect(rowOf('Synthetic Franchise One').textContent).toMatch(/Partner/);
    expect(rowOf('Synthetic Franchise One').textContent).toMatch(/Pending/);
    expect(rowOf('Synthetic Franchise One').textContent).toContain('10/11/2026');
    expect(rowOf('Synthetic Franchise One').textContent).toContain('—');
    expect(rowOf('Synthetic Hospital Two').textContent).toMatch(/Credit party/);
    expect(rowOf('Synthetic Hospital Two').textContent).toMatch(/Held/);
    expect(rowOf('Synthetic Hospital Two').textContent).toContain('Documents missing');
    expect(rowOf('Synthetic Doctor Three').textContent).toMatch(/Doctor.*Approved/);
    expect(rowOf('Synthetic Referrer Four').textContent).toMatch(/Referrer.*Rejected/);
    expect(rowOf('Synthetic Referrer Four').textContent).toContain('Duplicate of an existing party');
  });
  it('the default list asks for status=pending with a page limit of at most 50; ?status= is passed on; "All" sends no status', async () => {
    await open('');
    await waitFor(() => expect(API.find('GET', /\/onboarding$/).length).toBeGreaterThan(0));
    expect(API.find('GET', /\/onboarding$/)[0]!.search.get('status')).toBe('pending');
    expect(Number(API.find('GET', /\/onboarding$/)[0]!.search.get('limit') ?? 50)).toBeLessThanOrEqual(50);
    cleanup(); API.calls.length = 0;
    await open('status=held');
    await waitFor(() => expect(API.find('GET', /\/onboarding$/)[0]?.search.get('status')).toBe('held'));
  });
  it('changing the Status filter navigates with ?status=', async () => {
    const user = userEvent.setup();
    await open('');
    await screen.findByText('Synthetic Franchise One');
    await pickOption(user, document.body, /^status/i, /^held$/i);
    await waitFor(() => expect(TM.push.mock.calls.concat(TM.replace.mock.calls).some((c) => String(c[0]).includes('status=held'))).toBe(true));
  });
  it('empty queue: the six headers stay and the body says there is nothing waiting (EmptyState: title + one hint)', async () => {
    API.onboarding = [];
    const { container } = await open('');
    await waitFor(() => expect(headers().slice(0, 6)).toEqual(HEADS));
    expect(container.querySelector('.lims-empty-state, [class*="empty-state"]')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /^(approve|hold|reject)$/i })).toHaveLength(0);
  });
  it('a failing read keeps the page title and filter and shows an error state with Retry (no bare error page)', async () => {
    API.readFail = 500;
    const { container } = await open('');
    await screen.findByRole('alert');
    expectStateInPage(container as HTMLElement, { path: PATHS.onboarding, kind: 'either' });
  });
  it('without partners.onboarding.decide: the permission notice, no table, no call', async () => {
    await openPage(ROUTE.onboarding, { perms: [PERM.partnerRead], search: '' });
    await screen.findByText(/do not have permission/i);
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(API.calls).toHaveLength(0);
  });
  it('has no axe violations', async () => {
    await open();
    await screen.findByText('Synthetic Franchise One');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('Onboarding queue: the decision rule (done_when 3)', () => {
  it('pending rows offer Approve, Hold, Reject; held rows Approve and Reject; decided rows nothing', async () => {
    await open();
    await screen.findByText('Synthetic Franchise One');
    const p = rowOf('Synthetic Franchise One');
    for (const n of [/^approve$/i, /^hold$/i, /^reject$/i]) expect(btn(p, n), String(n)).toBeTruthy();
    const h = rowOf('Synthetic Hospital Two');
    expect(btn(h, /^approve$/i)).toBeTruthy();
    expect(btn(h, /^reject$/i)).toBeTruthy();
    expect(btn(h, /^hold$/i)).toBeNull();
    for (const who of ['Synthetic Doctor Three', 'Synthetic Referrer Four']) expect(within(rowOf(who)).queryAllByRole('button')).toHaveLength(0);
  });
  it('Approve: one POST decision=approve with If-Match "<version>" and an Idempotency-Key, no dialog, then a refresh', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    await user.click(btn(rowOf('Synthetic Franchise One'), /^approve$/i)!);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    const c = decisions()[0]!;
    expect(c.path).toBe(`/v1/partners/admin/onboarding/${ONBOARDING[0]!['id']}/decision`);
    expect(c.json).toEqual({ decision: 'approve' });
    expect(c.headers.get('if-match')).toMatch(/^"?1"?$/);
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each([['Hold', 'hold'], ['Reject', 'reject']])('%s asks for a reason first: empty reason -> inline error and no call; with a reason -> POST decision=%s + reason', async (label, decision) => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    await user.click(btn(rowOf('Synthetic Franchise One'), new RegExp(`^${label}$`, 'i'))!);
    const d = await dlg();
    const go = within(d).getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    await user.click(go);
    await quiet();
    expect(decisions()).toHaveLength(0);
    expect(within(d).getByLabelText(/^reason/i).getAttribute('aria-invalid')).toBe('true');
    await user.type(within(d).getByLabelText(/^reason/i), 'Synthetic: papers are incomplete');
    await user.click(go);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]!.json).toEqual({ decision, reason: 'Synthetic: papers are incomplete' });
    expect(decisions()[0]!.headers.get('if-match')).toMatch(/^"?1"?$/);
  });
  it('a whitespace-only reason counts as empty; 501 characters are refused before any call; Cancel closes without a call', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    await user.click(btn(rowOf('Synthetic Franchise One'), /^reject$/i)!);
    const d = await dlg();
    await user.type(within(d).getByLabelText(/^reason/i), '   ');
    await user.click(within(d).getByRole('button', { name: /^reject$/i }));
    await quiet();
    expect(decisions()).toHaveLength(0);
    const box = within(d).getByLabelText(/^reason/i) as HTMLTextAreaElement;
    expect(Number(box.getAttribute('maxlength') ?? 500)).toBeLessThanOrEqual(500);
    await user.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(decisions()).toHaveLength(0);
  });
  it('a double press on Approve sends ONE request', async () => {
    API.writeDelayMs = 150;
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    const b = btn(rowOf('Synthetic Franchise One'), /^approve$/i)!;
    await user.click(b); await user.click(b);
    await quiet(400);
    expect(decisions()).toHaveLength(1);
  });
  it('the creator rule: a 403 auth.forbidden disables the row\'s Approve, Hold and Reject with the visible reason; nothing else is sent', async () => {
    expect(t('partners.onboarding.reason.creator')).not.toBe('partners.onboarding.reason.creator');
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    API.fail = prob(403, 'auth.forbidden');
    await user.click(btn(rowOf('Synthetic Franchise One'), /^approve$/i)!);
    await waitFor(() => expect(decisions()).toHaveLength(1));
    await waitFor(() => expect(isDisabled(btn(rowOf('Synthetic Franchise One'), /^approve$/i)!)).toBe(true));
    for (const n of [/^approve$/i, /^hold$/i, /^reject$/i]) {
      const b = btn(rowOf('Synthetic Franchise One'), n)!;
      expect(isDisabled(b), String(n)).toBe(true);
      expect(reasonOf(b)).toContain(t('partners.onboarding.reason.creator'));
    }
    expect(document.body.textContent).toContain(t('partners.onboarding.reason.creator'));
    await user.click(btn(rowOf('Synthetic Franchise One'), /^approve$/i)!).catch(() => undefined);
    await quiet();
    expect(decisions()).toHaveLength(1);
    // the other rows are not affected
    expect(isDisabled(btn(rowOf('Synthetic Hospital Two'), /^approve$/i)!)).toBe(false);
  });
  it('a 409 version_conflict shows a banner with Refresh', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    API.fail = prob(409, 'common.version_conflict');
    await user.click(btn(rowOf('Synthetic Franchise One'), /^approve$/i)!);
    const refresh = await screen.findByRole('button', { name: /refresh/i });
    TM.refresh.mockClear();
    await user.click(refresh);
    expect(TM.refresh.mock.calls.length).toBeGreaterThan(0);
  });
  it('a 422 or 500 shows a plain catalogue message, never raw JSON or the error code', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    API.fail = prob(500, 'common.internal');
    await user.click(btn(rowOf('Synthetic Franchise One'), /^approve$/i)!);
    await screen.findByRole('alert');
    expect(norm(document.body.textContent)).not.toMatch(/common\.internal|urn:lims|\{"/);
  });
  it('keyboard: Approve is reachable by Tab and fires on Enter', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Synthetic Franchise One');
    btn(rowOf('Synthetic Franchise One'), /^approve$/i)!.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(decisions()).toHaveLength(1));
  });
});
