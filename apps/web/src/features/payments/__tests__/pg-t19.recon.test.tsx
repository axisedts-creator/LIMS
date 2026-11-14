// @vitest-environment jsdom
// PG-T19 — Gateway reconciliation, route /payments/reconciliation (04-UI-UX §2.4, §6, §7; 01-PRD US-PG-08 AC1–AC9, the UI-visible parts; 07-SECURITY). MSW plays the API.
// Backend-only ACs are NOT UI-testable here and are covered by PG-T15/T16 (cron 02:25 NPT = AC-PG-08.1/08.8 business date logic, settle/ledger repair logic = 08.2–08.5,
// alerts PaymentsReconciliationMissing/Stalled = 08.6, refund unconfirmed_run_count = 08.9). The UI side asserted here: what a finance user SEES for those outcomes.
// ASSUMED contract (dispute via writer if wrong):
//   * features/payments/components/ReconciliationView.tsx exports
//       `ReconciliationView({ runs, findings, stats, permissions, codes, filter?, nextCursor?, hasPrevious? })`
//       runs = ReconciliationRunDto[], findings = FindingDto[] (P15, status open), stats = { lastSuccessfulRunAt?: string, openCritical: number, underReview: number },
//       codes = { finding_kinds, finding_resolutions } each [{code,display,requires_text,is_active}]. PageHeader helpKey payments.reconciliation.
//   * "Run now" → POST /v1/payments/reconciliation-runs (P14, Idempotency-Key); "Resolve" → POST /reconciliation-findings/{id}/resolve (P16, If-Match = version + Idempotency-Key).
//   * app/(staff)/payments/reconciliation/page.tsx = async `Page({ searchParams })`: GET P12, P15 (status=open), P24 finding_kinds + finding_resolutions, P1 (held_for_review) for the tiles.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ORIGIN, U, axeClean, isEnabled, noRawCodes, npr, pick, problem, recorder, wrap, type Call } from './pg-t19.helpers';

const refresh = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ current: ['payments.reconciliation.read'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/payments/reconciliation',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/reconciliation',
}));

