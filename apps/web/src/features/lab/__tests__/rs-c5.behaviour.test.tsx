// @vitest-environment jsdom
// RS-C5 — restyle of the C5 lab screens to Metro Green (appearance and arrangement ONLY; LD-140). 10-DESIGN-SYSTEM s4 (screens), s6 (not-to-do), s8 (acceptance: axe zero serious/critical, keyboard-only).
// done_when under test: (1) receive / collect: scan-first, status TABS WITH COUNTS (kit Tabs `count`), no status dropdown; (2) worklist = table + RIGHT PANEL for result entry;
// (3) three-step track Entered / Senior technician / Pathologist, current step highlighted, next actor named; (4) source chip + delta only from fields the API already returns;
// (5) critical-value prompt behaviour unchanged; (6) no API call changes (MSW records exactly the calls the pre-restyle screens made).
//
// ASSUMED DOM contract (the spec fixes layout intent only; dispute a name through the ruling flow, never by editing this file). Every name below is built from kit parts (Tabs, StatusStepper, StatusChip, Drawer-like aside):
//   ReceiveScreen: a tablist named "Session log" ALWAYS rendered (also before the first scan) with tabs "All", "Received", "Rejected", "Errors", each tab's accessible name = "<label> <count>" (kit Tabs `count`, 0 shown);
//     counts are derived from the in-memory session log only (outcome "Received" / "Rejected" / "Error: ..."); the selected tab filters the session-log table; default tab "All". The scan box keeps focus (scan-first).
//   CollectDispatch: kit Tabs "Collect" and "Dispatch" carry a count = number of rows in that tab's list (0 shown); counts update as rows are added.
//   WorklistPage: the table keeps aria-label "Worklist"; each row has a button named "Enter results <barcode|reg no> <test code>"; pressing it opens a right-hand panel = <aside aria-label="Result entry"> (role complementary)
//     showing registration no, patient name, test code, "<resulted> of <total> resulted" (from result_counts) and a link "Open result entry" -> /lab/orders/<order_id>/results; focus moves into the panel;
//     the panel has a button "Close panel"; Escape closes it and returns focus to the row button. Before a row is chosen the aside is present and says "Select a sample to enter results". NO new API call.
//   ResultGrid: one <section aria-label="Progress of <TEST CODE>"> per test item holding the kit StatusStepper (3 listitems Entered / Senior technician / Pathologist, current = aria-current="step") and, while a next actor exists,
//     the text "Next: <actor>". Current step = the LEAST advanced result of the item: resulted -> Entered (next Senior technician), verified -> Senior technician (next Pathologist), approved -> Pathologist (no next).
//     Source chip: in each row's Origin cell an element with data-tone="info" for origin 'instrument' whose text is exactly "Instrument" (only what the API returns: no instrument name, no time).
//     Delta: the Δ cell keeps deltaText() output ("Δ +2.4 vs 10.0 (...)" / "No previous"); nothing else is derived.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { BC, CENTRES, CENTRE_A, DEPT, ORIGIN, REASONS, analytes, calls, gridOf, id, problem, rec, res, sent, specimen, threeStateGrid, worklistItem } from './rs-c5.fixtures';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/x',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/x',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const LAB = `${ORIGIN}/v1/lab`;
const db = new Map<string, Record<string, unknown>>();
const ORDERED = [specimen(1, { status: 'collected' }), specimen(2, { status: 'discarded' })];
const api = setupServer(
  http.post(`${LAB}/specimens/lookup`, async ({ request }) => {
    await rec(request);
    const b = (await request.clone().json()) as { barcode?: string; registration_no?: string };
    if (b.registration_no) return HttpResponse.json({ data: [specimen(1, { status: 'ordered' }), specimen(2, { status: 'ordered' }), specimen(3, { status: 'received' })] });
    const s = b.barcode ? db.get(b.barcode) : undefined;
    return s ? HttpResponse.json(s) : problem(404, 'common.not_found', 'Not found');
  }),
  http.post(`${LAB}/specimens/:sid/receive`, async ({ request, params }) => {
    await rec(request);
    const s = [...db.values()].find((x) => x.id === params['sid'])!;
    if (s.status === 'discarded') return problem(409, 'lab.specimen_not_receivable', 'Specimen not receivable');
    return HttpResponse.json({ ...s, version: 2, status: 'received' });
  }),
  http.get(`${LAB}/worklist-items`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [worklistItem(1, { priority: 'urgent' }), worklistItem(2)], page: { limit: 50 } }); }),
  http.get(`${ORIGIN}/v1/instruments/instruments`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ id: id(0x1a), display_name: 'Synthetic Analyser A' }], page: { limit: 50 } }); }),
  http.post(`${LAB}/results/bulk-verify`, async ({ request }) => { await rec(request); const b = (await request.clone().json()) as { items: { id: string }[] }; return HttpResponse.json({ results: b.items.map((i) => ({ id: i.id, outcome: 'ok' })) }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; db.clear(); push.mockReset(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const serious = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout: contrast is covered by the token contrast gate (10-DESIGN-SYSTEM s2.6)
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html}`);
};
const live = (el: Element) => !el.closest('[hidden],[aria-hidden="true"],[inert]');
const box = () => screen.getAllByLabelText(/barcode/i).filter(live)[0] as HTMLInputElement;
const tabNamed = (re: RegExp) => screen.getByRole('tab', { name: re });

// ───────────────────────── receive ─────────────────────────
const PERMS = ['lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.read'];
const showReceive = async () => {
  localStorage.setItem('lims.lab.receive.location', CENTRE_A);
  const { ReceiveScreen } = await import('../components/ReceiveScreen');
  return wrap(<ReceiveScreen centres={CENTRES} rejectionReasons={REASONS} recollectionDefault={false} permissions={PERMS} />);
};

describe('10-DESIGN-SYSTEM s4 — accession / receive: scan-first, status tabs with counts, no status dropdown', () => {
  it('the session log is a tablist "Session log" with All / Received / Rejected / Errors, every count 0 before the first scan; the scan box holds focus', async () => {
    await showReceive();
    const list = screen.getByRole('tablist', { name: /session log/i });
    expect(within(list).getAllByRole('tab').map((t) => t.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['All 0', 'Received 0', 'Rejected 0', 'Errors 0']);
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('no status dropdown on the screen: the only list control is the receiving location', async () => {
    await showReceive();
    expect(screen.queryByRole('combobox', { name: /status/i })).toBeNull();
    expect(document.querySelector('select:not([aria-hidden="true"]):not([tabindex="-1"])')).toBeNull();
  });

  it('keyboard only: scan, Enter accepts, a refused specimen is its own outcome; counts All 2 / Received 1 / Errors 1; each tab filters the log; focus returns to the scan box', async () => {
    for (const s of ORDERED) db.set(s.barcode, s);
    await showReceive();
    const user = userEvent.setup({ delay: null });
    await waitFor(() => expect(document.activeElement).toBe(box()));
    await user.keyboard(`${BC(1)}{Enter}`);
    await screen.findByRole('region', { name: /current specimen/i });
    await user.keyboard('{Enter}'); // accept (Enter on the empty scan box)
    await waitFor(() => expect(tabNamed(/^Received\s*1$/)).toBeTruthy());
    await user.keyboard(`${BC(2)}{Enter}`);
    await waitFor(() => expect(screen.getByText(BC(2), { selector: 'strong' })).toBeTruthy());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(tabNamed(/^Errors\s*1$/)).toBeTruthy());
    expect(tabNamed(/^All\s*2$/)).toBeTruthy();
    expect(tabNamed(/^Rejected\s*0$/)).toBeTruthy();
    await user.click(tabNamed(/^Errors/));
    expect(screen.getByRole('row', { name: new RegExp(BC(2)) }).textContent).toContain('Error: Specimen not receivable');
    expect(screen.queryByRole('row', { name: new RegExp(BC(1)) })).toBeNull();
    await user.click(tabNamed(/^Received/));
    expect(screen.getByRole('row', { name: new RegExp(BC(1)) }).textContent).toContain('Received');
    expect(screen.queryByRole('row', { name: new RegExp(BC(2)) })).toBeNull();
    expect(sent('POST', /\/specimens\/lookup$/).map((c) => c.body)).toEqual([{ barcode: BC(1) }, { barcode: BC(2) }]); // same calls as before the restyle
    expect(sent('POST', /\/specimens\/[^/]+\/receive$/)).toHaveLength(2);
  });

  it('axe: zero serious / critical violations', async () => {
    await showReceive();
    expect(await serious()).toEqual([]);
  });
});

describe('10-DESIGN-SYSTEM s4 — collect / dispatch tabs carry counts', () => {
  it('Collect and Dispatch tabs show 0; a registration lookup with two ordered specimens (and one already received) makes Collect 2', async () => {
    const { CollectDispatch } = await import('../components/CollectDispatch');
    wrap(<CollectDispatch permissions={['lab.specimen.collect', 'lab.specimen.read']} />);
    expect(tabNamed(/^Collect\s*0$/)).toBeTruthy();
    expect(tabNamed(/^Dispatch\s*0$/)).toBeTruthy();
    await userEvent.setup({ delay: null }).type(box(), 'REGISTRATIONNO2611050001{Enter}');
    await waitFor(() => expect(tabNamed(/^Collect\s*2$/)).toBeTruthy());
    expect(tabNamed(/^Dispatch\s*0$/)).toBeTruthy();
    expect(await serious()).toEqual([]);
  });
});

// ───────────────────────── worklist ─────────────────────────
describe('10-DESIGN-SYSTEM s4 — worklist: table with a right panel for result entry', () => {
  const showWorklist = async () => {
    const { WorklistPage } = await import('../components/worklists/WorklistPage');
    return wrap(<WorklistPage departmentId={DEPT} permissions={['lab.worklist.read', 'lab.worksheet.manage']} />);
  };
  const rowButton = () => screen.findByRole('button', { name: /^Enter results E2600000101 CBC$/ });

  it('the table stays; the right panel (complementary "Result entry") is present and empty until a row is chosen', async () => {
    await showWorklist();
    await screen.findByRole('table', { name: /worklist/i });
    expect(screen.getAllByRole('row').length).toBe(3); // header + 2 samples
    const panel = screen.getByRole('complementary', { name: /result entry/i });
    expect(panel.textContent).toContain('Select a sample to enter results');
  });

  it('choosing a row shows its facts from the worklist DTO only, a link to the existing result-entry route, and NO extra API call', async () => {
    await showWorklist();
    const user = userEvent.setup({ delay: null });
    await user.click(await rowButton());
    const panel = screen.getByRole('complementary', { name: /result entry/i });
    expect(panel.textContent).toContain('R2611050001');
    expect(panel.textContent).toContain('Synthetic Patient 1');
    expect(panel.textContent).toContain('CBC');
    expect(panel.textContent).toContain('1 of 3 resulted');
    expect(within(panel).getByRole('link', { name: /open result entry/i }).getAttribute('href')).toBe(`/lab/orders/${id(0x201)}/results`);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`).sort()).toEqual(['GET /v1/instruments/instruments', 'GET /v1/lab/worklist-items']); // exactly the pre-restyle calls
  });

  it('keyboard only: Tab to the row button, Enter opens the panel with focus inside it, Escape closes it and focus returns to the row button', async () => {
    await showWorklist();
    const user = userEvent.setup({ delay: null });
    const btn = await rowButton();
    for (let i = 0; i < 40 && document.activeElement !== btn; i++) await user.tab();
    expect(document.activeElement).toBe(btn);
    await user.keyboard('{Enter}');
    const panel = screen.getByRole('complementary', { name: /result entry/i });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(panel.textContent).toContain('Select a sample to enter results'));
    expect(document.activeElement).toBe(btn);
  });

  it('axe: zero serious / critical violations, panel closed and open', async () => {
    await showWorklist();
    await rowButton();
    expect(await serious()).toEqual([]);
    await userEvent.setup({ delay: null }).click(await rowButton());
    expect(await serious()).toEqual([]);
  });
});

