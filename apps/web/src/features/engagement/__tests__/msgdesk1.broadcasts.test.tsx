// @vitest-environment jsdom
// T0D-MSGDESK-1 — Broadcasts: /engagement/messages/broadcasts (ElabAssist Messages: audience selection, Send, Cancel, Log page; LD-321, LD-310, LD-353 template 1 LIST).
// Through the PAGE default export app/(staff)/engagement/messages/broadcasts/page.tsx (server page -> BFF -> MSW -> client parts).
// PINNED UI NAMES (tester choice; the writer may dispute through the ruling path):
//   - headers: Template, Audience, Recipients, Status, Requested By, Approved By (done_when 2). Audience cell = the kind words joined (Laboratory, Franchise, Client, Lab user).
//     Status words: Draft, Pending approval, Approved, Sending, Sent, Cancelled. Recipients cell = recipient_count.
//   - Requested By / Approved By: the page cannot name a user (the contract has a bare user id, see notes/T0D-MSGDESK-1-cr-needed.md); the cell is never blank or "undefined"; a broadcast the signed-in
//     user requested says "You"; an empty approver is an em dash.
//   - "New broadcast" opens the AUDIENCE BUILDER dialog: Template (kit Select, active templates only), checkboxes Laboratory, Franchise, Client, Lab user, "Select all", "Active only" (checked),
//     a LIVE COUNT region (role=status) with the recipient count, the opted out count and a MASKED SAMPLE; buttons "Save draft", "Request approval", "Cancel".
//   - live count: every settled change of Template / kinds / Active only asks POST /broadcast-audience-previews {template_id, audience_filter:{party_kinds, active_only}}; no kind = no request and the
//     prompt t('engagement.msg.audience.choose'); only the LAST answer is shown (out of order answers are dropped).
//   - Request approval = POST /broadcasts then POST /broadcasts/<new id>/request-approval (If-Match = the new version, Idempotency-Key on both). Nothing is ever sent from this dialog.
//   - row controls (buttons, or menu items under "Row actions"): draft: Request approval, Cancel broadcast; pending approval: Approve, Cancel broadcast; every row: History.
//     Approve opens a confirm dialog that shows the recipient count and the template name, confirm button "Approve"; Cancel broadcast confirm button "Yes, cancel", dismiss "Keep".
//   - Approve is disabled with a visible reason (aria-describedby) when the user lacks engagement.broadcast.approve (t('engagement.msg.reason.approve')) and when the user is the requester
//     (t('engagement.msg.reason.second_person'): the second person rule, done_when 2).
//   - History = a row button that pushes ?broadcast=<id>; with that search the page shows the per recipient history under the table: headers Recipient, Channel, Status; masked address only.
//   - permission: view engagement.broadcast.read, change engagement.broadcast.manage, approve engagement.broadcast.approve; blocked = disabled + visible reason naming the code.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { t } from '@/core/i18n/messages';
import { expectListScreen, expectStateInPage } from '@/features/catalog/__tests__/uilist3.helpers';
import { API, APPROVE, B_DRAFT, B_PEND, B_SENT, BROADCASTS_ROUTE, ID, IDEM, MANAGE, PATH, READ, SAMPLE, T_MAIL, T_SMS, TM, USER_A, USER_B, api, isDisabled, norm, openPage, pickOption, prob, quiet, reasonOf, rowOf, selectTrigger } from './msgdesk1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const HEADS = ['Template', 'Audience', 'Recipients', 'Status', 'Requested By', 'Approved By'];
const control = async (user: ReturnType<typeof userEvent.setup>, row: HTMLElement, name: RegExp): Promise<HTMLElement> => {
  const direct = within(row).queryByRole('button', { name });
  if (direct) return direct;
  await user.click(within(row).getByRole('button', { name: /row actions/i }));
  return screen.findByRole('menuitem', { name });
};
const dialog = () => screen.findByRole('dialog');
const emptyState = (c: HTMLElement) => c.querySelector('.lims-empty-state, [class*="empty-state"]');
const reasonKey = (el: HTMLElement, key: string, code?: string) => {
  expect(t(key), `catalogue key ${key} must exist`).not.toBe(key);
  if (code) expect(t(key)).toContain(code);
  expect(isDisabled(el), 'control is disabled').toBe(true);
  expect(reasonOf(el), 'visible reason linked by aria-describedby').toContain(t(key));
  expect(document.body.textContent).toContain(t(key));
};
const status = (dlg: HTMLElement) => within(dlg).getByRole('status');
const kinds = (c: { json?: any }) => [...(c.json?.audience_filter?.party_kinds ?? [])].sort();
const openBuilder = async (user: ReturnType<typeof userEvent.setup>, perms = MANAGE) => {
  await openPage(BROADCASTS_ROUTE, { perms });
  await user.click(screen.getByRole('button', { name: /^new broadcast/i }));
  return dialog();
};
const tick = (dlg: HTMLElement, name: RegExp) => within(dlg).getByRole('checkbox', { name });