const READ = ['payments.reconciliation.read'];
const RESOLVE = [...READ, 'payments.intent.resolve'];
const codes = {
  finding_kinds: [
    ['missed_settlement', 'Missed settlement'], ['still_held', 'Still under review'], ['late_payment_found', 'Late payment found'], ['status_divergence', 'Status differs'],
    ['gateway_refund_unrecorded', 'Provider refund not recorded'], ['amount_mismatch', 'Amount mismatch'], ['ledger_entry_missing', 'Ledger entry missing'],
    ['refund_unconfirmed', 'Refund not confirmed'], ['gateway_unreachable', 'Provider unreachable'],
  ].map(([code, display]) => ({ code: code!, display: display!, requires_text: false, is_active: true })),
  finding_resolutions: [
    { code: 'confirmed_ok', display: 'Confirmed OK', requires_text: false, is_active: true },
    { code: 'false_positive', display: 'False positive', requires_text: false, is_active: true },
    { code: 'other', display: 'Other', requires_text: true, is_active: true },
  ],
};
const run = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(500 + n), business_date: '2026-11-10', trigger: 'cron', status: 'completed', started_at: '2026-11-10T20:40:00.000Z', finished_at: '2026-11-10T21:05:00.000Z',
  counts: { checked: 120, ok: 117, findings: 3, critical: 1 }, version: 1, ...o,
});
const runs = [
  run(1),
  run(2, { business_date: '2026-11-12', trigger: 'manual', status: 'running', finished_at: undefined, started_at: '2026-11-12T05:00:00.000Z', counts: { checked: 0, ok: 0, findings: 0, critical: 0 } }),
  run(3, { business_date: '2026-11-09', status: 'failed', finished_at: '2026-11-09T21:00:00.000Z', counts: { checked: 40, ok: 40, findings: 0, critical: 0 } }),
];
const finding = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(600 + n), run_id: U(501), kind: 'missed_settlement', severity: 'warning', intent_id: U(100 + n), our_status: 'initiated', gateway_status_raw: 'COMPLETE', our_amount: npr(50000),
  gateway_amount: npr(50000), auto_action: 'settled', status: 'open', created_at: '2026-11-10T21:00:00.000Z', version: 1, ...o,
});
const findings = [
  finding(1),
  finding(2, { kind: 'gateway_refund_unrecorded', severity: 'critical', our_status: 'settled', gateway_status_raw: 'FULL_REFUND', auto_action: 'none', our_amount: npr(225000), gateway_amount: npr(225000) }),
  finding(3, { kind: 'late_payment_found', severity: 'critical', our_status: 'expired', gateway_status_raw: 'COMPLETE', auto_action: 'held' }),
  finding(4, { kind: 'ledger_entry_missing', severity: 'critical', our_status: 'settled', gateway_status_raw: 'COMPLETE', auto_action: 'ledger_repaired' }),
  finding(5, { kind: 'refund_unconfirmed', severity: 'info', auto_action: 'none', our_status: 'settled', gateway_status_raw: undefined }),
  finding(6, { kind: 'gateway_unreachable', severity: 'info', intent_id: undefined, auto_action: 'none', our_status: undefined, gateway_status_raw: undefined, our_amount: undefined, gateway_amount: undefined }),
];
const stats = { lastSuccessfulRunAt: '2026-11-10T21:05:00.000Z', openCritical: 3, underReview: 2 };

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let start: R, resolveF: R, listRuns: R;
const filtered = (u: URL) => findings.filter((f) => (!u.searchParams.get('status') || f.status === u.searchParams.get('status')) && (!u.searchParams.get('severity') || f.severity === u.searchParams.get('severity')));
const reset = () => {
  start = () => HttpResponse.json(run(9, { status: 'running', trigger: 'manual', finished_at: undefined }), { status: 202 });
  resolveF = () => HttpResponse.json(finding(1, { status: 'resolved', resolution_code: 'confirmed_ok' }));
  listRuns = () => HttpResponse.json({ data: runs, page: { limit: 50 } });
};
reset();
const api = setupServer(
  http.get(`${ORIGIN}/v1/payments/reconciliation-runs`, async ({ request }) => { await rec(request); return listRuns(); }),
  http.post(`${ORIGIN}/v1/payments/reconciliation-runs`, async ({ request }) => { await rec(request); return start(); }),
  http.get(`${ORIGIN}/v1/payments/reconciliation-findings`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: filtered(new URL(request.url)), page: { limit: 50 } }); }),
  http.post(`${ORIGIN}/v1/payments/reconciliation-findings/:id/resolve`, async ({ request }) => { await rec(request); return resolveF(); }),
  http.get(`${ORIGIN}/v1/payments/intents`, async ({ request }) => {
    await rec(request);
    return HttpResponse.json({ data: [1, 2].map((n) => ({ id: U(100 + n), order_id: U(200 + n), centre_id: U(3), gateway: 'esewa', status: 'held_for_review', amount: npr(100), created_at: '2026-11-10T04:00:00.000Z', version: 1 })), page: { limit: 50 } });
  }),
  http.get(`${ORIGIN}/v1/payments/coded-sets/finding_kinds`, () => HttpResponse.json({ data: codes.finding_kinds })),
  http.get(`${ORIGIN}/v1/payments/coded-sets/finding_resolutions`, () => HttpResponse.json({ data: codes.finding_resolutions })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); perms.current = READ; reset(); });
afterAll(() => api.close());

const comp = async () => ((await import(/* @vite-ignore */ '../components/ReconciliationView')) as { ReconciliationView: (p: any) => any }).ReconciliationView;
const view = async (permissions: readonly string[] = RESOLVE, o: { runs?: unknown[]; findings?: unknown[]; stats?: unknown } = {}) => {
  const V = await comp();
  return wrap(<V runs={(o.runs ?? runs) as never} findings={(o.findings ?? findings) as never} stats={(o.stats ?? stats) as never} permissions={permissions} codes={codes} />);
};
const toFindings = () => userEvent.click(screen.getByRole('tab', { name: /open findings/i }));
const rowWith = (re: RegExp) => screen.getAllByRole('row').find((r) => re.test(r.textContent ?? '')) as HTMLElement;
const fRow = (n: number) => document.querySelector(`a[href="/payments/intents/${U(100 + n)}"]`)?.closest('tr') as HTMLElement;
const posts = (path: RegExp) => calls.filter((c) => c.method === 'POST' && path.test(c.url.pathname));

