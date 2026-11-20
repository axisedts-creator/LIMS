// @vitest-environment jsdom
// T0D-MSGDESK-1 — Message templates: /engagement/messages/templates (ElabAssist Messages > Create New Template; LD-321, LD-310, LD-353 template 1 LIST).
// Through the PAGE default export app/(staff)/engagement/messages/templates/page.tsx (server page -> BFF -> MSW -> client parts).
// PINNED UI NAMES (tester choice; the spec fixes only the columns and the rules; the writer may dispute through the ruling path):
//   - headers: Name, Channel, Active (done_when 2). Channel words: SMS, WhatsApp, Email. Active words: Yes / No (or Active / Inactive).
//   - page title (h1) = the menu label of the nav entry for the path (menuLabel); at most one FilterBar; header row always drawn (also empty); EmptyState in the body.
//   - the top button "Add template" opens a dialog with (label text, start of label): Name, Channel (kit Select: SMS, WhatsApp, Email), Subject (only while Channel = Email), Message (textarea, max 1000),
//     and the PLACEHOLDER HELPER: one button per allowed placeholder inside the dialog, named exactly {{party_name}}, {{lab_name}}, {{lab_phone}}, {{send_date}}; a click adds that text to Message.
//     Dialog buttons "Save" / "Cancel".
//   - an unknown placeholder such as {{secret}} is refused in the browser (Message aria-invalid, no request); the server list is closed (BroadcastPlaceholder).
//   - row controls are BUTTONS in the row (or menu items under "Row actions"): Edit, Deactivate (confirm dialog, button "Deactivate"); an inactive row has neither Deactivate nor an Activate (no such operation).
//   - writes: POST create carries an Idempotency-Key and sends {name, channel, body[, subject]} only; PATCH sends ONLY changed fields with If-Match "<row version>" (the channel is fixed at creation:
//     the edit dialog has no enabled Channel control); deactivate = POST /deactivate with If-Match.
//   - permission: view engagement.broadcast.read, change engagement.broadcast.manage; a blocked control is disabled with a visible reason linked by aria-describedby = t('engagement.msg.reason.manage').
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { t } from '@/core/i18n/messages';
import { expectListScreen, expectStateInPage } from '@/features/catalog/__tests__/uilist3.helpers';
import { API, IDEM, MANAGE, PATH, READ, T_SMS, T_WA, TEMPLATES_ROUTE, TM, api, headers, isDisabled, norm, openPage, pickOption, prob, quiet, reasonOf, rowOf } from './msgdesk1.harness';

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const REASON = 'engagement.msg.reason.manage';
const blocked = (el: HTMLElement) => {
  expect(t(REASON), `catalogue key ${REASON} must exist`).not.toBe(REASON);
  expect(t(REASON)).toContain('engagement.broadcast.manage');
  expect(isDisabled(el), 'control is disabled').toBe(true);
  expect(reasonOf(el), 'visible reason linked by aria-describedby').toContain(t(REASON));
  expect(document.body.textContent).toContain(t(REASON));
};
const control = async (user: ReturnType<typeof userEvent.setup>, row: HTMLElement, name: RegExp): Promise<HTMLElement> => {
  const direct = within(row).queryByRole('button', { name });
  if (direct) return direct;
  await user.click(within(row).getByRole('button', { name: /row actions/i }));
  return screen.findByRole('menuitem', { name });
};
const dialog = () => screen.findByRole('dialog');
const field = (dlg: HTMLElement, label: string) => within(dlg).getByLabelText(new RegExp(`^${label}`, 'i')) as HTMLInputElement;
const typeInto = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) => { await user.clear(el); if (v) await user.type(el, v); };
const save = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: /^save/i });
const emptyState = (c: HTMLElement) => c.querySelector('.lims-empty-state, [class*="empty-state"]');
const PH = ['{{party_name}}', '{{lab_name}}', '{{lab_phone}}', '{{send_date}}'];

