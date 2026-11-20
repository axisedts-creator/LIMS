// T0D-MSGDESK-1 shared harness (tester-owned): synthetic fixtures + a stateful MSW stand-in for the 11 broadcast operations of contracts/openapi/engagement.yaml
// (/v1/engagement/broadcast-templates, /broadcasts, /broadcast-audience-previews) and the 6 lab side ticket operations of partners.yaml (/v1/partners/admin/tickets),
// plus the partner name read the inbox uses. Screens are reached through the PAGE default exports (async server components: page -> serverFetch -> MSW -> client parts).
// Synthetic data only; every phone and e-mail below is made up.
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

type TMState = {
  nav: { search: string; path: string };
  session: { permissions: string[] };
  actorId: string;
  navLog: string[];
  push: { mockClear: () => void; mock: { calls: unknown[][] } };
  replace: { mockClear: () => void; mock: { calls: unknown[][] } };
  refresh: { mockReset: () => void; mockClear: () => void; mock: { calls: unknown[][] } };
};
export const TM = (globalThis as unknown as { __TM: TMState }).__TM;

type Rec = Record<string, any>;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
export const TS = '2026-11-18T04:00:00.000Z';
export const USER_A = ID(901); // the requester of the fixtures
export const USER_B = ID(902); // a second person (the default signed-in user)
export const E = `${ORIGIN}/v1/engagement`;
export const P = `${ORIGIN}/v1/partners`;

export const READ = ['engagement.broadcast.read'];
export const MANAGE = ['engagement.broadcast.read', 'engagement.broadcast.manage'];
export const APPROVE = ['engagement.broadcast.read', 'engagement.broadcast.manage', 'engagement.broadcast.approve'];
export const TREAD = ['partners.ticket.read', 'partners.partner.read'];
export const TMANAGE = ['partners.ticket.read', 'partners.ticket.manage', 'partners.partner.read'];

// ---- templates -----------------------------------------------------------------------------------------------------------------------------------------------
const tpl = (n: number, name: string, channel: string, body: string, placeholders: string[], o: Rec = {}): Rec => ({ id: ID(n), name, channel, body, placeholders, is_active: true, version: 1, created_at: TS, updated_at: TS, ...o });
export const T_SMS = tpl(1, 'Synthetic Holiday notice', 'sms', 'Dear {{party_name}}, {{lab_name}} is closed on {{send_date}}.', ['party_name', 'lab_name', 'send_date'], { version: 2 });
export const T_MAIL = tpl(2, 'Synthetic Price update', 'email', 'Hello {{party_name}}, our price list changed. Call {{lab_phone}}.', ['party_name', 'lab_phone'], { subject: 'Synthetic price update' });
export const T_WA = tpl(3, 'Synthetic Old campaign', 'whatsapp', 'Hi {{party_name}}.', ['party_name'], { is_active: false, version: 4 });
export const TEMPLATES = [T_SMS, T_MAIL, T_WA];

// ---- broadcasts ----------------------------------------------------------------------------------------------------------------------------------------------
const bc = (n: number, template: Rec, kinds: string[], status: string, count: number, o: Rec = {}): Rec => ({
  id: ID(n), template_id: template['id'], audience_filter: { party_kinds: kinds, active_only: true }, status, recipient_count: count, opted_out_count: 0,
  requested_by: USER_A, created_at: TS, updated_at: TS, version: 1, ...o,
});
export const B_DRAFT = bc(11, T_SMS, ['client'], 'draft', 12);
export const B_PEND = bc(12, T_MAIL, ['laboratory', 'franchise'], 'pending_approval', 120, { opted_out_count: 4, version: 2 });
export const B_SENT = bc(13, T_SMS, ['client', 'lab_user'], 'sent', 80, { opted_out_count: 2, approved_by: USER_B, approved_at: TS, version: 5 });
export const B_CANC = bc(14, T_MAIL, ['laboratory'], 'cancelled', 7, { version: 3 });
export const BROADCASTS = [B_DRAFT, B_PEND, B_SENT, B_CANC];

const rcp = (n: number, kind: string, addr: string, status: string, o: Rec = {}): Rec => ({ id: ID(n), broadcast_id: B_SENT['id'], party_kind: kind, party_id: ID(n + 500), channel_address: addr, status, ...o });
export const RECIPIENTS = [
  rcp(71, 'client', '+97798****101', 'sent', { outbox_id: ID(871) }),
  rcp(72, 'client', '+97798****102', 'failed', { outbox_id: ID(872) }),
  rcp(73, 'lab_user', 'a***@example.test', 'queued', { outbox_id: ID(873) }),
  rcp(74, 'client', '+97798****104', 'skipped', { skip_reason: 'opted_out' }),
  rcp(75, 'lab_user', '+97798****105', 'skipped', { skip_reason: 'no_address' }),
];
export const SAMPLE = [
  { party_kind: 'client', party_id: ID(601), channel_address: '+97798****601' },
  { party_kind: 'client', party_id: ID(602), channel_address: '+97798****602' },
  { party_kind: 'laboratory', party_id: ID(603), channel_address: 'l***@example.test' },
];

