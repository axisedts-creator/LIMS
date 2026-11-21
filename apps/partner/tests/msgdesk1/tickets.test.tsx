// T0D-MSGDESK-1 — partner portal: My tickets, New ticket, ticket thread with replies (ElabAssist Message To Laboratory, partner side; LD-321, LD-310), static-markup tests (T05 / T19 harness).
// ACs: done_when 3 (New Ticket form and My Tickets list with replies), 4 (headers when empty, text, permission), 5 (partner isolation of the form, empty headers); 07-SECURITY isolation: a partner sees only its own tickets.
// SEAMS (spec fixes behaviour, not file names; the writer follows or disputes):
//  - pages (app)/tickets/page.tsx (h1 "My tickets"), (app)/tickets/new/page.tsx (h1 "New ticket"), (app)/tickets/[ticket_id]/page.tsx (h1 = the subject). Segment files loading.tsx + error.tsx for (app)/tickets.
//  - My tickets: GET /v1/partners/me/tickets (only ?status=new|replied|closed, ?cursor and a limit <= 200 are forwarded). Headers: Subject, Status, Last reply, Created. Rows link to /tickets/<id>.
//    A primary link "New ticket" -> /tickets/new. Status words New, Replied, Closed in a chip with a tone. Empty = the header row AND an EmptyState (lims-state).
//  - New ticket: fields Subject (maxlength 150) and Message (maxlength 2000), one primary button "Send". There is NO party / partner field: the partner comes from the session, never from the form.
//  - Thread: GET /v1/partners/me/tickets/<id> (never /admin/tickets). Messages oldest first; a partner message is labelled "You", a lab message "Lab". A closed ticket shows "This ticket is closed." and no Reply form;
//    an open ticket shows a Reply field (label "Reply", maxlength 2000) and a button "Reply". A non uuid id is a 404 without an API call; an API 404 (another partner's ticket, RLS) is a 404 page.
//  - actions (src/features/tickets/actions.ts, 'use server'): createTicketAction({subject, body}, idempotencyKey) -> POST /v1/partners/me/tickets; replyTicketAction(ticketId, {body}, idempotencyKey) ->
//    POST /v1/partners/me/tickets/<id>/messages; both return { ok: true } | { ok: false, code }.
//  - nav: the shell shows Tickets (/tickets) only with partners.ticket.read.
// Not testable in static markup (dialogs, typing, offline replay of a queued reply) -> notes/T0D-MSGDESK-1-tests.md "NOT tested".
import { createElement } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, run as runRaw } from '../t05/harness';
import { MEMBER_PERMS, attempt, boot, buttons, calls, chipTone, failing, headers, helpKey, hrefs, id, json, primaries, renderPage, resetApi, restoreFetch, seen, serve, title, urls } from '../t19/kit';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => ({ ...(await import('../t05/harness')).navigationMock, useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/tickets', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never) }));

beforeAll(boot);
afterAll(restoreFetch);
beforeEach(() => { resetApi(); urls.length = 0; });

/** The action result itself (the T05 `run` wraps it in { result } and turns a redirect() into { redirect }). */
const run = async <T,>(fn: () => Promise<T>) => (await runRaw(fn)).result as T;
const PERMS = [...MEMBER_PERMS, 'partners.ticket.read', 'partners.ticket.manage'];
const list = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ data: rows, page: { limit: 50 }, ...extra });
const tk = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(n, 700), party_kind: 'partner', party_id: id(1, 900), subject: `Synthetic subject ${n}`, status: 'new', created_by: id(2, 900),
  created_at: '2026-11-18T04:00:00.000Z', updated_at: '2026-11-18T04:00:00.000Z', last_message_at: '2026-11-18T05:30:00.000Z', version: 1, ...o,
});
const msg = (n: number, kind: 'partner' | 'lab', body: string, at: string) => ({ id: id(n, 710), ticket_id: id(1, 700), sender_kind: kind, body, created_by: id(3, 900), created_at: at });
const detail = (ticket: Record<string, unknown>, messages: unknown[]) => ({ ticket, messages });
const noLeak = (o: { html: string; err: unknown }) => {
  if (o.err) expect(String(o.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
  else { expect(o.html).toContain('data-tone="danger"'); expect(o.html).not.toContain('UPSTREAM-SECRET-DETAIL'); }
};
const onlyGets = () => { for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET'); };

describe('My tickets (done_when 3, 4)', () => {
  const rows = [tk(1), tk(2, { status: 'replied' }), tk(3, { status: 'closed', last_message_at: undefined })];
  it('title, helpKey, the four named columns, subject, status chips with a word and a tone, and a row link to the thread', async () => {
    serve({ '/v1/partners/me/tickets': list(rows) }, { perms: PERMS });
    const html = await renderPage('tickets');
    expect(title(html)).toBe('My tickets');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const h of ['Subject', 'Status', 'Last reply', 'Created']) expect(headers(html), h).toContain(h);
    expect(html).toContain('Synthetic subject 1');
    for (const w of ['New', 'Replied', 'Closed']) expect(chipTone(html, w), w).toBeTruthy();
    expect(hrefs(html)).toContain(`/tickets/${id(1, 700)}`);
  });
  it('one primary link "New ticket" to /tickets/new', async () => {
    serve({ '/v1/partners/me/tickets': list(rows) }, { perms: PERMS });
    const html = await renderPage('tickets');
    expect(hrefs(html)).toContain('/tickets/new');
    expect(html).toContain('New ticket');
    expect(primaries(html)).toBeLessThanOrEqual(1);
  });
  it('no tickets: the header row stays AND an EmptyState shows (headers when empty, done_when 4); no made up rows', async () => {
    serve({ '/v1/partners/me/tickets': list([]) }, { perms: PERMS });
    const html = await renderPage('tickets');
    for (const h of ['Subject', 'Status', 'Last reply', 'Created']) expect(headers(html), h).toContain(h);
    expect(html).toContain('lims-state');
    expect(html).not.toMatch(/undefined|NaN/);
  });
  it('failure: ErrorState without upstream detail', async () => {
    serve({ '/v1/partners/me/tickets': failing(500) }, { perms: PERMS });
    noLeak(await attempt('tickets'));
  });
  it('ISOLATION: only the own-tickets path is called (never /admin/tickets), no party filter is ever sent, the page makes no write call', async () => {
    serve({ '/v1/partners/me/tickets': list(rows) }, { perms: PERMS });
    await renderPage('tickets', {}, { party_id: id(9, 900), party_kind: 'partner', partner_id: id(9, 900), evil: '<script>' });
    expect(urls.filter((u) => /\/v1\/partners\//.test(u) && !/\/me($|\?)/.test(new URL(u).pathname)).every((u) => new URL(u).pathname === '/v1/partners/me/tickets')).toBe(true);
    expect(urls.join(' ')).not.toMatch(/admin|party_id|party_kind|partner_id|evil|<script>/);
    onlyGets();
  });
  it('forwards only a known status and a cursor; over-long or unknown values are dropped; the limit is at most 200', async () => {
    serve({ '/v1/partners/me/tickets': list([]) }, { perms: PERMS });
    await renderPage('tickets', {}, { status: 'replied', cursor: 'abc_1' });
    let q = calls('/v1/partners/me/tickets')[0]!.searchParams;
    expect([q.get('status'), q.get('cursor')]).toEqual(['replied', 'abc_1']);
    expect(Number(q.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    urls.length = 0;
    await renderPage('tickets', {}, { status: 'bogus', cursor: '../../x' });
    q = calls('/v1/partners/me/tickets')[0]!.searchParams;
    expect([q.get('status'), q.get('cursor')]).toEqual([null, null]);
  });
  it('subjects are escaped (ST16) and no "commission" or money appears', async () => {
    serve({ '/v1/partners/me/tickets': list([tk(1, { subject: '<img src=x onerror=alert(1)> late' })]) }, { perms: PERMS });
    const html = await renderPage('tickets');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/commission|\bNPR\b/i);
  });
});

describe('New ticket form (done_when 3, 5)', () => {
  it('title, Subject (<= 150) and Message (<= 2000), one primary button "Send"', async () => {
    serve({}, { perms: PERMS });
    const html = await renderPage('tickets/new');
    expect(title(html)).toBe('New ticket');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const l of ['Subject', 'Message']) expect(html, l).toContain(l);
    expect(html).toMatch(/maxlength="150"/i);
    expect(html).toMatch(/maxlength="2000"/i);
    expect(primaries(html)).toBe(1);
    expect(buttons(html).some((b) => b.text === 'Send')).toBe(true);
  });
  it('ISOLATION: no party, partner or tenant field in the form (the partner comes from the session)', async () => {
    serve({}, { perms: PERMS });
    const html = await renderPage('tickets/new');
    expect(html).not.toMatch(/name="(party|partner|tenant|created_by)[a-z_]*"/i);
    expect(html).not.toMatch(/type="hidden"[^>]*(party|partner)/i);
    expect(html).not.toContain(id(1, 900)); // the partner id is not in the page
  });
  it('rendering sends no write call', async () => {
    serve({}, { perms: PERMS });
    await renderPage('tickets/new', {}, { party_id: id(9, 900) });
    onlyGets();
    expect(urls.join(' ')).not.toMatch(/party_id/);
  });
});

describe('ticket thread with replies (done_when 3)', () => {
  const T = tk(1, { status: 'replied', version: 3 });
  const M = [msg(1, 'partner', 'The report is late. (SYNTHETIC)', '2026-11-18T05:30:00.000Z'), msg(2, 'lab', 'We are checking. (SYNTHETIC)', '2026-11-18T06:30:00.000Z'), msg(3, 'partner', 'Thank you. (SYNTHETIC)', '2026-11-18T07:00:00.000Z')];
  const open = (ticket = T, messages: unknown[] = M) => { serve({ [`/v1/partners/me/tickets/${ticket['id' as never]}`]: detail(ticket as never, messages) }, { perms: PERMS }); return renderPage('tickets/[ticket_id]', { ticket_id: String(ticket['id' as never]) }); };
  it('shows the subject as the page title and the messages oldest first with You / Lab labels and a status chip', async () => {
    const html = await open();
    expect(title(html)).toBe('Synthetic subject 1');
    expect(chipTone(html, 'Replied')).toBeTruthy();
    const a = html.indexOf('The report is late');
    const b = html.indexOf('We are checking');
    const c = html.indexOf('Thank you');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(html).toMatch(/>You</);
    expect(html).toMatch(/>Lab</);
    expect(hrefs(html)).toContain('/tickets');
  });
  it('an open ticket has a Reply field (<= 2000) and one primary "Reply" button', async () => {
    const html = await open();
    expect(html).toMatch(/maxlength="2000"/i);
    expect(buttons(html).some((b) => b.text === 'Reply')).toBe(true);
    expect(primaries(html)).toBe(1);
  });
  it('a closed ticket says "This ticket is closed." and offers no Reply form', async () => {
    const html = await open(tk(1, { status: 'closed', version: 5 }));
    expect(html).toContain('This ticket is closed.');
    expect(buttons(html).some((b) => b.text === 'Reply')).toBe(false);
    expect(html).not.toMatch(/maxlength="2000"/i);
  });
  it('message text and subject are escaped (ST16)', async () => {
    const html = await open(tk(1, { subject: '<script>alert(2)</script> subject' }), [msg(1, 'lab', '<img src=x onerror=alert(1)>', '2026-11-18T06:30:00.000Z')]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
  });
  it('ISOLATION: only /v1/partners/me/tickets/<id> is read (never /admin/tickets); no write call while rendering', async () => {
    await open();
    expect(urls.join(' ')).not.toMatch(/admin/);
    expect(urls.some((u) => new URL(u).pathname === `/v1/partners/me/tickets/${T['id']}`)).toBe(true);
    onlyGets();
  });
  it("another partner's ticket (the API answers 404 through RLS) is a 404 page, with no upstream detail", async () => {
    serve({ [`/v1/partners/me/tickets/${id(9, 700)}`]: failing(404, 'common.not_found') }, { perms: PERMS });
    const o = await attempt('tickets/[ticket_id]', { ticket_id: id(9, 700) });
    expect(String(o.err)).toMatch(/NEXT_NOT_FOUND/);
  });
  it('a malformed ticket id is a 404 and never reaches the API', async () => {
    serve({}, { perms: PERMS });
    for (const bad of ['abc', '../admin/tickets', '%2e%2e', `${id(1, 700)}/close`, 'new1']) {
      urls.length = 0;
      const o = await attempt('tickets/[ticket_id]', { ticket_id: bad });
      expect(String(o.err), bad).toMatch(/NEXT_NOT_FOUND/);
      expect(urls.filter((u) => /\/v1\/partners\/me\/tickets/.test(u)), bad).toEqual([]);
    }
  });
  it('failure: ErrorState without upstream detail', async () => {
    serve({ [`/v1/partners/me/tickets/${T['id']}`]: failing(500) }, { perms: PERMS });
    noLeak(await attempt('tickets/[ticket_id]', { ticket_id: String(T['id']) }));
  });
});

describe('shell navigation', () => {
  const layout = async () => {
    const mod = (await import('../../src/app/(app)/layout.tsx')) as { default: (p: { children: unknown }) => unknown };
    const { renderToStaticMarkup } = await import('react-dom/server');
    return renderToStaticMarkup((await mod.default({ children: createElement('p', null, 'CHILD') })) as never);
  };
  it('Tickets (/tickets) shows only with partners.ticket.read', async () => {
    serve({}, { perms: PERMS });
    const withIt = await layout();
    expect(hrefs(withIt)).toContain('/tickets');
    expect(withIt).toContain('Tickets');
    serve({}, { perms: MEMBER_PERMS });
    expect(hrefs(await layout())).not.toContain('/tickets');
  });
});

describe('actions (src/features/tickets/actions.ts): isolation and input checks', () => {
  type A = { createTicketAction: (i: unknown, k: string) => Promise<{ ok: boolean; code?: string }>; replyTicketAction: (t: string, i: unknown, k: string) => Promise<{ ok: boolean; code?: string }> };
  let A: A;
  beforeAll(async () => { A = (await import('../../src/features/tickets/actions')) as unknown as A; });
  const KEY = 'key-ticket-0001';
  const posts = () => seen.filter((s) => !s.path.startsWith(AUTH) && s.method === 'POST');
  const ok201 = (o: unknown) => () => json(201, o);

  it('createTicketAction POSTs /v1/partners/me/tickets with ONLY {subject, body} and the Idempotency-Key; the party is never sent', async () => {
    serve({ '/v1/partners/me/tickets': ok201(tk(5)) });
    const r = await run(() => A.createTicketAction({ subject: 'Synthetic subject', body: 'Synthetic body', party_id: id(9, 900), party_kind: 'partner', created_by: id(9, 900), status: 'closed' }, KEY));
    expect(r).toMatchObject({ ok: true });
    const [c] = posts();
    expect(c?.path).toBe('/v1/partners/me/tickets');
    expect(c?.body).toEqual({ subject: 'Synthetic subject', body: 'Synthetic body' });
    expect(c?.headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.stringify(seen.map((s) => s.body))).not.toContain(id(9, 900));
  });
  it('createTicketAction refuses a blank or over-long subject / body and a bad Idempotency-Key BEFORE any call', async () => {
    serve({ '/v1/partners/me/tickets': ok201(tk(5)) });
    const bad: [unknown, string][] = [
      [{ subject: '', body: 'x' }, KEY], [{ subject: '   ', body: 'x' }, KEY], [{ subject: 'x', body: '' }, KEY], [{ subject: 'x'.repeat(151), body: 'x' }, KEY], [{ subject: 'x', body: 'x'.repeat(2001) }, KEY],
      [{ subject: 'x', body: 'x' }, 'short'], [{ subject: 'x', body: 'x' }, 'bad key with spaces!!'], [{ subject: 1, body: 'x' }, KEY], [null, KEY], [undefined, KEY],
    ];
    for (const [input, key] of bad) {
      const r = await run(() => A.createTicketAction(input, key));
      expect(r, JSON.stringify(input)?.slice(0, 40)).toMatchObject({ ok: false, code: 'common.validation_failed' });
    }
    expect(posts()).toEqual([]);
  });
  it('createTicketAction returns only { ok, code } on failure: the upstream detail never reaches the browser', async () => {
    serve({ '/v1/partners/me/tickets': () => failing(422, 'common.validation_failed') });
    const r = await run(() => A.createTicketAction({ subject: 'x', body: 'y' }, KEY));
    expect(r).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(JSON.stringify(r)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
  });
  it('replyTicketAction POSTs /v1/partners/me/tickets/<id>/messages with ONLY {body} and the Idempotency-Key (the key makes an offline replay store once)', async () => {
    serve({ [`/v1/partners/me/tickets/${id(1, 700)}/messages`]: ok201(msg(7, 'partner', 'x', '2026-11-18T06:30:00.000Z')) });
    const r = await run(() => A.replyTicketAction(id(1, 700), { body: 'Synthetic reply', sender_kind: 'lab', party_id: id(9, 900) }, KEY));
    expect(r).toMatchObject({ ok: true });
    const [c] = posts();
    expect(c?.path).toBe(`/v1/partners/me/tickets/${id(1, 700)}/messages`);
    expect(c?.body).toEqual({ body: 'Synthetic reply' }); // sender_kind is derived from the actor, never client input
    expect(c?.headers.get('idempotency-key')).toBe(KEY);
  });
  it('replyTicketAction refuses a non uuid ticket id, a blank or over-long body and a bad key BEFORE any call (no path injection)', async () => {
    serve({});
    const bad: [string, unknown, string][] = [
      ['abc', { body: 'x' }, KEY], ['../admin/tickets/' + id(1, 700), { body: 'x' }, KEY], [`${id(1, 700)}/close`, { body: 'x' }, KEY], ['%2e%2e', { body: 'x' }, KEY],
      [id(1, 700), { body: '' }, KEY], [id(1, 700), { body: '  ' }, KEY], [id(1, 700), { body: 'x'.repeat(2001) }, KEY], [id(1, 700), { body: 'x' }, 'no'], [id(1, 700), null, KEY],
    ];
    for (const [t, input, key] of bad) {
      const r = await run(() => A.replyTicketAction(t, input, key));
      expect(r, t).toMatchObject({ ok: false, code: 'common.validation_failed' });
    }
    expect(posts()).toEqual([]);
  });
  it('a closed ticket (409 partners.ticket_invalid_transition) comes back as that code so the form can say so', async () => {
    serve({ [`/v1/partners/me/tickets/${id(1, 700)}/messages`]: () => failing(409, 'partners.ticket_invalid_transition') });
    expect(await run(() => A.replyTicketAction(id(1, 700), { body: 'x' }, KEY))).toMatchObject({ ok: false, code: 'partners.ticket_invalid_transition' });
  });
  it('both actions send nothing to /admin/tickets, close or reopen: a partner can only create and reply', async () => {
    serve({ '/v1/partners/me/tickets': ok201(tk(5)), [`/v1/partners/me/tickets/${id(1, 700)}/messages`]: ok201(msg(7, 'partner', 'x', '2026-11-18T06:30:00.000Z')) });
    await run(() => A.createTicketAction({ subject: 'x', body: 'y' }, KEY));
    await run(() => A.replyTicketAction(id(1, 700), { body: 'y' }, KEY));
    for (const s of seen) expect(s.path).not.toMatch(/admin|\/close|\/reopen/);
    expect(Object.keys(A).sort()).toEqual(['createTicketAction', 'replyTicketAction']);
  });
});