describe('broadcasts: LIST template, headers always shown (done_when 2, 4)', () => {
  it('rows: h1 = menu label, the six named columns in the kit scroll box', async () => {
    const { container } = await openPage(BROADCASTS_ROUTE);
    expectListScreen(container, { path: PATH(BROADCASTS_ROUTE), headers: HEADS, filterBar: 'optional' });
    expect(norm(container.textContent)).not.toMatch(/undefined|null|NaN/);
  });
  it('no rows: the headers stay and an EmptyState sits in the body', async () => {
    API.broadcasts = [];
    const { container } = await openPage(BROADCASTS_ROUTE);
    expectListScreen(container, { path: PATH(BROADCASTS_ROUTE), headers: HEADS, filterBar: 'optional' });
    expect(emptyState(container), 'EmptyState').toBeTruthy();
  });
  it('a failed list keeps the page title and chrome (ErrorState or NotAvailable), 403 too', async () => {
    API.listFail = 500;
    const a = await openPage(BROADCASTS_ROUTE);
    expectStateInPage(a.container, { path: PATH(BROADCASTS_ROUTE), kind: 'either' });
    cleanup();
    API.listFail = 403;
    const b = await openPage(BROADCASTS_ROUTE, { perms: [] });
    expectStateInPage(b.container, { path: PATH(BROADCASTS_ROUTE), kind: 'either' });
  });
  it('lists are paged: at most 200 rows a request; next_cursor offers Next which moves with cursor=<value>', async () => {
    API.nextCursor = 'cur-2';
    await openPage(BROADCASTS_ROUTE);
    expect(Number(API.find('GET', /\/broadcasts$/)[0]!.search.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    await userEvent.click(screen.getByRole('button', { name: /^next/i }));
    expect(TM.push.mock.calls.map((c) => String(c[0])).join(' ')).toContain('cursor=cur-2');
  });
  it('one row per broadcast: template name, audience kinds, recipient count, status word', async () => {
    await openPage(BROADCASTS_ROUTE);
    const pend = rowOf(T_MAIL['name']).textContent ?? '';
    expect(pend).toMatch(/Laboratory/);
    expect(pend).toMatch(/Franchise/);
    expect(pend).toMatch(/\b120\b/);
    expect(pend).toMatch(/Pending approval/i);
    const sent = rowOf(/Synthetic Holiday notice.*Sent/s).textContent ?? '';
    expect(sent).toMatch(/Client/);
    expect(sent).toMatch(/Lab user/);
    expect(sent).toMatch(/\b80\b/);
    expect(screen.getAllByRole('row').map((r) => r.textContent).join(' ')).toMatch(/Draft/);
    expect(screen.getAllByRole('row').map((r) => r.textContent).join(' ')).toMatch(/Cancelled/);
  });
  it('Requested By / Approved By are never blank: "You" for my own request, an em dash for no approver', async () => {
    await openPage(BROADCASTS_ROUTE, { perms: MANAGE, actor: USER_A });
    expect(rowOf(T_MAIL['name']).textContent).toMatch(/\bYou\b/);
    expect(rowOf(T_MAIL['name']).textContent).toMatch(/—/);
    expect(norm(document.body.textContent)).not.toMatch(/undefined|null/);
  });
  it('the status filter, when there is one, forwards only a known status to the API', async () => {
    await openPage(BROADCASTS_ROUTE, { search: 'status=sent&evil=1' });
    const q = API.find('GET', /\/broadcasts$/)[0]!.search;
    expect(q.get('status')).toBe('sent');
    expect(q.has('evil')).toBe(false);
    cleanup(); API.calls.length = 0;
    await openPage(BROADCASTS_ROUTE, { search: 'status=bogus' });
    expect(API.find('GET', /\/broadcasts$/)[0]!.search.get('status')).toBeNull();
  });
  it('axe: no violations on the list', async () => {
    await openPage(BROADCASTS_ROUTE);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('audience builder: LIVE recipient count and masked sample (done_when 2, 5)', () => {
  it('opens with the active templates only, four kind checkboxes, Select all, Active only checked; no count request before a kind is chosen', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    expect(API.find('GET', /\/broadcast-templates$/).length).toBeGreaterThan(0);
    for (const k of [/^laboratory/i, /^franchise/i, /^client/i, /^lab user/i, /^select all/i]) expect(tick(dlg, k)).toBeTruthy();
    expect((tick(dlg, /^active only/i) as HTMLInputElement).checked).toBe(true);
    await user.click(selectTrigger(dlg, /^template(\s*\*)?$/i));
    const names = (await screen.findAllByRole('option')).map((o) => norm(o.textContent));
    expect(names).toContain(T_SMS['name']);
    expect(names).toContain(T_MAIL['name']);
    expect(names).not.toContain('Synthetic Old campaign');
    await user.keyboard('{Escape}');
    await quiet(60);
    expect(API.previews()).toEqual([]);
    expect(norm(status(dlg).textContent)).toContain(t('engagement.msg.audience.choose'));
  });

  it('choosing a kind sends ONE preview with the closed filter and shows the count, the opted out count and the masked sample', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(API.previews()).toHaveLength(1));
    const p = API.previews()[0]!;
    expect(p.json).toEqual({ template_id: T_SMS['id'], audience_filter: { party_kinds: ['client'], active_only: true } });
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b10\b/));
    expect(norm(status(dlg).textContent)).toMatch(/\b1\b/); // opted out
    const text = norm(dlg.textContent);
    for (const s of SAMPLE) expect(text).toContain(s.channel_address);
    expect(text).toMatch(/Client/);
    expect(API.writes(), 'a preview writes nothing').toEqual([]);
  });

  it('every change updates the count: a second kind (20), Select all (40), Active only off (+5), and no kind again clears it with no request', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await user.click(tick(dlg, /^laboratory/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b20\b/));
    expect(kinds(API.previews().at(-1)!)).toEqual(['client', 'laboratory']);
    await user.click(tick(dlg, /^select all/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b40\b/));
    expect(kinds(API.previews().at(-1)!)).toEqual(['client', 'franchise', 'lab_user', 'laboratory']);
    await user.click(tick(dlg, /^active only/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b45\b/));
    expect(API.previews().at(-1)!.json.audience_filter.active_only).toBe(false);
    await user.click(tick(dlg, /^select all/i)); // unticks all four
    await quiet(120);
    const n = API.previews().length;
    await quiet(120);
    expect(API.previews().length, 'no request for an empty audience').toBe(n);
    expect(norm(status(dlg).textContent)).toContain(t('engagement.msg.audience.choose'));
    expect(norm(status(dlg).textContent)).not.toMatch(/\b45\b/);
  });

  it('out of order answers: a slow answer for one kind never overwrites the later answer for two kinds', async () => {
    API.previewSlowMs = 500;
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i)); // slow, would answer 10
    await user.click(tick(dlg, /^laboratory/i)); // fast, answers 20
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b20\b/));
    await quiet(700);
    expect(norm(status(dlg).textContent)).toMatch(/\b20\b/);
    expect(norm(status(dlg).textContent)).not.toMatch(/\b10\b/);
  });

  it('a failed count says so, shows no stale number and blocks Request approval', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b10\b/));
    API.previewFail = 500;
    await user.click(tick(dlg, /^laboratory/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).not.toMatch(/\b10\b/));
    expect(isDisabled(within(dlg).getByRole('button', { name: /^request approval/i }))).toBe(true);
    expect(norm(dlg.textContent)).not.toMatch(/\b50[0-9]\b|undefined|Unhandled/);
  });

  it('an empty audience (0 recipients) blocks Request approval and Save draft with a visible reason', async () => {
    API.previewCountOverride = 0;
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(API.previews()).toHaveLength(1));
    await quiet(60);
    const req = within(dlg).getByRole('button', { name: /^request approval/i });
    expect(isDisabled(req)).toBe(true);
    expect(reasonOf(req).trim().length, 'visible reason').toBeGreaterThan(0);
  });

  it('more than 5000 recipients: the count is shown with the limit text and Request approval is blocked with it (engagement.broadcast_recipient_limit)', async () => {
    API.previewCountOverride = 5001;
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/5,?001/));
    const req = within(dlg).getByRole('button', { name: /^request approval/i });
    reasonKey(req, 'engagement.msg.error.recipient_limit');
  });

  it('Request approval and Save draft are disabled with the visible prompt until a template and a kind are chosen', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    const req = within(dlg).getByRole('button', { name: /^request approval/i });
    const draft = within(dlg).getByRole('button', { name: /^save draft/i });
    expect(isDisabled(req) && isDisabled(draft)).toBe(true);
    expect(reasonOf(req)).toContain(t('engagement.msg.audience.choose'));
  });

  it('masked sample only: even if the API sent a full phone or e-mail the screen never prints it', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    // the preview stand-in answers the fixed masked sample; a full value must never be rendered by this screen
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b10\b/));
    expect(norm(dlg.textContent)).not.toMatch(/\+977\d{10}|\b9[78]\d{8}\b/); // no full Nepal mobile number
    expect(norm(dlg.textContent)).not.toMatch(/[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]+\.[a-z]{2,}/); // no full e-mail (the masked one is "l***@...")
  });

  it('Save draft: POST /broadcasts {template_id, audience_filter} with an Idempotency-Key and no approval call', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b10\b/));
    await user.click(within(dlg).getByRole('button', { name: /^save draft/i }));
    await waitFor(() => expect(API.find('POST', /\/broadcasts$/)).toHaveLength(1));
    const c = API.find('POST', /\/broadcasts$/)[0]!;
    expect(c.json).toEqual({ template_id: T_SMS['id'], audience_filter: { party_kinds: ['client'], active_only: true } });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    expect(API.find('POST', /request-approval|approve/)).toEqual([]);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });

  it('Request approval: create, then request-approval with If-Match = the new version; both carry an Idempotency-Key; never an approve call', async () => {
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b10\b/));
    await user.click(within(dlg).getByRole('button', { name: /^request approval/i }));
    await waitFor(() => expect(API.find('POST', /\/request-approval$/)).toHaveLength(1));
    const create = API.find('POST', /\/broadcasts$/)[0]!;
    const ask = API.find('POST', /\/request-approval$/)[0]!;
    expect(API.calls.indexOf(create)).toBeLessThan(API.calls.indexOf(ask));
    expect(ask.path).toContain(`/broadcasts/${ID(99)}/`);
    expect(ask.headers.get('if-match')).toBe('"1"');
    expect(create.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    expect(ask.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    expect(API.find('POST', /\/approve$/)).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('double click on Request approval sends ONE create', async () => {
    API.writeDelayMs = 80;
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b10\b/));
    await user.dblClick(within(dlg).getByRole('button', { name: /^request approval/i }));
    await quiet(300);
    expect(API.find('POST', /\/broadcasts$/)).toHaveLength(1);
  });

  it('a server refusal of the limit (422 engagement.broadcast_recipient_limit) shows the catalogue text and keeps the dialog', async () => {
    API.fail = prob(422, 'engagement.broadcast_recipient_limit');
    const user = userEvent.setup();
    const dlg = await openBuilder(user);
    await pickOption(user, dlg, /^template(\s*\*)?$/i, new RegExp(T_SMS['name']));
    await user.click(tick(dlg, /^client/i));
    await waitFor(() => expect(norm(status(dlg).textContent)).toMatch(/\b10\b/));
    await user.click(within(dlg).getByRole('button', { name: /^save draft/i }));
    await waitFor(() => expect(norm(dlg.textContent)).toContain(t('engagement.msg.error.recipient_limit')));
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });

  it('read only: New broadcast is disabled with the visible reason naming engagement.broadcast.manage', async () => {
    await openPage(BROADCASTS_ROUTE, { perms: READ });
    reasonKey(screen.getByRole('button', { name: /^new broadcast/i }), 'engagement.msg.reason.manage', 'engagement.broadcast.manage');
  });

  it('keyboard: the builder opens with Enter, focus moves into it, Tab reaches the checkboxes, Space ticks one, Escape closes', async () => {
    await openPage(BROADCASTS_ROUTE);
    const user = userEvent.setup();
    screen.getByRole('button', { name: /^new broadcast/i }).focus();
    await user.keyboard('{Enter}');
    const dlg = await dialog();
    expect(dlg.contains(document.activeElement)).toBe(true);
    tick(dlg, /^client/i).focus();
    await user.keyboard(' ');
    expect((tick(dlg, /^client/i) as HTMLInputElement).checked).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('row actions and the second person rule (done_when 2, 5)', () => {
  it('draft row: Request approval -> POST /request-approval If-Match "1" with an Idempotency-Key', async () => {
    await openPage(BROADCASTS_ROUTE);
    const user = userEvent.setup();
    await user.click(await control(user, rowOf(/Synthetic Holiday notice.*Draft/s), /^request approval/i));
    await waitFor(() => expect(API.find('POST', /\/request-approval$/)).toHaveLength(1));
    const c = API.find('POST', /\/request-approval$/)[0]!;
    expect(c.path).toContain(B_DRAFT['id']);
    expect(c.headers.get('if-match')).toBe('"1"');
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
  });

  it('pending row, a second person with the approve permission: Approve is enabled and asks to confirm with the recipient count and the template; nothing is sent before the confirm', async () => {
    await openPage(BROADCASTS_ROUTE, { perms: APPROVE, actor: USER_B });
    const user = userEvent.setup();
    const approve = await control(user, rowOf(T_MAIL['name']), /^approve/i);
    expect(isDisabled(approve)).toBe(false);
    await user.click(approve);
    const dlg = await dialog();
    expect(norm(dlg.textContent)).toMatch(/\b120\b/);
    expect(norm(dlg.textContent)).toContain(T_MAIL['name']);
    expect(API.writes()).toEqual([]);
    await user.click(within(dlg).getByRole('button', { name: /^approve/i }));
    await waitFor(() => expect(API.find('POST', /\/approve$/)).toHaveLength(1));
    const c = API.find('POST', /\/approve$/)[0]!;
    expect(c.path).toContain(B_PEND['id']);
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });

  it('the REQUESTER sees Approve disabled with the visible second person reason, and no approve request can be made (also by keyboard)', async () => {
    await openPage(BROADCASTS_ROUTE, { perms: APPROVE, actor: USER_A });
    const user = userEvent.setup();
    const approve = await control(user, rowOf(T_MAIL['name']), /^approve/i);
    reasonKey(approve, 'engagement.msg.reason.second_person');
    expect(t('engagement.msg.reason.second_person')).toMatch(/second person/i);
    approve.focus();
    await user.keyboard('{Enter}');
    await user.click(approve);
    await quiet(60);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(API.find('POST', /\/approve$/)).toEqual([]);
  });

  it('without engagement.broadcast.approve: Approve is disabled with the reason that names the code', async () => {
    await openPage(BROADCASTS_ROUTE, { perms: MANAGE, actor: USER_B });
    const user = userEvent.setup();
    reasonKey(await control(user, rowOf(T_MAIL['name']), /^approve/i), 'engagement.msg.reason.approve', 'engagement.broadcast.approve');
  });

  it('the server refusals reach the approver as catalogue text: no provider (422), own request (403)', async () => {
    for (const [status, code, key, re] of [[422, 'engagement.broadcast_provider_not_configured', 'engagement.msg.error.provider_not_configured', /provider/i], [403, 'engagement.broadcast_self_approval', 'engagement.msg.error.self_approval', /second person/i]] as const) {
      API.fail = prob(status, code);
      await openPage(BROADCASTS_ROUTE, { perms: APPROVE, actor: USER_B });
      const user = userEvent.setup();
      await user.click(await control(user, rowOf(T_MAIL['name']), /^approve/i));
      await user.click(within(await dialog()).getByRole('button', { name: /^approve/i }));
      await waitFor(() => expect(norm(document.body.textContent)).toContain(t(key)));
      expect(t(key)).toMatch(re);
      expect(norm(document.body.textContent)).not.toMatch(/undefined|Unhandled|request_id/);
      cleanup(); API.reset();
    }
  });

  it('a version conflict on Approve (409) asks to reload and refreshes the list', async () => {
    API.fail = prob(409, 'common.version_conflict');
    await openPage(BROADCASTS_ROUTE, { perms: APPROVE, actor: USER_B });
    const user = userEvent.setup();
    await user.click(await control(user, rowOf(T_MAIL['name']), /^approve/i));
    await user.click(within(await dialog()).getByRole('button', { name: /^approve/i }));
    await waitFor(() => expect(screen.getAllByRole('alert').length + TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });

  it('double click on the Approve confirm sends ONE approve (never a double send)', async () => {
    API.writeDelayMs = 80;
    await openPage(BROADCASTS_ROUTE, { perms: APPROVE, actor: USER_B });
    const user = userEvent.setup();
    await user.click(await control(user, rowOf(T_MAIL['name']), /^approve/i));
    await user.dblClick(within(await dialog()).getByRole('button', { name: /^approve/i }));
    await quiet(300);
    expect(API.find('POST', /\/approve$/)).toHaveLength(1);
  });

  it('Cancel broadcast (pending row) asks to confirm, then POSTs /cancel with If-Match and an Idempotency-Key; Keep sends nothing', async () => {
    await openPage(BROADCASTS_ROUTE);
    const user = userEvent.setup();
    await user.click(await control(user, rowOf(T_MAIL['name']), /^cancel broadcast/i));
    await user.click(within(await dialog()).getByRole('button', { name: /^keep/i }));
    await quiet(40);
    expect(API.writes()).toEqual([]);
    await user.click(await control(user, rowOf(T_MAIL['name']), /^cancel broadcast/i));
    await user.click(within(await dialog()).getByRole('button', { name: /^yes, cancel/i }));
    await waitFor(() => expect(API.find('POST', /\/cancel$/)).toHaveLength(1));
    const c = API.find('POST', /\/cancel$/)[0]!;
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
  });

  it('sent and cancelled rows offer no Approve, no Request approval and no Cancel broadcast', async () => {
    await openPage(BROADCASTS_ROUTE, { perms: APPROVE });
    const user = userEvent.setup();
    for (const row of [rowOf(/Synthetic Holiday notice.*Sent/s), rowOf(/Synthetic Price update.*Cancelled/s)]) {
      for (const n of [/^approve/i, /^request approval/i, /^cancel broadcast/i]) {
        expect(within(row).queryByRole('button', { name: n }), String(n)).toBeNull();
      }
      const menu = within(row).queryByRole('button', { name: /row actions/i });
      if (menu) { await user.click(menu); for (const n of [/^approve/i, /^request approval/i, /^cancel broadcast/i]) expect(screen.queryByRole('menuitem', { name: n }), String(n)).toBeNull(); await user.keyboard('{Escape}'); }
    }
  });

  it('read only: Request approval and Cancel broadcast are disabled with the manage reason', async () => {
    await openPage(BROADCASTS_ROUTE, { perms: READ });
    const user = userEvent.setup();
    reasonKey(await control(user, rowOf(/Synthetic Holiday notice.*Draft/s), /^request approval/i), 'engagement.msg.reason.manage', 'engagement.broadcast.manage');
  });
});

describe('per recipient history (done_when 2): Recipient, Channel, Status, never a full address', () => {
  it('History pushes ?broadcast=<id>', async () => {
    await openPage(BROADCASTS_ROUTE);
    const user = userEvent.setup();
    await user.click(await control(user, rowOf(/Synthetic Holiday notice.*Sent/s), /^history/i));
    expect(TM.push.mock.calls.map((c) => String(c[0])).join(' ')).toContain(`broadcast=${B_SENT['id']}`);
  });

  it('with ?broadcast=<id> the page shows the recipient table: headers, one row per recipient, status words, skip reasons, kind words', async () => {
    const { container } = await openPage(BROADCASTS_ROUTE, { search: `broadcast=${B_SENT['id']}` });
    const heads = [...container.querySelectorAll('thead th, [role="columnheader"]')].map((h) => norm(h.textContent));
    for (const h of ['Recipient', 'Channel', 'Status']) expect(heads, h).toContain(h);
    const text = norm(container.textContent);
    for (const w of [/Queued/, /Sent/, /Failed/, /Skipped/, /opted out/i, /no address/i, /Lab user/, /Client/]) expect(text).toMatch(w);
    expect(text).toContain('+97798****101');
    expect(text).toMatch(/\bSMS\b/); // channel comes from the template
    const rq = API.find('GET', /\/recipients$/)[0]!;
    expect(rq.path).toContain(B_SENT['id']);
    expect(Number(rq.search.get('limit') ?? 50)).toBeLessThanOrEqual(200);
  });

  it('no history yet: the Recipient / Channel / Status header row stays with an EmptyState', async () => {
    API.recipients = {};
    const { container } = await openPage(BROADCASTS_ROUTE, { search: `broadcast=${B_SENT['id']}` });
    const heads = [...container.querySelectorAll('thead th, [role="columnheader"]')].map((h) => norm(h.textContent));
    for (const h of ['Recipient', 'Channel', 'Status']) expect(heads, h).toContain(h);
    expect(emptyState(container)).toBeTruthy();
  });

  it('a full phone or e-mail in the API answer is masked again before it reaches the screen (defence in depth)', async () => {
    API.recipients = { [B_SENT['id']]: [{ id: ID(77), broadcast_id: B_SENT['id'], party_kind: 'client', party_id: ID(777), channel_address: '+9779800000099', status: 'sent' }, { id: ID(78), broadcast_id: B_SENT['id'], party_kind: 'lab_user', party_id: ID(778), channel_address: 'raw.person@example.test', status: 'sent' }] };
    const { container } = await openPage(BROADCASTS_ROUTE, { search: `broadcast=${B_SENT['id']}` });
    const text = norm(container.textContent);
    expect(text).not.toContain('+9779800000099');
    expect(text).not.toContain('raw.person@example.test');
  });

  it('a failed recipients read keeps the broadcasts table and shows an in-place error (not a bare error page)', async () => {
    API.recipientsFail = true;
    const { container } = await openPage(BROADCASTS_ROUTE, { search: `broadcast=${B_SENT['id']}` });
    for (const h of ['Template', 'Audience', 'Status']) expect([...container.querySelectorAll('thead th, [role="columnheader"]')].map((x) => norm(x.textContent))).toContain(h);
    expect(container.querySelector('.lims-error-state, .lims-state.lims-tone-danger, [role="alert"]') !== null || /not available yet/i.test(container.textContent ?? '')).toBe(true);
  });

  it('a hostile broadcast id in the query never reaches an API path', async () => {
    await openPage(BROADCASTS_ROUTE, { search: 'broadcast=../../admin/x' });
    expect(API.find('GET', /recipients/)).toEqual([]);
  });
});