// ---- partners and tickets -------------------------------------------------------------------------------------------------------------------------------------
export const PARTNER1 = { id: ID(31), partner_code: 'P1', name: 'Synthetic Partner Lab One', display_name: 'Synthetic Partner Lab One', status: 'active', version: 1 };
export const PARTNER2 = { id: ID(32), partner_code: 'P2', name: 'Synthetic Partner Lab Two', display_name: 'Synthetic Partner Lab Two', status: 'active', version: 1 };
const tk = (n: number, party: Rec, subject: string, status: string, o: Rec = {}): Rec => ({ id: ID(n), party_kind: 'partner', party_id: party['id'], subject, status, created_by: ID(950 + n), created_at: TS, updated_at: TS, last_message_at: '2026-11-18T05:30:00.000Z', version: 1, ...o });
export const TK_NEW = tk(41, PARTNER1, 'Report delay (SYNTHETIC)', 'new');
export const TK_REP = tk(42, PARTNER2, 'Wrong sample label (SYNTHETIC)', 'replied', { version: 3, last_message_at: '2026-11-18T07:10:00.000Z' });
export const TK_CLO = tk(43, PARTNER1, 'Invoice question (SYNTHETIC)', 'closed', { version: 5, last_message_at: undefined });
export const TICKETS = [TK_NEW, TK_REP, TK_CLO];
const msg = (n: number, ticket: Rec, kind: string, body: string, at: string): Rec => ({ id: ID(n), ticket_id: ticket['id'], sender_kind: kind, body, created_by: ID(960 + n), created_at: at });
export const MESSAGES: Record<string, Rec[]> = {
  [TK_NEW['id']]: [msg(81, TK_NEW, 'partner', 'The report for sample 12 is late. (SYNTHETIC)', '2026-11-18T05:30:00.000Z')],
  [TK_REP['id']]: [
    msg(82, TK_REP, 'partner', 'The label on tube 3 is wrong. (SYNTHETIC)', '2026-11-18T06:00:00.000Z'),
    msg(83, TK_REP, 'lab', 'We checked it and fixed the label. (SYNTHETIC)', '2026-11-18T07:10:00.000Z'),
    msg(84, TK_REP, 'partner', '<img src=x onerror=alert(1)> thanks (SYNTHETIC)', '2026-11-18T07:40:00.000Z'),
  ],
  [TK_CLO['id']]: [msg(85, TK_CLO, 'partner', 'Please resend the statement. (SYNTHETIC)', '2026-11-17T05:00:00.000Z'), msg(86, TK_CLO, 'lab', 'Sent by e-mail. (SYNTHETIC)', '2026-11-17T06:00:00.000Z')],
};

// ---- stateful API stand-in -------------------------------------------------------------------------------------------------------------------------------------
export type Call = { method: string; path: string; search: URLSearchParams; headers: Headers; json?: any };
export const API = {
  calls: [] as Call[],
  templates: TEMPLATES as Rec[],
  broadcasts: BROADCASTS as Rec[],
  recipients: { [B_SENT['id']]: RECIPIENTS } as Record<string, Rec[]>,
  tickets: TICKETS as Rec[],
  partners: [PARTNER1, PARTNER2] as Rec[],
  /** list reads answer this status instead of the data (403 / 500). */
  listFail: undefined as undefined | 403 | 500,
  /** only the recipients read fails (the page must keep the broadcast table). */
  recipientsFail: false,
  nextCursor: undefined as undefined | string,
  /** the next write answers this (one shot). */
  fail: undefined as undefined | Response,
  writeDelayMs: 0,
  /** the audience preview: count = 10 per party kind (+5 when active_only is false); opted out = 1 per kind; a preview of exactly ONE kind is answered slowly (race test). */
  previewSlowMs: 0,
  previewFail: undefined as undefined | 500,
  previewCountOverride: undefined as undefined | number,
  reset() {
    this.calls.length = 0; this.templates = TEMPLATES; this.broadcasts = BROADCASTS; this.recipients = { [B_SENT['id']]: RECIPIENTS }; this.tickets = TICKETS; this.partners = [PARTNER1, PARTNER2];
    this.listFail = undefined; this.recipientsFail = false; this.nextCursor = undefined; this.fail = undefined; this.writeDelayMs = 0;
    this.previewSlowMs = 0; this.previewFail = undefined; this.previewCountOverride = undefined;
  },
  find: (method: string, re: RegExp) => API.calls.filter((c) => c.method === method && re.test(c.path)),
  writes: () => API.calls.filter((c) => c.method !== 'GET' && !/broadcast-audience-previews$/.test(c.path)),
  previews: () => API.calls.filter((c) => c.method === 'POST' && /broadcast-audience-previews$/.test(c.path)),
};
export const prob = (status: number, code: string, errors?: { path: string; code: string; message: string }[]) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162', ...(errors ? { errors } : {}) }, { status, headers: { 'content-type': 'application/problem+json' } });