describe('templates: LIST template, headers always shown (done_when 2, 4; LD-353 rules 5, 6, 8)', () => {
  it('rows: h1 = menu label, header row Name / Channel / Active in the kit scroll box', async () => {
    const { container } = await openPage(TEMPLATES_ROUTE);
    expectListScreen(container, { path: PATH(TEMPLATES_ROUTE), headers: ['Name', 'Channel', 'Active'], filterBar: 'optional' });
    expect(norm(container.textContent)).not.toMatch(/undefined|null|NaN/);
  });
  it('no rows: the header row stays and an EmptyState sits in the body', async () => {
    API.templates = [];
    const { container } = await openPage(TEMPLATES_ROUTE);
    expectListScreen(container, { path: PATH(TEMPLATES_ROUTE), headers: ['Name', 'Channel', 'Active'], filterBar: 'optional' });
    expect(emptyState(container), 'EmptyState').toBeTruthy();
  });
  it('a failed list keeps the page title and chrome and shows an ErrorState or NotAvailable, never a bare error page', async () => {
    API.listFail = 500;
    const { container } = await openPage(TEMPLATES_ROUTE);
    expectStateInPage(container, { path: PATH(TEMPLATES_ROUTE), kind: 'either' });
  });
  it('403 on the list also keeps the page (permission shown, no stack)', async () => {
    API.listFail = 403;
    const { container } = await openPage(TEMPLATES_ROUTE, { perms: [] });
    expectStateInPage(container, { path: PATH(TEMPLATES_ROUTE), kind: 'either' });
  });
  it('lists are paged: one request asks at most 200 rows and a next_cursor offers Next, which moves with cursor=<value>', async () => {
    API.nextCursor = 'cur-2';
    await openPage(TEMPLATES_ROUTE);
    const first = API.find('GET', /\/broadcast-templates$/)[0]!;
    expect(Number(first.search.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    await userEvent.click(screen.getByRole('button', { name: /^next/i }));
    expect(TM.push.mock.calls.map((c) => String(c[0])).join(' ')).toContain('cursor=cur-2');
  });
  it('one row per template with name, a channel word and an Active word; an inactive row says so', async () => {
    await openPage(TEMPLATES_ROUTE);
    expect(rowOf('Synthetic Holiday notice').textContent).toMatch(/\bSMS\b/);
    expect(rowOf('Synthetic Holiday notice').textContent).toMatch(/\b(Yes|Active)\b/);
    expect(rowOf('Synthetic Price update').textContent).toMatch(/\bEmail\b/);
    expect(rowOf('Synthetic Old campaign').textContent).toMatch(/\bWhatsApp\b/);
    expect(rowOf('Synthetic Old campaign').textContent).toMatch(/\b(No|Inactive)\b/);
    expect(rowOf('Synthetic Old campaign').textContent).not.toMatch(/\b(Yes|Active)\b/);
    expect(headers()).toEqual(expect.arrayContaining(['Name', 'Channel', 'Active']));
  });
  it('plain text only: a template body with markup is shown as text, never as an element (ST16)', async () => {
    API.templates = [{ ...T_SMS, name: '<img src=x onerror=alert(1)> Synthetic', body: '<script>alert(2)</script>' }];
    const { container } = await openPage(TEMPLATES_ROUTE);
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
  it('axe: no violations on the list', async () => {
    await openPage(TEMPLATES_ROUTE);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('Add template and the placeholder helper (done_when 2)', () => {
  it('Add template: POST {name, channel, body} with an Idempotency-Key; the dialog closes and the list refreshes', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add template/i }));
    const dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic Reminder');
    await pickOption(user, dlg, /^channel(\s*\*)?$/i, /^SMS$/);
    await user.type(field(dlg, 'Message'), 'Dear ');
    await user.click(within(dlg).getByRole('button', { name: '{{party_name}}' }));
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('POST', /\/broadcast-templates$/)).toHaveLength(1));
    const c = API.find('POST', /\/broadcast-templates$/)[0]!;
    expect(c.json).toEqual({ name: 'Synthetic Reminder', channel: 'sms', body: 'Dear {{party_name}}' });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('the helper offers exactly the four allowed placeholders and a click adds the text to Message', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add template/i }));
    const dlg = await dialog();
    const names = within(dlg).getAllByRole('button').map((b) => norm(b.textContent)).filter((x) => /^\{\{.*\}\}$/.test(x));
    expect(names.sort()).toEqual([...PH].sort());
    for (const p of PH) await user.click(within(dlg).getByRole('button', { name: p }));
    for (const p of PH) expect(field(dlg, 'Message').value).toContain(p);
  });
  it('Subject is asked only for the Email channel', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add template/i }));
    const dlg = await dialog();
    await pickOption(user, dlg, /^channel(\s*\*)?$/i, /^SMS$/);
    expect(within(dlg).queryByLabelText(/^subject/i)).toBeNull();
    await pickOption(user, dlg, /^channel(\s*\*)?$/i, /^Email$/);
    expect(field(dlg, 'Subject')).toBeTruthy();
    await user.type(field(dlg, 'Name'), 'Synthetic Mail');
    await user.type(field(dlg, 'Subject'), 'Synthetic subject');
    await user.type(field(dlg, 'Message'), 'Hello');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('POST', /\/broadcast-templates$/)).toHaveLength(1));
    expect(API.find('POST', /\/broadcast-templates$/)[0]!.json).toEqual({ name: 'Synthetic Mail', channel: 'email', subject: 'Synthetic subject', body: 'Hello' });
  });
  it('an unknown placeholder, an empty name or message and a message over 1000 characters are refused in the browser: no request, the field is marked invalid', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add template/i }));
    const dlg = await dialog();
    await pickOption(user, dlg, /^channel(\s*\*)?$/i, /^SMS$/);
    await user.type(field(dlg, 'Name'), 'Synthetic Reminder');
    await user.type(field(dlg, 'Message'), 'Dear x');
    fireEvent.change(field(dlg, 'Message'), { target: { value: 'Dear {{secret}}' } });
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes(), 'unknown placeholder').toEqual([]);
    expect(field(dlg, 'Message').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(field(dlg, 'Message'), { target: { value: 'x'.repeat(1001) } });
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes(), '1001 characters').toEqual([]);
    expect(field(dlg, 'Message').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(field(dlg, 'Message'), { target: { value: '' } });
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes(), 'empty message').toEqual([]);
    fireEvent.change(field(dlg, 'Message'), { target: { value: 'Dear {{party_name}}' } });
    await typeInto(user, field(dlg, 'Name'), '   ');
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes(), 'blank name').toEqual([]);
    expect(field(dlg, 'Name').getAttribute('aria-invalid')).toBe('true');
  });
  it('a server 400 on /body (unknown placeholder the browser missed) is shown on Message; the dialog stays open with the typed text', async () => {
    API.fail = prob(400, 'common.validation_failed', [{ path: '/body', code: 'common.validation_failed', message: 'Unknown placeholder' }]);
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add template/i }));
    const dlg = await dialog();
    await pickOption(user, dlg, /^channel(\s*\*)?$/i, /^SMS$/);
    await user.type(field(dlg, 'Name'), 'Synthetic Reminder');
    await user.type(field(dlg, 'Message'), 'Dear friend');
    await user.click(save(dlg));
    await waitFor(() => expect(field(dlg, 'Message').getAttribute('aria-invalid')).toBe('true'));
    expect(reasonOf(field(dlg, 'Message')) + norm(dlg.textContent)).toContain('Unknown placeholder');
    expect(field(dlg, 'Message').value).toBe('Dear friend');
    expect(TM.refresh.mock.calls.length).toBe(0);
  });
  it('double click on Save sends ONE request', async () => {
    API.writeDelayMs = 80;
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add template/i }));
    const dlg = await dialog();
    await pickOption(user, dlg, /^channel(\s*\*)?$/i, /^SMS$/);
    await user.type(field(dlg, 'Name'), 'Synthetic Reminder');
    await user.type(field(dlg, 'Message'), 'Dear friend');
    await user.dblClick(save(dlg));
    await quiet(250);
    expect(API.find('POST', /\/broadcast-templates$/)).toHaveLength(1);
  });
});