describe('§2.4 StatTile row (above the tabs)', () => {
  it('"Last successful run" (date/time), "Open critical findings", "Payments under review" with their values', async () => {
    await view();
    const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement;
    expect(tile('Last successful run').textContent).toMatch(/11\/11\/2026\s+02:50\s*AM/i); // 2026-11-10T21:05Z read in Asia/Kathmandu
    expect(tile('Open critical findings').textContent).toMatch(/\b3\b/);
    expect(tile('Payments under review').textContent).toMatch(/\b2\b/);
  });

  it('no successful run yet ⇒ the tile says so in text, not a blank or a raw ISO value (AC-PG-08.6 UI side)', async () => {
    await view(RESOLVE, { stats: { openCritical: 0, underReview: 0 } });
    const t = screen.getByText('Last successful run').parentElement!.textContent ?? '';
    expect(t).toMatch(/never|no .*run|—/i);
    expect(t).not.toMatch(/undefined|NaN|null/);
  });
});

describe('§2.4 Runs tab — AC-PG-08.1, 08.7, 08.8, 08.9 (display)', () => {
  it('title, tabs "Runs" and "Open findings"; Runs is the first / selected tab', async () => {
    await view();
    expect(screen.getByRole('heading', { level: 1, name: /reconciliation/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^runs$/i }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /open findings/i })).toBeTruthy();
  });

  it('columns Business date, Trigger, Status, Checked, OK, Findings, Critical, Finished in spec order', async () => {
    await view();
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim().toLowerCase());
    let at = -1;
    for (const w of ['business date', 'trigger', 'status', 'checked', 'ok', 'findings', 'critical', 'finished']) {
      const i = heads.findIndex((h, k) => k > at && h.startsWith(w));
      expect(i, `column ${w} in ${heads.join('|')}`).toBeGreaterThan(at);
      at = i;
    }
  });

  it('run row: trigger "Nightly"/"Manual", status text, counts, finished time; the BUSINESS date is shown (10/11/2026), not the cron start date (AC-PG-08.8)', async () => {
    await view();
    const r1 = rowWith(/Nightly/);
    expect(within(r1).getByText('10/11/2026')).toBeTruthy();
    expect(within(r1).getByText('Completed')).toBeTruthy();
    for (const n of ['120', '117']) expect(within(r1).getByText(n)).toBeTruthy();
    expect(r1.textContent).toMatch(/11\/11\/2026\s+02:50\s*AM/i);
    const r2 = rowWith(/Manual/);
    expect(within(r2).getByText('Running')).toBeTruthy();
    expect(within(rowWith(/Failed/)).getByText('Nightly')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/2026-11-10T|cron\b/);
  });

  it('"Run now" appears only with payments.intent.resolve', async () => {
    await view(READ);
    expect(isEnabled(screen.queryByRole('button', { name: /run now/i }))).toBe(false);
    cleanup();
    await view(RESOLVE);
    expect(isEnabled(screen.queryByRole('button', { name: /run now/i }))).toBe(true);
  });

  it('"Run now" POSTs /reconciliation-runs with an Idempotency-Key and an empty body, toasts "Reconciliation started.", refreshes', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() => expect(posts(/reconciliation-runs$/)).toHaveLength(1));
    const c = posts(/reconciliation-runs$/)[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(Object.keys(c.body ?? {})).toEqual([]);
    expect(await screen.findByText('Reconciliation started.')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('409 payments.reconciliation_in_progress ⇒ toast "A reconciliation is already running." (no raw code)', async () => {
    start = () => problem('payments.reconciliation_in_progress', 409);
    await view();
    await userEvent.click(screen.getByRole('button', { name: /run now/i }));
    expect(await screen.findByText('A reconciliation is already running.')).toBeTruthy();
    noRawCodes();
    expect(document.body.textContent).not.toMatch(/Reconciliation started/);
  });

  it('a double click on "Run now" starts one run only (race / double submit)', async () => {
    start = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(run(9, { status: 'running' }), { status: 202 }); };
    await view();
    await userEvent.dblClick(screen.getByRole('button', { name: /run now/i }));
    await new Promise((r) => setTimeout(r, 250));
    expect(posts(/reconciliation-runs$/)).toHaveLength(1);
  });

  it('403 auth.forbidden on "Run now" ⇒ plain permission text, no raw code', async () => {
    start = () => problem('auth.forbidden', 403);
    await view();
    await userEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() => expect(posts(/reconciliation-runs$/)).toHaveLength(1));
    expect(await screen.findByText(/permission/i)).toBeTruthy();
    noRawCodes();
  });

  it('empty runs list shows an empty state, not an empty grid', async () => {
    await view(RESOLVE, { runs: [] });
    expect(screen.getByText(/no .*(run|reconciliation)/i)).toBeTruthy();
  });
});