const rec = async (request: Request) => {
  const u = new URL(request.url);
  API.calls.push({ method: request.method, path: u.pathname, search: u.searchParams, headers: request.headers, ...(request.method === 'GET' ? {} : { json: await request.clone().json().catch(() => undefined) }) });
};
const wait = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : undefined);
const page = (data: Rec[]) => HttpResponse.json({ data, page: { limit: 50, ...(API.nextCursor ? { next_cursor: API.nextCursor } : {}) } });
const list = (get: (q: URLSearchParams) => Rec[]) => async ({ request }: { request: Request }) => {
  await rec(request);
  if (API.listFail === 403) return prob(403, 'auth.forbidden');
  if (API.listFail === 500) return prob(500, 'common.internal');
  return page(get(new URL(request.url).searchParams));
};
/** A write: recorded, optionally delayed, answers the queued failure once, else `ok`. */
const write = (ok: (body: Rec, params: Record<string, string | readonly string[] | undefined>) => Response) => async ({ request, params }: { request: Request; params: Record<string, string | readonly string[] | undefined> }) => {
  await rec(request);
  await wait(API.writeDelayMs);
  if (API.fail) { const f = API.fail; API.fail = undefined; return f; }
  return ok(API.calls[API.calls.length - 1]!.json ?? {}, params);
};
const byId = (rows: Rec[], p: Record<string, any>) => rows.find((r) => r['id'] === p['id']) ?? rows[0]!;
const moved = (p: Record<string, any>, status: string, extra: Rec = {}) => ({ ...byId(API.broadcasts.concat(BROADCASTS), { id: p['broadcast_id'] }), status, version: 9, ...extra });

export const api = setupServer(
  // templates
  http.get(`${E}/broadcast-templates`, list((q) => API.templates.filter((t) => (q.get('is_active') === null || String(t['is_active']) === q.get('is_active')) && (!q.get('channel') || t['channel'] === q.get('channel'))))),
  http.post(`${E}/broadcast-templates/:id/deactivate`, write((_b, p) => HttpResponse.json({ ...byId(TEMPLATES, p), is_active: false, version: 9 }))),
  http.patch(`${E}/broadcast-templates/:id`, write((b, p) => HttpResponse.json({ ...byId(TEMPLATES, p), ...b, version: 9 }))),
  http.post(`${E}/broadcast-templates`, write((b) => HttpResponse.json(tpl(19, b['name'], b['channel'], b['body'], [], b['subject'] ? { subject: b['subject'] } : {}), { status: 201 }))),
  // broadcasts
  http.get(`${E}/broadcasts/:broadcast_id/recipients`, async ({ request, params }) => {
    await rec(request);
    if (API.recipientsFail) return prob(500, 'common.internal');
    return page(API.recipients[String(params['broadcast_id'])] ?? []);
  }),
  http.post(`${E}/broadcasts/:broadcast_id/request-approval`, write((_b, p) => HttpResponse.json(moved(p, 'pending_approval')))),
  http.post(`${E}/broadcasts/:broadcast_id/approve`, write((_b, p) => HttpResponse.json(moved(p, 'sending', { approved_by: USER_B, approved_at: TS })))),
  http.post(`${E}/broadcasts/:broadcast_id/cancel`, write((_b, p) => HttpResponse.json(moved(p, 'cancelled')))),
  http.get(`${E}/broadcasts`, list((q) => API.broadcasts.filter((b) => !q.get('status') || b['status'] === q.get('status')))),
  http.post(`${E}/broadcasts`, write((b) => HttpResponse.json({ ...bc(99, byId(TEMPLATES, { id: b['template_id'] }), b['audience_filter']?.['party_kinds'] ?? [], 'draft', 20), audience_filter: b['audience_filter'] }, { status: 201 }))),
  http.post(`${E}/broadcast-audience-previews`, async ({ request }) => {
    await rec(request);
    const body = API.calls[API.calls.length - 1]!.json ?? {};
    const kinds: string[] = body.audience_filter?.party_kinds ?? [];
    if (kinds.length === 1) await wait(API.previewSlowMs);
    if (API.previewFail) return prob(500, 'common.internal');
    const n = API.previewCountOverride ?? kinds.length * 10 + (body.audience_filter?.active_only === false ? 5 : 0);
    return HttpResponse.json({ recipient_count: n, opted_out_count: kinds.length, sample: n === 0 ? [] : SAMPLE });
  }),
  // partners and tickets (lab side)
  http.get(`${P}/admin/partners`, list(() => API.partners)),
  http.post(`${P}/admin/tickets/:id/messages`, write((b, p) => HttpResponse.json({ id: ID(89), ticket_id: p['id'], sender_kind: 'lab', body: b['body'], created_by: USER_B, created_at: TS }, { status: 201 }))),
  http.post(`${P}/admin/tickets/:id/close`, write((_b, p) => HttpResponse.json({ ...byId(TICKETS, p), status: 'closed', version: 9 }))),
  http.post(`${P}/admin/tickets/:id/reopen`, write((_b, p) => HttpResponse.json({ ...byId(TICKETS, p), status: 'replied', version: 9 }))),
  http.get(`${P}/admin/tickets/:id`, async ({ request, params }) => {
    await rec(request);
    if (API.listFail === 500) return prob(500, 'common.internal');
    const t = API.tickets.find((x) => x['id'] === params['id']);
    if (!t) return prob(404, 'common.not_found');
    return HttpResponse.json({ ticket: t, messages: MESSAGES[t['id']] ?? [] });
  }),
  http.get(`${P}/admin/tickets`, list((q) => API.tickets.filter((t) => (!q.get('status') || t['status'] === q.get('status')) && (!q.get('party_id') || t['party_id'] === q.get('party_id'))))),
  http.post(`${P}/admin/tickets`, write((b) => HttpResponse.json(tk(49, { id: b['party_id'] }, b['subject'], 'new'), { status: 201 }))),
  http.get(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return page([]); }),
);

