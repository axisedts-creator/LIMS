// @vitest-environment jsdom
// T0D-MSGDESK-1 — Lab side Ticket Inbox /partners/tickets and thread /partners/tickets/[ticket_id] (ElabAssist Message To Laboratory: status New, Replied, Close; LD-321, LD-353 template 1 LIST).
// Through the PAGE default exports (server page -> BFF -> MSW -> client parts). Harness: features/engagement/__tests__/msgdesk1.harness.tsx.
// PINNED UI NAMES (tester choice; the writer may dispute through the ruling path):
//   - inbox headers: Ticket, Party, Subject, Status, Last Reply (done_when 3). Ticket cell = a link to /partners/tickets/<id>. Party = the partner NAME (read from the existing partner list).
//     Status words: New, Replied, Closed. Last Reply = the last_message_at time, an em dash when there is none.
//   - one FilterBar with: Status (kit Select: All, New, Replied, Closed), Party (kit Select, "All parties" first), From and To (native date inputs). Filters live in the URL; the server page forwards only
//     status, party_id, created_from, created_to (+ cursor, limit <= 200) to listPartnerTickets.
//   - "New ticket" opens a dialog: Party (kit Select), Subject (max 150), Message (max 2000); "Send" POSTs /admin/tickets {party_kind:'partner', party_id, subject, body} with an Idempotency-Key.
//   - thread: the subject as heading, a status chip, the messages oldest first, each with a sender word ("Partner" or "Lab") and a time; a Reply box (label "Reply", max 2000) with button "Reply";
//     "Close" (new / replied tickets) and "Reopen" (closed tickets). A closed ticket takes no reply: Reply is disabled with t('partners.ticket.reason.closed').
//   - writes: reply = POST /admin/tickets/<id>/messages {body} + Idempotency-Key; close / reopen = POST with If-Match "<ticket version>" + Idempotency-Key.
//   - permission: view partners.ticket.read; reply / close / reopen / New ticket need partners.ticket.manage; blocked = disabled + visible reason t('partners.ticket.reason.manage') naming the code.
//   - a back link "Back to tickets" -> /partners/tickets. A ticket id that is not a uuid is a 404 and never reaches the API; an unknown id (API 404) is a 404 page.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { t } from '@/core/i18n/messages';
import { expectListScreen, expectStateInPage } from '@/features/catalog/__tests__/uilist3.helpers';
import { API, ID, IDEM, PARTNER1, PARTNER2, PATH, TICKETS_ROUTE, THREAD_ROUTE, TK_CLO, TK_NEW, TK_REP, TM, TMANAGE, TREAD, api, isDisabled, norm, openPage, pickOption, prob, quiet, reasonOf, rowOf } from '@/features/engagement/__tests__/msgdesk1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const HEADS = ['Ticket', 'Party', 'Subject', 'Status', 'Last Reply'];
const dialog = () => screen.findByRole('dialog');
const emptyState = (c: HTMLElement) => c.querySelector('.lims-empty-state, [class*="empty-state"]');
const blocked = (el: HTMLElement) => {
  expect(t('partners.ticket.reason.manage'), 'catalogue key').not.toBe('partners.ticket.reason.manage');
  expect(t('partners.ticket.reason.manage')).toContain('partners.ticket.manage');
  expect(isDisabled(el), 'control is disabled').toBe(true);
  expect(reasonOf(el)).toContain(t('partners.ticket.reason.manage'));
  expect(document.body.textContent).toContain(t('partners.ticket.reason.manage'));
};
const thread = (ticket: Record<string, any>, perms = TMANAGE) => openPage(THREAD_ROUTE, { perms, params: { ticket_id: ticket['id'] } });