describe('§2.4 Open findings tab — AC-PG-08.2–08.5, 08.7, 08.9 (display)', () => {
  it('columns Found, Severity, Kind, Intent, Our status, Provider status, Our amount, Provider amount, Automatic action', async () => {
    await view();
    await toFindings();
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim().toLowerCase());
    let at = -1;
    for (const w of ['found', 'severity', 'kind', 'intent', 'our status', 'provider status', 'our amount', 'provider amount', 'automatic action']) {
      const i = heads.findIndex((h, k) => k > at && h.startsWith(w));
      expect(i, `column ${w} in ${heads.join('|')}`).toBeGreaterThan(at);
      at = i;
    }
  });

  it('severity is TEXT (Critical / Warning / Info) and the kind is the display name, never the raw code', async () => {
    await view();
    await toFindings();
    expect(within(fRow(2)).getByText('Critical')).toBeTruthy();
    expect(within(fRow(1)).getByText('Warning')).toBeTruthy();
    expect(within(fRow(5)).getByText('Info')).toBeTruthy();
    expect(within(fRow(2)).getByText('Provider refund not recorded')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/gateway_refund_unrecorded|late_payment_found|ledger_entry_missing|missed_settlement/);
  });

  it('AC-PG-08.2: missed settlement ⇒ automatic action "Marked paid", our status vs provider answer, both amounts lakh-grouped', async () => {
    await view();
    await toFindings();
    const r = fRow(1);
    expect(within(r).getByText('Marked paid')).toBeTruthy();
    expect(within(r).getByText('Started')).toBeTruthy();       // our status (C0 label of "initiated")
    expect(within(r).getByText('COMPLETE')).toBeTruthy();       // provider status as the provider said it
    expect(within(r).getAllByText(/500\.00/)).toHaveLength(2);
  });

  it('AC-PG-08.3: provider refund not recorded ⇒ critical, NO automatic action ("—"): reconciliation never claims it changed the ledger', async () => {
    await view();
    await toFindings();
    const r = fRow(2);
    expect(within(r).getByText('Critical')).toBeTruthy();
    expect(within(r).queryByText(/Marked paid|Ledger repaired|Put under review/)).toBeNull();
    expect(within(r).getByText('Paid')).toBeTruthy();           // our status "settled"
    expect(within(r).getByText('FULL_REFUND')).toBeTruthy();
    expect(within(r).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('AC-PG-08.4: late payment on an expired intent ⇒ critical + "Put under review"', async () => {
    await view();
    await toFindings();
    const r = fRow(3);
    expect(within(r).getByText('Critical')).toBeTruthy();
    expect(within(r).getByText('Put under review')).toBeTruthy();
    expect(within(r).getByText('Expired')).toBeTruthy();
  });

  it('AC-PG-08.5: ledger entry missing ⇒ critical + "Ledger repaired"', async () => {
    await view();
    await toFindings();
    expect(within(fRow(4)).getByText('Ledger repaired')).toBeTruthy();
    expect(within(fRow(4)).getByText('Critical')).toBeTruthy();
  });

  it('AC-PG-08.9: refund not confirmed is listed with its display name; a finding without an intent shows "—" instead of a link', async () => {
    await view();
    await toFindings();
    expect(within(fRow(5)).getByText('Refund not confirmed')).toBeTruthy();
    const unreachable = rowWith(/Provider unreachable/);
    expect(unreachable.querySelector('a[href^="/payments/intents/"]')).toBeNull();
    expect(unreachable.textContent).toMatch(/—/);
  });

  it('AC-PG-08.7: each finding links to its intent (keyboard-focusable link)', async () => {
    await view();
    await toFindings();
    const a = fRow(1).querySelector(`a[href="/payments/intents/${U(101)}"]`) as HTMLAnchorElement;
    a.focus();
    expect(document.activeElement).toBe(a);
  });

  it('FilterBar offers a kind filter (finding_kinds display names) and a severity filter', async () => {
    await view();
    await toFindings();
    expect(screen.getAllByText(/^kind$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^severity$/i).length).toBeGreaterThan(0);
  });
});

describe('§2.4 Resolve finding (P16) — AC-PG-08.7: needs payments.intent.resolve + a reason', () => {
  const resolveBtn = (n: number) => within(fRow(n)).queryByRole('button', { name: /^resolve/i });
  const open = async (n = 1) => {
    await view(RESOLVE);
    await toFindings();
    await userEvent.click(resolveBtn(n)!);
    return screen.findByRole('dialog');
  };

  it('"Resolve" is offered only with payments.intent.resolve', async () => {
    await view(READ);
    await toFindings();
    expect(isEnabled(resolveBtn(1))).toBe(false);
    cleanup();
    await view(RESOLVE);
    await toFindings();
    expect(isEnabled(resolveBtn(1))).toBe(true);
  });

  it('ConfirmDialog with coded reasons (finding_resolutions); nothing is sent without a reason', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /^resolve/i }));
    expect(posts(/resolve$/)).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    for (const d of ['Confirmed OK', 'False positive', 'Other']) expect(await screen.findByRole('option', { name: d })).toBeTruthy();
  });

  it('sends {resolution_code} with If-Match = version, an Idempotency-Key and the Bearer token; then refreshes', async () => {
    const dlg = await open();
    await pick(dlg, /Confirmed OK/);
    await userEvent.click(within(dlg).getByRole('button', { name: /^resolve/i }));
    await waitFor(() => expect(posts(/resolve$/)).toHaveLength(1));
    const c = posts(/resolve$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/payments/reconciliation-findings/${U(601)}/resolve`);
    expect(c.body.resolution_code).toBe('confirmed_ok');
    expect(c.headers.get('if-match')).toMatch(/1/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('code "other" needs a note (≤ 1000) before anything is sent; the note is sent as `note`', async () => {
    const dlg = await open();
    await pick(dlg, /^Other$/);
    await userEvent.click(within(dlg).getByRole('button', { name: /^resolve/i }));
    expect(posts(/resolve$/)).toHaveLength(0);
    const t = within(dlg).getByRole('textbox') as HTMLInputElement;
    expect(t.maxLength).toBe(1000);
    await userEvent.type(t, 'Escalated to eSewa support, ticket 4411');
    await userEvent.click(within(dlg).getByRole('button', { name: /^resolve/i }));
    await waitFor(() => expect(posts(/resolve$/)).toHaveLength(1));
    expect(posts(/resolve$/)[0]!.body).toMatchObject({ resolution_code: 'other' });
    expect(String(posts(/resolve$/)[0]!.body.note)).toMatch(/ticket 4411/);
  });

  it('409 common.immutable_record (already resolved) ⇒ plain "already resolved" text, no raw code', async () => {
    resolveF = () => problem('common.immutable_record', 409);
    const dlg = await open();
    await pick(dlg, /Confirmed OK/);
    await userEvent.click(within(dlg).getByRole('button', { name: /^resolve/i }));
    expect(await screen.findByText(/already resolved|already been resolved/i)).toBeTruthy();
    noRawCodes();
  });

  it('a double click on confirm sends one request only (race / double submit)', async () => {
    resolveF = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(finding(1, { status: 'resolved' })); };
    const dlg = await open();
    await pick(dlg, /Confirmed OK/);
    await userEvent.dblClick(within(dlg).getByRole('button', { name: /^resolve/i }));
    await new Promise((r) => setTimeout(r, 250));
    expect(posts(/resolve$/)).toHaveLength(1);
  });

  it('Cancel sends nothing and returns focus to the trigger (focus trap + return, §6)', async () => {
    await view(RESOLVE);
    await toFindings();
    const trigger = resolveBtn(1)!;
    await userEvent.click(trigger);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(/resolve$/)).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('§6 / §7 — a11y and copy', () => {
  it('never renders tokens, raw payloads, secrets or the bearer token even if the API leaks them (07-SECURITY)', async () => {
    const { container } = await view(RESOLVE, { findings: [finding(7, { callback_token: 'tok_SECRETSECRETSECRET1', raw_payload: '{"secret":"x"}', return_url: 'https://portal.test/x' })] });
    await toFindings();
    expect(container.innerHTML).not.toMatch(/tok_SECRET|portal\.test|"secret"|jwt-synthetic/);
  });
  it('never claims "Payment successful" / "Fonepay verified"', async () => {
    await view();
    await toFindings();
    expect(document.body.textContent).not.toMatch(/Payment successful|Fonepay verified/);
  });
  it('axe: runs tab, findings tab, empty and resolve dialog have no violations', async () => {
    await view();
    await axeClean();
    await toFindings();
    await axeClean();
    await userEvent.click(within(fRow(1)).getByRole('button', { name: /^resolve/i }));
    await screen.findByRole('dialog');
    await axeClean();
    cleanup();
    await view(RESOLVE, { runs: [], findings: [] });
    await axeClean();
  });
});

type SP = Record<string, string | string[] | undefined>;
const loadPage = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/payments/reconciliation/page')) as { default: (p: { searchParams: Promise<SP> }) => Promise<any> }).default;
const show = async (sp: SP = {}) => { const Page = await loadPage(); return wrap(await Page({ searchParams: Promise.resolve(sp) })); };

describe('reconciliation page.tsx — requests (P12 / P15 / P24 / P1)', () => {
  it('no payments.reconciliation.read ⇒ not found and no API call at all', async () => {
    perms.current = [];
    await expect(show()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('fetches runs (business-date descending), open findings, both code sets and the held-for-review list; Bearer from the session, never in the DOM', async () => {
    perms.current = RESOLVE;
    const { container } = await show();
    const r = calls.find((c) => c.url.pathname === '/v1/payments/reconciliation-runs')!;
    expect(r.url.searchParams.get('sort') ?? '-business_date').toBe('-business_date');
    expect(r.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(calls.some((c) => c.url.pathname === '/v1/payments/reconciliation-findings' && c.url.searchParams.get('status') === 'open')).toBe(true);
    expect(calls.some((c) => c.url.pathname === '/v1/payments/intents' && c.url.searchParams.get('status') === 'held_for_review')).toBe(true);
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    expect((await screen.findAllByText('Nightly')).length).toBeGreaterThan(0);
  });

  it('tiles come from the data: last successful run = newest COMPLETED run (not the running/failed ones), 3 open critical findings, 2 payments under review', async () => {
    perms.current = RESOLVE;
    await show();
    const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement;
    await waitFor(() => expect(tile('Open critical findings').textContent).toMatch(/\b3\b/));
    expect(tile('Payments under review').textContent).toMatch(/\b2\b/);
    expect(tile('Last successful run').textContent).toMatch(/11\/11\/2026/);
  });

  it('forwards only whitelisted, well-formed finding filters (kind csv, severity); drops tenant_id / evil / malformed', async () => {
    perms.current = RESOLVE;
    await show({ kind: 'missed_settlement,late_payment_found', severity: 'critical', evil: '1', tenant_id: 'other-tenant' });
    const q = calls.find((c) => c.url.pathname === '/v1/payments/reconciliation-findings')!.url.searchParams;
    expect(q.get('kind')).toBe('missed_settlement,late_payment_found');
    expect(q.get('severity')).toBe('critical');
    expect(q.has('evil')).toBe(false);
    expect(q.has('tenant_id')).toBe(false);
  });

  it.each([['kind', 'missed_settlement;drop'], ['kind', 'not_a_kind'], ['severity', 'critical&x=1'], ['severity', 'fatal']])('does not forward a malformed %s (%s)', async (key, bad) => {
    perms.current = RESOLVE;
    await show({ [key]: bad });
    for (const c of calls) { expect(c.url.searchParams.get(key)).not.toBe(bad); expect(c.url.search).not.toMatch(/drop|x=1/); }
  });

  it('API 403 shows no run / finding data; API 5xx rejects so error.tsx renders', async () => {
    perms.current = RESOLVE;
    listRuns = () => problem('auth.forbidden', 403);
    try { await show(); } catch { /* may reject or render a denied state */ }
    expect(document.body.textContent).not.toMatch(/Nightly|Provider refund not recorded/);
    cleanup();
    listRuns = () => problem('common.dependency_unavailable', 503);
    await expect(show()).rejects.toBeTruthy();
  });

  it('axe: page output has no violations', async () => { perms.current = RESOLVE; await show(); await axeClean(); });
});