type PageMod = { default: (p: unknown) => Promise<React.ReactNode> };
const PAGES = {
  ...(import.meta.glob('../../../app/[(]staff[)]/engagement/messages/**/page.tsx') as Record<string, () => Promise<unknown>>),
  ...(import.meta.glob('../../../app/[(]staff[)]/partners/tickets/**/page.tsx') as Record<string, () => Promise<unknown>>),
};
/** Open `app/(staff)/<route>/page.tsx` like Next: the server page runs first (a throw = error.tsx / notFound), then the client parts render. */
export async function openPage(route: string, opts: { perms?: string[]; search?: string; params?: Record<string, string>; actor?: string } = {}): Promise<ReturnType<typeof render>> {
  TM.session.permissions = opts.perms ?? MANAGE;
  TM.nav.search = opts.search ?? '';
  TM.nav.path = `/${route.replace(/\[ticket_id\]/, ID(41))}`;
  TM.actorId = opts.actor ?? USER_B;
  const load = PAGES[`../../../app/(staff)/${route}/page.tsx`];
  if (!load) throw new Error(`missing page file app/(staff)/${route}/page.tsx`);
  const mod = (await load()) as PageMod;
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve(opts.params ?? {}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(opts.search ?? ''))) })}</ToastProvider>);
}
export const TEMPLATES_ROUTE = 'engagement/messages/templates';
export const BROADCASTS_ROUTE = 'engagement/messages/broadcasts';
export const TICKETS_ROUTE = 'partners/tickets';
export const THREAD_ROUTE = 'partners/tickets/[ticket_id]';
export const PATH = (route: string) => `/${route}`;

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const rowOf = (text: RegExp | string) => screen.getAllByRole('row').find((r) => (typeof text === 'string' ? r.textContent!.includes(text) : text.test(r.textContent ?? '')))!;
export const headers = () => screen.getAllByRole('columnheader').map((h) => norm(h.textContent));
export const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
export const reasonOf = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
export const quiet = (ms = 60) => new Promise((r) => setTimeout(r, ms));
export const IDEM = /^[A-Za-z0-9_-]{1,64}$/;
export const selectTrigger = (scope: HTMLElement, label: RegExp) => within(scope).getByLabelText(label, { selector: 'button' });
export const pickOption = async (user: { click: (e: Element) => Promise<void> }, scope: HTMLElement, label: RegExp, option: RegExp) => {
  await user.click(selectTrigger(scope, label));
  await user.click(await screen.findByRole('option', { name: option }));
};
export const optionNames = () => screen.getAllByRole('option').map((o) => norm(o.textContent));
