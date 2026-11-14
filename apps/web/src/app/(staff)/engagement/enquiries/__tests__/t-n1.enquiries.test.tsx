// @vitest-environment jsdom
// T-N1 — Staff web W11 Enquiries (04-UI-UX §3 W11; 03-APP-FLOW §5 W11 / §10 empty state "No open enquiries"; 02-TRD §5 N1-N4; PRD US-EN-18.1/18.2/18.4; 07-SECURITY §3 + §5 (P3 free text, staff UI warns
// against results in replies); LD-140 design rules). Fails now: enquiries/ has no source.
// ASSUMED module/prop contract (spec fixes only the folder + kit components; dispute via writer if wrong). Files under apps/web/src/app/(staff)/engagement/enquiries/:
//   EnquiriesView.tsx   export EnquiriesView({ enquiries, categories, permissions })  — inbox (N1). enquiries: EnquirySummary[] (id, category_code, subject, status, profile_id?, last_message_at, version);
//       categories: {code, display}[] (T3a enquiry_categories, shown as "Topic"); permissions: readonly string[].
//       DataTable columns "Last message" · "Topic" · "Subject" · "Status" (word, not colour only); each subject is a link to /engagement/enquiries/<id>; a status filter (select button "Status": All | Open | Answered | Closed)
//       re-requests N1 through the page (router.replace with ?status=...). Empty list -> text "No open enquiries". No phone column (EnquirySummary carries none).
//   EnquiryThread.tsx   export EnquiryThread({ enquiry, permissions }) — thread page (N2/N3/N4). enquiry: StaffEnquiry (+ messages[{author_kind, body, created_at}], version, status).
//       Messages as a list (role list), each labelled "Patient" or "Lab" + time; warning text (role note/alert) "Don't include test results in replies; ask the patient to open their report in the app.";
//       textbox "Reply" (maxLength 2000, live counter "<n> / 2000"), button "Send" (Ctrl+Enter inside the box also sends), button "Close" (Alt+X anywhere) -> confirm dialog with button "Close enquiry".
//       Reply/Close only with engagement.enquiry.respond; status closed -> no reply box, text "This conversation is closed." Exactly ONE primary button per page ("Send").
//   page.tsx / [enquiry_id]/page.tsx / actions.ts ('use server') -> serverFetch -> MSW observes: GET /v1/engagement/enquiries, POST /v1/engagement/enquiries/:id/messages {message} (Idempotency-Key + If-Match "<version>"),
//       POST /v1/engagement/enquiries/:id/close (If-Match "<version>"). After success the view refreshes (router.refresh) and shows the returned thread.
//   Copy chosen by this tester (dispute if the spec wording differs): 409 enquiry_invalid_transition "This conversation is closed."; 409 version_conflict "This conversation changed. Reload to continue.".
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh, back: vi.fn() }),
  usePathname: () => '/engagement/enquiries',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['engagement.enquiry.read', 'engagement.enquiry.respond'], displayName: 'Synthetic Front Desk', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/engagement/enquiries',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const E1 = U(1), E2 = U(2), E3 = U(3);