describe('inbox: LIST template, headers always shown (done_when 3, 4)', () => {
  it('rows: h1 = menu label, one FilterBar, the five named columns in the kit scroll box', async () => {
    const { container } = await openPage(TICKETS_ROUTE, { perms: TREAD });
    expectListScreen(container, { path: PATH(TICKETS_ROUTE), headers: HEADS, filterBar: 1 });
    expect(norm(container.textContent)).not.toMatch(/undefined|null|NaN/);
  });
  it('no tickets: the header row stays and an EmptyState sits in the body', async () => {
    API.tickets = [];
    const { container } = await openPage(TICKETS_ROUTE, { perms: TREAD });
    expectListScreen(container, { path: PATH(TICKETS_ROUTE), headers: HEADS, filterBar: 1 });
    expect(emptyState(container), 'EmptyState').toBeTruthy();
  });
  it('a failed list keeps the page title and the filters (ErrorState or NotAvailable); 403 too', async () => {
    API.listFail = 500;
    const a = await openPage(TICKETS_ROUTE, { perms: TREAD });
    expectStateInPage(a.container, { path: PATH(TICKETS_ROUTE), kind: 'either' });
    cleanup();
    API.listFail = 403;
    const b = await openPage(TICKETS_ROUTE, { perms: [] });
    expectStateInPage(b.container, { path: PATH(TICKETS_ROUTE), kind: 'either' });
  });
  it('one row per ticket: link to the thread, the partner NAME, subject, status word, last reply time or an em dash', async () => {
    await openPage(TICKETS_ROUTE, { perms: TREAD });
    const r1 = rowOf(TK_NEW['subject']);
    expect(r1.textContent).toContain(PARTNER1.name);
    expect(r1.textContent).toMatch(/\bNew\b/);
    expect(within(r1).getAllByRole('link').some((a) => (a.getAttribute('href') ?? '').endsWith(`/partners/tickets/${TK_NEW['id']}`))).toBe(true);
    expect(rowOf(TK_REP['subject']).textContent).toContain(PARTNER2.name);
    expect(rowOf(TK_REP['subject']).textContent).toMatch(/Replied/);
    expect(rowOf(TK_CLO['subject']).textContent).toMatch(/Closed/);
    expect(rowOf(TK_CLO['subject']).textContent).toMatch(/—/);
    expect(rowOf(TK_NEW['subject']).textContent).not.toMatch(/—/);
  });
  it('lists are paged: at most 200 rows a request; next_cursor offers Next which moves with cursor=<value>', async () => {
    API.nextCursor = 'cur-2';
    await openPage(TICKETS_ROUTE, { perms: TREAD });
    expect(Number(API.find('GET', /\/admin\/tickets$/)[0]!.search.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    await userEvent.click(screen.getByRole('button', { name: /^next/i }));
    expect(TM.push.mock.calls.map((c) => String(c[0])).join(' ')).toContain('cursor=cur-2');
  });
  it('filters from the URL reach the API as status, party_id, created_from, created_to and nothing else (hostile params and bad values are dropped)', async () => {
    await openPage(TICKETS_ROUTE, { perms: TREAD, search: `status=new&party_id=${PARTNER1.id}&created_from=2026-11-01&created_to=2026-11-20&evil=1&party_kind=x` });
    const q = API.find('GET', /\/admin\/tickets$/)[0]!.search;
    expect([q.get('status'), q.get('party_id'), q.get('created_from'), q.get('created_to'), q.has('evil')]).toEqual(['new', PARTNER1.id, '2026-11-01', '2026-11-20', false]);
    cleanup(); API.calls.length = 0;
    await openPage(TICKETS_ROUTE, { perms: TREAD, search: 'status=bogus&party_id=../x&created_from=yesterday' });
    const b = API.find('GET', /\/admin\/tickets$/)[0]!.search;
    expect([b.get('status'), b.get('party_id'), b.get('created_from')]).toEqual([null, null, null]);
  });
  it('the FilterBar has Status, Party, From and To; changing Status pushes status=<value>', async () => {
    const { container } = await openPage(TICKETS_ROUTE, { perms: TREAD });
    const bar = container.querySelector('.lims-filter-bar') as HTMLElement;
    for (const l of [/^status/i, /^party/i]) expect(within(bar).getByLabelText(l, { selector: 'button' })).toBeTruthy();
    for (const l of [/^from/i, /^to/i]) expect((within(bar).getByLabelText(l) as HTMLInputElement).type).toBe('date');
    const user = userEvent.setup();
    await pickOption(user, bar, /^status$/i, /^new$/i);
    expect(TM.push.mock.calls.map((c) => String(c[0])).join(' ')).toContain('status=new');
  });
  it('subjects are plain text: markup in a subject never becomes an element (ST16)', async () => {
    API.tickets = [{ ...TK_NEW, subject: '<img src=x onerror=alert(1)> late' }];
    const { container } = await openPage(TICKETS_ROUTE, { perms: TREAD });
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
  it('axe: no violations on the inbox', async () => {
    await openPage(TICKETS_ROUTE, { perms: TREAD });
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('New ticket (lab side)', () => {
  it('POST /admin/tickets {party_kind, party_id, subject, body} with an Idempotency-Key; the dialog closes and the list refreshes', async () => {
    await openPage(TICKETS_ROUTE, { perms: TMANAGE });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^new ticket/i }));
    const dlg = await dialog();
    await pickOption(user, dlg, /^party(\s*\*)?$/i, new RegExp(PARTNER2.name));
    await user.type(within(dlg).getByLabelText(/^subject/i), 'Synthetic subject');
    await user.type(within(dlg).getByLabelText(/^message/i), 'Synthetic message');
    await user.click(within(dlg).getByRole('button', { name: /^send/i }));
    await waitFor(() => expect(API.find('POST', /\/admin\/tickets$/)).toHaveLength(1));
    const c = API.find('POST', /\/admin\/tickets$/)[0]!;
    expect(c.json).toEqual({ party_kind: 'partner', party_id: PARTNER2.id, subject: 'Synthetic subject', body: 'Synthetic message' });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it('an empty subject, an empty message and no party are refused in the browser: no request', async () => {
    await openPage(TICKETS_ROUTE, { perms: TMANAGE });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^new ticket/i }));
    const dlg = await dialog();
    await user.click(within(dlg).getByRole('button', { name: /^send/i }));
    await quiet(40);
    expect(API.writes()).toEqual([]);
    expect(within(dlg).getByLabelText(/^subject/i).getAttribute('aria-invalid')).toBe('true');
  });
  it('the Subject and Message fields carry their limits (150 and 2000)', async () => {
    await openPage(TICKETS_ROUTE, { perms: TMANAGE });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^new ticket/i }));
    const dlg = await dialog();
    expect(within(dlg).getByLabelText(/^subject/i).getAttribute('maxlength')).toBe('150');
    expect(within(dlg).getByLabelText(/^message/i).getAttribute('maxlength')).toBe('2000');
  });
  it('read only: New ticket is disabled with the manage reason', async () => {
    await openPage(TICKETS_ROUTE, { perms: TREAD });
    blocked(screen.getByRole('button', { name: /^new ticket/i }));
  });
});

describe('thread view (done_when 3, 5)', () => {
  it('shows the subject, the status, the messages OLDEST FIRST with Partner / Lab sender words, and a back link', async () => {
    const { container } = await thread(TK_REP);
    const text = norm(container.textContent);
    expect(text).toContain(TK_REP['subject']);
    expect(text).toMatch(/Replied/);
    const a = text.indexOf('The label on tube 3 is wrong');
    const b = text.indexOf('We checked it and fixed the label');
    const c = text.indexOf('thanks (SYNTHETIC)');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(text).toMatch(/\bPartner\b/);
    expect(text).toMatch(/\bLab\b/);
    const back = within(container).getByRole('link', { name: /back to tickets/i });
    expect(back.getAttribute('href')).toBe('/partners/tickets');
    expect(API.find('GET', /\/admin\/tickets\/[^/]+$/)[0]!.path.endsWith(`/admin/tickets/${TK_REP['id']}`)).toBe(true);
  });
  it('message text is plain: markup in a message never becomes an element (ST16)', async () => {
    const { container } = await thread(TK_REP);
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(norm(container.textContent)).toContain('<img src=x onerror=alert(1)>');
  });
  it('a new or replied ticket offers Reply and Close and no Reopen; a closed ticket offers Reopen, a disabled Reply with the closed reason and no Close', async () => {
    await thread(TK_NEW);
    expect(isDisabled(screen.getByRole('button', { name: /^reply/i }))).toBe(false);
    expect(screen.getByRole('button', { name: /^close/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^reopen/i })).toBeNull();
    cleanup();
    await thread(TK_CLO);
    const reply = screen.getByRole('button', { name: /^reply/i });
    expect(isDisabled(reply)).toBe(true);
    expect(t('partners.ticket.reason.closed')).toMatch(/closed|reopen/i);
    expect(reasonOf(reply)).toContain(t('partners.ticket.reason.closed'));
    expect(screen.getByRole('button', { name: /^reopen/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^close/i })).toBeNull();
  });
  it('Reply: POST /messages {body} with an Idempotency-Key; the box clears and the thread refreshes', async () => {
    await thread(TK_NEW);
    const user = userEvent.setup();
    const box = screen.getByLabelText(/^reply/i, { selector: 'textarea' }) as HTMLTextAreaElement;
    expect(box.getAttribute('maxlength')).toBe('2000');
    await user.type(box, 'We are on it. (SYNTHETIC)');
    await user.click(screen.getByRole('button', { name: /^reply/i }));
    await waitFor(() => expect(API.find('POST', /\/messages$/)).toHaveLength(1));
    const c = API.find('POST', /\/messages$/)[0]!;
    expect(c.path).toContain(`/admin/tickets/${TK_NEW['id']}/messages`);
    expect(c.json).toEqual({ body: 'We are on it. (SYNTHETIC)' });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(box.value).toBe(''));
  });
  it('an empty or blank reply is refused in the browser: no request', async () => {
    await thread(TK_NEW);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^reply/i }));
    await user.type(screen.getByLabelText(/^reply/i, { selector: 'textarea' }), '   ');
    await user.click(screen.getByRole('button', { name: /^reply/i }));
    await quiet(40);
    expect(API.writes()).toEqual([]);
  });
  it('double click on Reply sends ONE message', async () => {
    API.writeDelayMs = 80;
    await thread(TK_NEW);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^reply/i, { selector: 'textarea' }), 'One only (SYNTHETIC)');
    await user.dblClick(screen.getByRole('button', { name: /^reply/i }));
    await quiet(300);
    expect(API.find('POST', /\/messages$/)).toHaveLength(1);
  });
  it('a reply refused because the ticket was closed meanwhile (409 partners.ticket_invalid_transition) says so and keeps the typed text', async () => {
    API.fail = prob(409, 'partners.ticket_invalid_transition');
    await thread(TK_NEW);
    const user = userEvent.setup();
    const box = screen.getByLabelText(/^reply/i, { selector: 'textarea' }) as HTMLTextAreaElement;
    await user.type(box, 'Too late (SYNTHETIC)');
    await user.click(screen.getByRole('button', { name: /^reply/i }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(box.value).toBe('Too late (SYNTHETIC)');
    expect(norm(document.body.textContent)).not.toMatch(/undefined|Unhandled|request_id/);
  });
  it('Close: POST /close with If-Match = the ticket version (TK_REP is version 3) and an Idempotency-Key', async () => {
    await thread(TK_REP);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^close/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await user.click(within(dlg).getByRole('button', { name: /^close/i }));
    await waitFor(() => expect(API.find('POST', /\/close$/)).toHaveLength(1));
    const c = API.find('POST', /\/close$/)[0]!;
    expect(c.path).toContain(`/admin/tickets/${TK_REP['id']}/close`);
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it('Reopen: POST /reopen with If-Match = the ticket version (TK_CLO is version 5) and an Idempotency-Key', async () => {
    await thread(TK_CLO);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^reopen/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await user.click(within(dlg).getByRole('button', { name: /^reopen/i }));
    await waitFor(() => expect(API.find('POST', /\/reopen$/)).toHaveLength(1));
    const c = API.find('POST', /\/reopen$/)[0]!;
    expect(c.headers.get('if-match')).toBe('"5"');
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
  });
  it('a version conflict on Close (409) asks to reload instead of failing silently', async () => {
    API.fail = prob(409, 'common.version_conflict');
    await thread(TK_REP);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^close/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await user.click(within(dlg).getByRole('button', { name: /^close/i }));
    await waitFor(() => expect(screen.getAllByRole('alert').length + TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it('read only (partners.ticket.read): Reply, Close are disabled with the manage reason and nothing can be sent', async () => {
    await thread(TK_REP, TREAD);
    blocked(screen.getByRole('button', { name: /^reply/i }));
    blocked(screen.getByRole('button', { name: /^close/i }));
    await quiet(40);
    expect(API.writes()).toEqual([]);
  });
  it('keyboard: the Reply box can be reached and sent without a mouse (Tab to the button, Enter)', async () => {
    await thread(TK_NEW);
    const user = userEvent.setup();
    const box = screen.getByLabelText(/^reply/i, { selector: 'textarea' });
    await user.click(box);
    await user.keyboard('Keyboard reply (SYNTHETIC)');
    screen.getByRole('button', { name: /^reply/i }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(API.find('POST', /\/messages$/)).toHaveLength(1));
  });
  it('a thread with no messages still draws the heading and an EmptyState for the messages', async () => {
    API.tickets = [{ ...TK_NEW, id: ID(55) }];
    const { container } = await openPage(THREAD_ROUTE, { perms: TMANAGE, params: { ticket_id: ID(55) } });
    expect(norm(container.textContent)).toContain(TK_NEW['subject']);
    expect(emptyState(container)).toBeTruthy();
  });
  it('a ticket id that is not a uuid is a 404 and never reaches the API; an unknown ticket (API 404) is a 404 too', async () => {
    for (const bad of ['abc', '../admin/partners', '%2e%2e', `${TK_NEW['id']}/close`]) {
      API.calls.length = 0;
      await expect(openPage(THREAD_ROUTE, { perms: TMANAGE, params: { ticket_id: bad } }), bad).rejects.toThrow(/NEXT_NOT_FOUND/);
      expect(API.calls.filter((c) => /admin\/tickets/.test(c.path)), bad).toEqual([]);
    }
    await expect(openPage(THREAD_ROUTE, { perms: TMANAGE, params: { ticket_id: ID(404) } })).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});