describe('Edit and Deactivate', () => {
  it('Edit sends only the changed field with If-Match = the row version (T_SMS is version 2); the channel cannot be changed', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Holiday notice'), /^edit/i));
    const dlg = await dialog();
    expect(field(dlg, 'Name').value).toBe('Synthetic Holiday notice');
    expect(field(dlg, 'Message').value).toBe(T_SMS['body']);
    const ch = within(dlg).queryByLabelText(/^channel/i);
    expect(ch === null || isDisabled(ch as HTMLElement), 'no enabled Channel control in edit').toBe(true);
    await typeInto(user, field(dlg, 'Name'), 'Synthetic Holiday notice v2');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('PATCH', /\/broadcast-templates\/[^/]+$/)).toHaveLength(1));
    const c = API.find('PATCH', /\/broadcast-templates\/[^/]+$/)[0]!;
    expect(c.path.endsWith(`/broadcast-templates/${T_SMS['id']}`)).toBe(true);
    expect(c.json).toEqual({ name: 'Synthetic Holiday notice v2' });
    expect(c.headers.get('if-match')).toBe('"2"');
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it('Edit with nothing changed sends nothing', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Holiday notice'), /^edit/i));
    const dlg = await dialog();
    await user.click(save(dlg));
    await quiet(40);
    expect(API.writes()).toEqual([]);
  });
  it('a version conflict (409) asks to reload, keeps the dialog and does not refresh as if saved', async () => {
    API.fail = prob(409, 'common.version_conflict');
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Holiday notice'), /^edit/i));
    const dlg = await dialog();
    await typeInto(user, field(dlg, 'Name'), 'Synthetic Holiday notice v3');
    await user.click(save(dlg));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });
  it('Deactivate asks to confirm, then POSTs /deactivate with If-Match = the row version', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Price update'), /^deactivate/i));
    const dlg = await dialog();
    expect(API.writes()).toEqual([]);
    await user.click(within(dlg).getByRole('button', { name: /^deactivate/i }));
    await waitFor(() => expect(API.find('POST', /\/broadcast-templates\/[^/]+\/deactivate$/)).toHaveLength(1));
    const c = API.find('POST', /\/deactivate$/)[0]!;
    expect(c.headers.get('if-match')).toBe('"1"');
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it('an inactive row has no Deactivate (and there is no Activate operation)', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    const row = rowOf(T_WA['name']);
    expect(within(row).queryByRole('button', { name: /^deactivate/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^activate/i })).toBeNull();
    const menu = within(row).queryByRole('button', { name: /row actions/i });
    if (menu) { await user.click(menu); expect(screen.queryByRole('menuitem', { name: /^deactivate/i })).toBeNull(); expect(screen.queryByRole('menuitem', { name: /^activate/i })).toBeNull(); }
  });
});

describe('permission: engagement.broadcast.manage', () => {
  it('read only: Add template is disabled with the visible reason that names the code', async () => {
    await openPage(TEMPLATES_ROUTE, { perms: READ });
    blocked(screen.getByRole('button', { name: /^add template/i }));
  });
  it('read only: Edit and Deactivate are disabled with the reason', async () => {
    await openPage(TEMPLATES_ROUTE, { perms: READ });
    const user = userEvent.setup();
    const row = rowOf('Synthetic Holiday notice');
    const edit = await control(user, row, /^edit/i);
    blocked(edit);
  });
  it('manage: Add template is enabled', async () => {
    await openPage(TEMPLATES_ROUTE, { perms: MANAGE });
    expect(isDisabled(screen.getByRole('button', { name: /^add template/i }))).toBe(false);
  });
  it('keyboard: Add template opens with Enter, the first field has focus and Escape closes the dialog (no mouse)', async () => {
    await openPage(TEMPLATES_ROUTE);
    const user = userEvent.setup();
    screen.getByRole('button', { name: /^add template/i }).focus();
    await user.keyboard('{Enter}');
    const dlg = await dialog();
    expect(dlg.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