const READ = ['engagement.enquiry.read'];
const FULL = ['engagement.enquiry.read', 'engagement.enquiry.respond'];
const SECRET_BODY = 'PRIVATE-enquiry-text-7731';
const categories = [{ code: 'report', display: 'Report' }, { code: 'booking', display: 'Booking' }];
const summaries = [
  { id: E1, category_code: 'report', subject: 'Where is my report? (synthetic)', status: 'open', last_message_at: '2026-11-04T10:00:00.000Z', version: 3 },
  { id: E2, category_code: 'booking', subject: 'Change my booking (synthetic)', status: 'answered', last_message_at: '2026-11-03T10:00:00.000Z', version: 4 },
  { id: E3, category_code: 'report', subject: 'Old question (synthetic)', status: 'closed', last_message_at: '2026-11-02T10:00:00.000Z', version: 5 },
];
const thread = (o: Record<string, unknown> = {}) => ({
  id: E1, category_code: 'report', subject: 'Where is my report? (synthetic)', status: 'open', last_message_at: '2026-11-04T10:00:00.000Z', patient_id: U(90), version: 3,
  messages: [{ author_kind: 'patient', body: 'Synthetic: when will my report be ready?', created_at: '2026-11-04T10:00:00.000Z' }, ...(o['extra'] as unknown[] ?? [])], ...o,
});

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, title: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code }, { status });
const answered = () => thread({ status: 'answered', version: 4, messages: [{ author_kind: 'patient', body: 'Synthetic: when will my report be ready?', created_at: '2026-11-04T10:00:00.000Z' }, { author_kind: 'staff', body: SECRET_BODY, created_at: '2026-11-05T04:15:00.000Z' }] });
let replyResult: () => Response = () => HttpResponse.json(answered());
let closeResult: () => Response = () => HttpResponse.json(thread({ status: 'closed', version: 4 }));
const api = setupServer(
  http.get(`${ORIGIN}/v1/engagement/enquiries`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: summaries, page: { limit: 50 } }); }),
  http.get(`${ORIGIN}/v1/engagement/enquiries/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(thread()); }),
  http.post(`${ORIGIN}/v1/engagement/enquiries/:id/messages`, async ({ request }) => { await rec(request); return replyResult(); }),
  http.post(`${ORIGIN}/v1/engagement/enquiries/:id/close`, async ({ request }) => { await rec(request); return closeResult(); }),
);
const setItem = vi.spyOn(Storage.prototype, 'setItem');
const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  expect(setItem).not.toHaveBeenCalled(); // 04-UI-UX §1: nothing about patients in browser storage
  expect(JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String))))).not.toContain(SECRET_BODY); // P3 text is never logged
  cleanup(); api.resetHandlers(); calls.length = 0; replace.mockReset(); refresh.mockReset(); setItem.mockClear(); consoleSpies.forEach((s) => s.mockClear()); localStorage.clear(); sessionStorage.clear();
  replyResult = () => HttpResponse.json(answered());
  closeResult = () => HttpResponse.json(thread({ status: 'closed', version: 4 }));
});
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const loadInbox = async () => ((await import(/* @vite-ignore */ `../${'EnquiriesView'}`)) as { EnquiriesView: any }).EnquiriesView;
const loadThread = async () => ((await import(/* @vite-ignore */ `../${'EnquiryThread'}`)) as { EnquiryThread: any }).EnquiryThread;
const inbox = async (p: { enquiries?: unknown[]; permissions?: readonly string[] } = {}) => { const V = await loadInbox(); return wrap(<V enquiries={p.enquiries ?? summaries} categories={categories} permissions={p.permissions ?? READ} />); };
const openThread = async (p: { enquiry?: unknown; permissions?: readonly string[] } = {}) => { const V = await loadThread(); return wrap(<V enquiry={p.enquiry ?? thread()} permissions={p.permissions ?? FULL} />); };
const posts = (suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith(suffix));

describe('W11 inbox (N1)', () => {
  it('DataTable with Last message · Topic · Subject · Status; topic shows the coded display, status is a word; no phone column', async () => {
    await inbox();
    for (const h of ['Last message', 'Topic', 'Subject', 'Status']) expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: /phone/i })).toBeNull();
    const row = screen.getByRole('row', { name: /Where is my report/ });
    expect(within(row).getByText('Report')).toBeTruthy();
    expect(within(row).getByText(/^open$/i)).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /Old question/ })).getByText(/^closed$/i)).toBeTruthy();
  });
  it('each subject links to the thread page /engagement/enquiries/<id>', async () => {
    await inbox();
    expect(screen.getByRole('link', { name: /Where is my report/ }).getAttribute('href')).toBe(`/engagement/enquiries/${E1}`);
  });
  it('empty list -> "No open enquiries"', async () => {
    await inbox({ enquiries: [] });
    expect(screen.getByText('No open enquiries')).toBeTruthy();
  });
  it('status filter re-requests through the router (?status=open), nothing is stored in the browser', async () => {
    await inbox();
    await userEvent.click(screen.getByRole('button', { name: /status/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Open' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(String(replace.mock.calls[0]![0])).toMatch(/status=open/);
  });
  it('no axe violations', async () => { await inbox(); await noAxeViolations(); });
});

describe('W11 thread (N2, N3, N4; US-EN-18.2)', () => {
  it('shows the messages with who wrote them, and the warning against sending results', async () => {
    await openThread({ enquiry: answered() });
    const items = within(screen.getByRole('list', { name: /messages/i })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Patient')).toBeTruthy();
    expect(within(items[1]!).getByText('Lab')).toBeTruthy();
    expect(screen.getByText("Don't include test results in replies; ask the patient to open their report in the app.")).toBeTruthy();
  });
  it('Send posts {message} to /enquiries/:id/messages with Idempotency-Key and If-Match "<version>"; the new thread shows and the page refreshes', async () => {
    await openThread();
    const box = screen.getByRole('textbox', { name: 'Reply' });
    await userEvent.type(box, SECRET_BODY);
    expect(screen.getByText(`${SECRET_BODY.length} / 2000`)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts('/messages')).toHaveLength(1));
    const c = posts('/messages')[0]!;
    expect(c.url.pathname).toBe(`/v1/engagement/enquiries/${E1}/messages`);
    expect(c.body).toEqual({ message: SECRET_BODY });
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(c.url.search).toBe(''); // text never in a URL
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it('Ctrl+Enter in the reply box sends; an empty reply is never sent', async () => {
    await openThread();
    const box = screen.getByRole('textbox', { name: 'Reply' });
    await userEvent.click(box);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(posts('/messages')).toHaveLength(0);
    await userEvent.type(box, 'hello{Control>}{Enter}{/Control}');
    await waitFor(() => expect(posts('/messages')).toHaveLength(1));
  });
  it('the reply box stops at 2000 characters', async () => {
    await openThread();
    const box = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(2000);
  });
  it('Close asks for confirmation, then posts to /enquiries/:id/close with If-Match "<version>" and no body text', async () => {
    await openThread();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(posts('/close')).toHaveLength(0); // not before the confirm
    await userEvent.click(await screen.findByRole('button', { name: 'Close enquiry' }));
    await waitFor(() => expect(posts('/close')).toHaveLength(1));
    expect(posts('/close')[0]!.url.pathname).toBe(`/v1/engagement/enquiries/${E1}/close`);
    expect(posts('/close')[0]!.headers.get('if-match')).toBe('"3"');
  });
  it('a closed thread has no reply box and no Send / Close; it says "This conversation is closed."', async () => {
    await openThread({ enquiry: thread({ status: 'closed', version: 5 }) });
    expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByText('This conversation is closed.')).toBeTruthy();
  });
  it('read-only users (engagement.enquiry.read) see the thread but no reply box, Send or Close', async () => {
    await openThread({ permissions: READ });
    expect(screen.getByRole('list', { name: /messages/i })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
  it('409 engagement.enquiry_invalid_transition on Send -> "This conversation is closed."; the typed text stays in the box', async () => {
    replyResult = () => problem(409, 'engagement.enquiry_invalid_transition', 'Enquiry cannot change');
    await openThread();
    const box = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
    await userEvent.type(box, 'late');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This conversation is closed.')).toBeTruthy();
    expect(box.value).toBe('late');
  });
  it('409 common.version_conflict on Send -> "This conversation changed. Reload to continue."', async () => {
    replyResult = () => problem(409, 'common.version_conflict', 'Version conflict');
    await openThread();
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This conversation changed. Reload to continue.')).toBeTruthy();
  });
  it('double click on Send posts once (the button is busy while the request runs)', async () => {
    await openThread();
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply' }), 'once');
    const send = screen.getByRole('button', { name: 'Send' });
    await userEvent.dblClick(send);
    await waitFor(() => expect(posts('/messages').length).toBeGreaterThan(0));
    expect(posts('/messages')).toHaveLength(1);
  });
  it('exactly one primary button (Send); no axe violations', async () => {
    const { container } = await openThread();
    expect(container.querySelectorAll('[data-variant="primary"], button[class*="primary"]').length).toBeLessThanOrEqual(1);
    await noAxeViolations();
  });
  it('message text is rendered as text, never as HTML', async () => {
    await openThread({ enquiry: thread({ extra: [{ author_kind: 'patient', body: '<img src=x onerror=alert(1)>', created_at: '2026-11-04T11:00:00.000Z' }] }) });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
});