// ───────────────────────── result entry ─────────────────────────
describe('10-DESIGN-SYSTEM s4 — result entry: three-step track, source chip, delta', () => {
  const ALL = ['lab.result.read', 'lab.result.enter', 'lab.result.verify', 'lab.result.approve', 'lab.result.amend'];
  const showGrid = async (data: ReturnType<typeof gridOf>, permissions: readonly string[] = ALL) => {
    const { ResultGrid } = await import('../components/grid/ResultGrid');
    return wrap(<ResultGrid data={data as never} analytes={analytes} permissions={permissions} patientId={id(7777)} returnReasons={[]} amendmentReasons={[]} />);
  };
  const track = (code: string) => screen.getByRole('region', { name: new RegExp(`progress.*${code}`, 'i') });
  const steps = (code: string) => within(track(code)).getAllByRole('listitem');
  const current = (code: string) => steps(code).filter((s) => s.getAttribute('aria-current') === 'step').map((s) => s.textContent);

  it('each test item has a track with exactly the steps Entered, Senior technician, Pathologist', async () => {
    await showGrid(threeStateGrid());
    for (const code of ['CBC', 'LIPID', 'GLU']) {
      expect(steps(code).map((s) => /Entered|Senior technician|Pathologist/.exec(s.textContent!)?.[0])).toEqual(['Entered', 'Senior technician', 'Pathologist']);
      expect(current(code)).toHaveLength(1);
    }
  });

  it('the current step follows the least advanced result of the item and the next actor is named (approved: none)', async () => {
    await showGrid(threeStateGrid());
    expect(current('LIPID')[0]).toMatch(/Entered/); // resulted
    expect(track('LIPID').textContent).toContain('Next: Senior technician');
    expect(current('CBC')[0]).toMatch(/Senior technician/); // verified
    expect(track('CBC').textContent).toContain('Next: Pathologist');
    expect(current('GLU')[0]).toMatch(/Pathologist/); // approved
    expect(track('GLU').textContent).not.toMatch(/Next:/);
  });

  it('a mixed item (one resulted, one verified) is at Entered: the track never runs ahead of its slowest result', async () => {
    await showGrid(gridOf([{ code: 'CBC', results: [res(1, { status: 'verified', value_numeric: '13.5' }), res(2, { status: 'resulted', value_numeric: '6.0' })] }]));
    expect(current('CBC')[0]).toMatch(/Entered/);
  });

  it('source chip only from origin: an instrument result carries an info-tone chip reading exactly "Instrument" (no instrument name, no time); the manual row has no info chip', async () => {
    await showGrid(threeStateGrid());
    const rows = screen.getAllByRole('row');
    const wbc = rows.find((r) => /WBC/.test(r.textContent ?? ''))!;
    const hb = rows.find((r) => /Hemoglobin/.test(r.textContent ?? ''))!;
    const chips = Array.from(wbc.querySelectorAll('[data-tone="info"]')).map((c) => c.textContent!.trim());
    expect(chips).toEqual(['Instrument']);
    expect(hb.querySelector('[data-tone="info"]')).toBeNull();
  });

  it('delta only from the API fields: failed delta reads "Δ +2.4 vs 10.0 (… d ago)" (abs, prev_value, prev_at); no delta -> "No previous"; no percentage or invented value', async () => {
    await showGrid(threeStateGrid());
    const rows = screen.getAllByRole('row');
    const wbc = rows.find((r) => /WBC/.test(r.textContent ?? ''))!.textContent!;
    expect(wbc).toMatch(/Δ \+2\.4 vs 10\.0 \(\d+ d ago\)/);
    expect(wbc).not.toMatch(/24\s*%/);
    expect(rows.find((r) => /Hemoglobin/.test(r.textContent ?? ''))!.textContent).toContain('No previous');
  });

  it('critical-value prompt unchanged: Save & verify on a critical result opens "Review flagged results", Verify stays disabled until "I have reviewed the critical value" is ticked, then bulk-verify carries acknowledged_flags ["critical"] with an Idempotency-Key', async () => {
    const crit = res(1, { status: 'resulted', value_numeric: '0.40', critical: { is_critical: true, critical_event_id: id(55) } });
    await showGrid(gridOf([{ code: 'CBC', results: [crit] }]));
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: /save & verify/i }));
    const dlg = await screen.findByRole('dialog', { name: /review flagged results/i });
    const verify = within(dlg).getByRole('button', { name: /^verify$/i }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    expect(sent('POST', /results\/bulk-verify$/)).toHaveLength(0);
    await user.click(within(dlg).getByLabelText('I have reviewed the critical value'));
    await waitFor(() => expect(verify.disabled).toBe(false));
    await user.click(verify);
    await waitFor(() => expect(sent('POST', /results\/bulk-verify$/)).toHaveLength(1));
    const call = sent('POST', /results\/bulk-verify$/)[0]!;
    expect(call.body).toEqual({ items: [{ id: crit.id, version: 1, acknowledged_flags: ['critical'] }] });
    expect(call.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('keyboard only: the value cell of the first editable row is reachable and typing + Ctrl+S sends ONE bulk-enter-shaped save (unchanged shortcut table); no mouse', async () => {
    api.use(http.post(`${LAB}/results/bulk-enter`, async ({ request }) => { await rec(request); const b = (await request.clone().json()) as { entries: { result_id: string; version: number }[] }; return HttpResponse.json({ results: b.entries.map((e) => ({ result_id: e.result_id, outcome: 'ok', result: { ...res(1), id: e.result_id, version: e.version + 1, status: 'resulted', value_numeric: '4.10', flag: 'N' } })), recomputed: [] }); }));
    await showGrid(gridOf([{ code: 'CBC', results: [res(1, { status: 'pending' })] }]));
    const user = userEvent.setup();
    const cell = (await screen.findAllByRole('gridcell')).find((c) => c.getAttribute('aria-colindex') === '2')!;
    cell.focus();
    await user.keyboard('4.1{Enter}');
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(sent('POST', /results\/bulk-enter$/)).toHaveLength(1));
    expect((sent('POST', /results\/bulk-enter$/)[0]!.body as { entries: unknown[] }).entries).toEqual([{ result_id: id(1), version: 1, value_numeric: '4.1' }]);
  });

  it('axe: zero serious / critical violations on the result entry screen', async () => {
    await showGrid(threeStateGrid());
    expect(await serious()).toEqual([]);
  });
});
