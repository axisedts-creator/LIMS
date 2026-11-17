// @vitest-environment jsdom
// C5.T-21 — Verification queue `/lab/verification` and approval queue `/lab/approval` (04-UI-UX §3.8, §3.6 "Approve"; 03-APP-FLOW §3.x queue row).
// ACs: AC-15.2 (bulk verify → per-id outcomes; foreign ids come back `common.not_found` per id and are shown per id), AC-16.3 (aal1 → 403 auth.mfa_required → step-up, then retry).
// Also AC-12.3 as seen from the UI (flag acknowledgement), AC-16.2 / AC-13.5 copy, 07-SECURITY S-01/S-02/P-02.
// Synthetic data only.
//
// ASSUMED module/prop contract (dispute through the writer/ruling flow if wrong). Under apps/web/src/features/lab/components/ (named exports, 'use client'):
//   VerificationQueue({ items, permissions })   items = VerificationQueueItem[] (the `data` of GET /v1/lab/verification-queue?stage=verify)
//   ApprovalQueue({ items, permissions, onStepUp? })  items = same shape (stage=approve)
//        onStepUp?(): Promise<void> | void — the C2 step-up hook. On 403 auth.mfa_required the screen shows a warning banner with a "Verify now" button;
//        pressing it awaits onStepUp() and then RE-SENDS the same request with the SAME Idempotency-Key and body (02-CONVENTIONS §4.5; 04-UI-UX §3.6 "Approve").
//   Rows: one <tr role=row> per result. Row checkbox accessible name matches /select/i (and not /acknowledge/i). A result that needs acknowledgement gets one extra
//   checkbox per needed flag, named /acknowledge <flag>/i  with <flag> = delta | critical | unit mismatch | instrument flag. A flag is needed when (mirrors result.service `needed()`):
//   delta.status === 'fail' → delta; critical.is_critical → critical; unit_mismatch → unit mismatch; instrument_flags non-empty → instrument flag.
//   Bulk button "Verify {n}" / "Approve {n}" (disabled at n = 0). A selected row with an un-acknowledged needed flag blocks the bulk call (button disabled OR click is a no-op) — nothing is sent.
//   The bulk call is POST /v1/lab/results/bulk-verify | bulk-approve with `Idempotency-Key` and body { items: [{ id, version, acknowledged_flags? }] } (≤ 200 per request;
//   acknowledged_flags only on verify, only for the needed flags of that row, sorted). Outcome dialog (role=dialog) "{ok} done, {failed} not done" with a reason line per failed id.
//   Without `lab.result.verify` / `lab.result.approve` the screen is read-only: no selection boxes, no bulk button.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { VerificationQueue } from '../components/VerificationQueue';
import { ApprovalQueue } from '../components/ApprovalQueue';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/lab/verification',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/verification',
}));
const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CRIT_EVENT = id(9001);
const VERIFY = ['lab.result.read', 'lab.result.verify'];
const APPROVE = ['lab.result.read', 'lab.result.approve'];

type Over = Record<string, unknown>;
const item = (n: number, o: { result?: Over; reg?: string; name?: string } = {}) => ({
  result: {
    id: id(n), version: 1, order_id: id(1000 + n), order_item_id: id(2000 + n), specimen_id: id(3000 + n), test_id: id(4000 + n), analyte_id: id(5000 + n),
    analyte_code: `AN${n}`, status: 'resulted', origin: 'manual', value_numeric: '5.4', unit_code: 'mmol_l', flag: 'N',
    range_unavailable_age_unknown: false, critical: { is_critical: false }, on_hold: false, qc_review_required: false, unit_mismatch: false,
    current_version_no: 1, delta: { status: 'pass' }, instrument_flags: [], ...o.result,
  },
  registration_no: o.reg ?? `REG${String(n).padStart(4, '0')}`,
  barcode: `SYN${String(n).padStart(6, '0')}`,
  patient_display: { full_name: o.name ?? `Synthetic Patient ${n}`, age_sex: '40Y M', patient_code: `P${n}` },
  priority: 'routine',
});
const DELTA = { delta: { status: 'fail', prev_value: '3.0', abs: '2.4', pct: '80' } };
const CRIT = { critical: { is_critical: true, critical_event_id: CRIT_EVENT }, flag: 'HH' };

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
type Outcome = { id: string; outcome: 'ok' | 'error'; code?: string };
/** default reply: every id ok */
const okAll = (body: any) => HttpResponse.json({ results: body.items.map((i: any) => ({ id: i.id, outcome: 'ok' })) });
let verifyReply: (b: any, n: number) => Response | Promise<Response> = okAll;
let approveReply: (b: any, n: number) => Response | Promise<Response> = okAll;
let nVerify = 0;
let nApprove = 0;
const api = setupServer(
  http.post(`${ORIGIN}/v1/lab/results/bulk-verify`, async ({ request }) => { await rec(request); return verifyReply(await request.clone().json(), nVerify++); }),
  http.post(`${ORIGIN}/v1/lab/results/bulk-approve`, async ({ request }) => { await rec(request); return approveReply(await request.clone().json(), nApprove++); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); refresh.mockReset(); verifyReply = okAll; approveReply = okAll; nVerify = 0; nApprove = 0; });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const rowOf = (reg: string) => {
  const r = screen.getAllByRole('row').find((x) => x.textContent?.includes(reg));
  if (!r) throw new Error(`no row for ${reg}`);
  return r;
};
const selectBox = (reg: string) => within(rowOf(reg)).getAllByRole('checkbox').find((c) => /select/i.test(c.getAttribute('aria-label') ?? c.closest('label')?.textContent ?? '') || /select/i.test((c as HTMLInputElement).labels?.[0]?.textContent ?? ''))!;
const ackBox = (reg: string, flag: RegExp) => within(rowOf(reg)).getByRole('checkbox', { name: new RegExp(`acknowledge.*${flag.source}`, 'i') });
const bulkBtn = (verb: 'Verify' | 'Approve', n?: number) => screen.getByRole('button', { name: new RegExp(`^${verb}\\s*${n ?? '\\d+'}$`, 'i') });
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const verifyCalls = () => calls.filter((c) => c.url.pathname.endsWith('/bulk-verify'));
const approveCalls = () => calls.filter((c) => c.url.pathname.endsWith('/bulk-approve'));

// ───────────────────────────────────────── Verification queue
describe('C5.T-21 verification queue — list, states, permissions', () => {
  it('renders one row per result with reg no, patient, analyte, priority; empty list → "Nothing waiting for verification."', async () => {
    const { unmount } = wrap(<VerificationQueue items={[item(1), item(2)]} permissions={VERIFY} />);
    const r1 = rowOf('REG0001');
    expect(within(r1).getByText(/Synthetic Patient 1/)).toBeTruthy();
    expect(within(r1).getByText(/AN1/)).toBeTruthy();
    expect(within(rowOf('REG0002')).getByText(/Synthetic Patient 2/)).toBeTruthy();
    unmount();
    wrap(<VerificationQueue items={[]} permissions={VERIFY} />);
    expect(screen.getByText('Nothing waiting for verification.')).toBeTruthy();
  });

  it('range_unavailable_age_unknown → the exact flag text (08 A17.1); a normal row does not show it', () => {
    wrap(<VerificationQueue items={[item(1, { result: { range_unavailable_age_unknown: true } }), item(2)]} permissions={VERIFY} />);
    expect(within(rowOf('REG0001')).getByText('Age unknown — reference range and critical check not applied')).toBeTruthy();
    expect(within(rowOf('REG0002')).queryByText(/Age unknown/)).toBeNull();
  });

  it('without lab.result.verify the screen is read-only: no selection boxes, no Verify button, no request', async () => {
    wrap(<VerificationQueue items={[item(1)]} permissions={['lab.result.read']} />);
    expect(within(rowOf('REG0001')).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^verify/i })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('the bulk button is disabled at 0 selected and reads "Verify n" as rows are selected', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1), item(2), item(3)]} permissions={VERIFY} />);
    expect((bulkBtn('Verify', 0) as HTMLButtonElement).disabled).toBe(true);
    await user.click(selectBox('REG0001'));
    await user.click(selectBox('REG0003'));
    expect((bulkBtn('Verify', 2) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keyboard: Space on a focused row box selects it; Shift+ArrowDown extends the selection to the next row (04-UI-UX §3.8)', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1), item(2), item(3)]} permissions={VERIFY} />);
    selectBox('REG0001').focus();
    await user.keyboard(' ');
    expect((selectBox('REG0001') as HTMLInputElement).checked).toBe(true);
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect((selectBox('REG0002') as HTMLInputElement).checked).toBe(true);
    expect((selectBox('REG0003') as HTMLInputElement).checked).toBe(false);
    expect(bulkBtn('Verify', 2)).toBeTruthy();
  });

  it('"flagged only" filter navigates with flagged_only=true; the URL carries no patient data (REQ-SEC-028)', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1)]} permissions={VERIFY} />);
    await user.click(screen.getByRole('checkbox', { name: /flagged only/i }));
    expect(push).toHaveBeenCalled();
    const target = String(push.mock.calls.at(-1)![0]);
    expect(target).toMatch(/flagged_only=true/);
    expect(target).not.toMatch(/Synthetic|REG0001|SYN0000/);
  });

  it('XSS: a patient name that is markup stays text; no element is created from it (S-14 spirit)', () => {
    wrap(<VerificationQueue items={[item(1, { name: '<img src=x onerror=alert(1)>' })]} permissions={VERIFY} />);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(within(rowOf('REG0001')).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('has no axe violations (with a flagged row and a selection)', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1, { result: DELTA }), item(2)]} permissions={VERIFY} />);
    await user.click(selectBox('REG0002'));
    await noAxeViolations();
  });
});

describe('C5.T-21 verification queue — bulk verify, flagged-row acknowledgement, outcome dialog', () => {
  it('bulk verify of unflagged rows: ONE POST to bulk-verify with an Idempotency-Key, {id, version} only (no acknowledged_flags), then the outcome dialog', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1, { result: { version: 4 } }), item(2)]} permissions={VERIFY} />);
    await user.click(selectBox('REG0001'));
    await user.click(selectBox('REG0002'));
    await user.click(bulkBtn('Verify', 2));
    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
    const c = verifyCalls()[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body.items.map((i: any) => [i.id, i.version])).toEqual([[id(1), 4], [id(2), 1]]);
    for (const i of c.body.items) expect(i.acknowledged_flags ?? []).toEqual([]);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText(/2 done, 0 not done/)).toBeTruthy();
  });

  it('flagged-row acknowledgement: a selected delta-fail row cannot be sent until its "Acknowledge delta" is ticked; then acknowledged_flags = ["delta"] for that row only', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1, { result: DELTA }), item(2)]} permissions={VERIFY} />);
    await user.click(selectBox('REG0001'));
    await user.click(selectBox('REG0002'));
    const b = bulkBtn('Verify', 2) as HTMLButtonElement;
    if (!b.disabled) await user.click(b);
    expect(verifyCalls()).toHaveLength(0); // blocked: nothing sent without the acknowledgement
    await user.click(ackBox('REG0001', /delta/));
    await user.click(bulkBtn('Verify', 2));
    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
    const items = verifyCalls()[0]!.body.items;
    expect(items.find((i: any) => i.id === id(1)).acknowledged_flags).toEqual(['delta']);
    expect(items.find((i: any) => i.id === id(2)).acknowledged_flags ?? []).toEqual([]);
  });

  it('a row needing several flags needs EVERY acknowledgement (delta + critical + unit mismatch + instrument flag); the stored list is exactly the needed set', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1, { result: { ...DELTA, ...CRIT, unit_mismatch: true, instrument_flags: ['clot'] } })]} permissions={VERIFY} />);
    await user.click(selectBox('REG0001'));
    for (const f of [/delta/, /critical/, /unit.?mismatch/]) {
      await user.click(ackBox('REG0001', f));
      const b = bulkBtn('Verify', 1) as HTMLButtonElement;
      if (!b.disabled) await user.click(b);
      expect(verifyCalls()).toHaveLength(0); // still one missing
    }
    await user.click(ackBox('REG0001', /instrument/));
    await user.click(bulkBtn('Verify', 1));
    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
    expect([...verifyCalls()[0]!.body.items[0].acknowledged_flags].sort()).toEqual(['critical', 'delta', 'instrument_flag', 'unit_mismatch']);
  });

  it('un-selecting a flagged, un-acknowledged row unblocks the rest of the batch', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={[item(1, { result: DELTA }), item(2)]} permissions={VERIFY} />);
    await user.click(selectBox('REG0001'));
    await user.click(selectBox('REG0002'));
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Verify', 1));
    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
    expect(verifyCalls()[0]!.body.items.map((i: any) => i.id)).toEqual([id(2)]);
  });

  it('a row that needs no acknowledgement shows no acknowledge box (no blanket "acknowledge all")', () => {
    wrap(<VerificationQueue items={[item(1), item(2, { result: DELTA })]} permissions={VERIFY} />);
    expect(within(rowOf('REG0001')).queryAllByRole('checkbox', { name: /acknowledge/i })).toHaveLength(0);
    expect(within(rowOf('REG0002')).getAllByRole('checkbox', { name: /acknowledge/i })).toHaveLength(1);
  });

  it('AC-15.2: 50 selected, 3 come back `common.not_found` → dialog "47 done, 3 not done" with one reason line per failed id; raw codes never shown', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 50 }, (_, i) => item(i + 1));
    const failed = new Set([id(7), id(21), id(50)]);
    verifyReply = (b) => HttpResponse.json({ results: b.items.map((i: any) => failed.has(i.id) ? { id: i.id, outcome: 'error', code: 'common.not_found' } : { id: i.id, outcome: 'ok' }) });
    wrap(<VerificationQueue items={items} permissions={VERIFY} />);
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    await user.click(bulkBtn('Verify', 50));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/47 done, 3 not done/)).toBeTruthy();
    for (const reg of ['REG0007', 'REG0021', 'REG0050']) expect(within(dlg).getByText(new RegExp(reg))).toBeTruthy();
    expect(within(dlg).queryByText(/REG0001\b/)).toBeNull(); // ok rows are not listed as failures
    expect(within(dlg).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(dlg.textContent).not.toMatch(/common\.not_found|lab\.[a-z_]+/);
  });

  it('per-id verify errors are readable: lab.result_invalid_transition, lab.result_on_hold, lab.flag_ack_required, common.version_conflict', async () => {
    const user = userEvent.setup();
    const codes = ['lab.result_invalid_transition', 'lab.result_on_hold', 'lab.flag_ack_required', 'common.version_conflict'];
    verifyReply = (b) => HttpResponse.json({ results: b.items.map((i: any, k: number) => ({ id: i.id, outcome: 'error', code: codes[k] })) });
    wrap(<VerificationQueue items={[item(1), item(2), item(3), item(4)]} permissions={VERIFY} />);
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    await user.click(bulkBtn('Verify', 4));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/0 done, 4 not done/)).toBeTruthy();
    expect(dlg.textContent).not.toMatch(/lab\.|common\./);
    const lines = within(dlg).getAllByRole('listitem').map((l) => l.textContent ?? '');
    expect(new Set(lines.map((l) => l.replace(/REG\d+|Synthetic Patient \d+|AN\d+/g, '').trim())).size).toBe(4); // four different reasons, none blank
  });

  it('closing the dialog refreshes the queue; failed rows are still listed, ok rows were verified (server state decides — the list is re-fetched, not edited locally)', async () => {
    const user = userEvent.setup();
    verifyReply = (b) => HttpResponse.json({ results: b.items.map((i: any, k: number) => k === 0 ? { id: i.id, outcome: 'error', code: 'lab.result_on_hold' } : { id: i.id, outcome: 'ok' }) });
    wrap(<VerificationQueue items={[item(1), item(2)]} permissions={VERIFY} />);
    await user.click(selectBox('REG0001'));
    await user.click(selectBox('REG0002'));
    await user.click(bulkBtn('Verify', 2));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /close|done|ok/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('double submit: clicking Verify twice quickly sends ONE request; the dialog opens once', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    verifyReply = async (b) => { await gate; return okAll(b); };
    wrap(<VerificationQueue items={[item(1)]} permissions={VERIFY} />);
    await user.click(selectBox('REG0001'));
    const b = bulkBtn('Verify', 1);
    await user.click(b);
    await user.click(b);
    release();
    await screen.findByRole('dialog');
    expect(verifyCalls()).toHaveLength(1);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('more than 200 selected: no single request carries more than 200 items (OpenAPI maxItems 200)', async () => {
    const user = userEvent.setup();
    wrap(<VerificationQueue items={Array.from({ length: 250 }, (_, i) => item(i + 1))} permissions={VERIFY} />);
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    const b = bulkBtn('Verify') as HTMLButtonElement;
    if (!b.disabled) await user.click(b);
    await new Promise((r) => setTimeout(r, 50));
    for (const c of verifyCalls()) expect(c.body.items.length).toBeLessThanOrEqual(200);
    expect(verifyCalls().flatMap((c) => c.body.items).length === 250 || verifyCalls().length === 0).toBe(true); // all sent in batches, or blocked — never truncated silently
  });

  it('request-level failure (500) → error banner, nothing marked done, no outcome dialog', async () => {
    const user = userEvent.setup();
    verifyReply = () => problem(500, 'common.internal');
    wrap(<VerificationQueue items={[item(1)]} permissions={VERIFY} />);
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Verify', 1));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toMatch(/common\.internal/);
  });
});

// ───────────────────────────────────────── Approval queue
describe('C5.T-21 approval queue — list, bulk approve, step-up (AC-16.3)', () => {
  it('empty → "Nothing waiting for approval."; rows render reg no and patient', () => {
    const { unmount } = wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } })]} permissions={APPROVE} />);
    expect(within(rowOf('REG0001')).getByText(/Synthetic Patient 1/)).toBeTruthy();
    unmount();
    wrap(<ApprovalQueue items={[]} permissions={APPROVE} />);
    expect(screen.getByText('Nothing waiting for approval.')).toBeTruthy();
  });

  it('without lab.result.approve → read-only (no boxes, no Approve button) — the API still enforces aal2 and the permission (S-01)', () => {
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } })]} permissions={['lab.result.read', 'lab.result.verify']} />);
    expect(screen.queryByRole('button', { name: /^approve/i })).toBeNull();
    expect(within(rowOf('REG0001')).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('bulk approve: POST bulk-approve with an Idempotency-Key and {id, version} only — never acknowledged_flags (approval has no acknowledgement)', async () => {
    const user = userEvent.setup();
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified', version: 3, ...DELTA } }), item(2, { result: { status: 'verified' } })]} permissions={APPROVE} />);
    await user.click(selectBox('REG0001'));
    await user.click(selectBox('REG0002'));
    await user.click(bulkBtn('Approve', 2));
    await waitFor(() => expect(approveCalls()).toHaveLength(1));
    const c = approveCalls()[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body).toEqual({ items: [{ id: id(1), version: 3 }, { id: id(2), version: 1 }] });
    expect(verifyCalls()).toHaveLength(0);
    expect(within(await screen.findByRole('dialog')).getByText(/2 done, 0 not done/)).toBeTruthy();
  });

  it('AC-16.3: 403 auth.mfa_required → warning banner "Verify now"; nothing marked approved, no outcome dialog, no raw code', async () => {
    const user = userEvent.setup();
    approveReply = () => problem(403, 'auth.mfa_required');
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } })]} permissions={APPROVE} onStepUp={vi.fn()} />);
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Approve', 1));
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toMatch(/auth\.mfa_required/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('AC-16.3: "Verify now" runs the step-up hook, then RE-SENDS the same request with the SAME Idempotency-Key and body → outcome dialog', async () => {
    const user = userEvent.setup();
    approveReply = (b, n) => (n === 0 ? problem(403, 'auth.mfa_required') : okAll(b));
    const onStepUp = vi.fn(async () => {});
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } })]} permissions={APPROVE} onStepUp={onStepUp} />);
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Approve', 1));
    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: /verify now/i }));
    await waitFor(() => expect(approveCalls()).toHaveLength(2));
    expect(onStepUp).toHaveBeenCalledTimes(1);
    const [a, b] = approveCalls();
    expect(b!.headers.get('idempotency-key')).toBe(a!.headers.get('idempotency-key'));
    expect(b!.body).toEqual(a!.body);
    expect(within(await screen.findByRole('dialog')).getByText(/1 done, 0 not done/)).toBeTruthy();
  });

  it('step-up cancelled/failed (hook rejects) → no retry is sent, the banner stays, the selection is kept', async () => {
    const user = userEvent.setup();
    approveReply = () => problem(403, 'auth.mfa_required');
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } })]} permissions={APPROVE} onStepUp={vi.fn(async () => { throw new Error('cancelled'); })} />);
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Approve', 1));
    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: /verify now/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(approveCalls()).toHaveLength(1);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect((selectBox('REG0001') as HTMLInputElement).checked).toBe(true);
  });

  it('a changed selection after the 403 gets a NEW Idempotency-Key (same key only for the identical retry)', async () => {
    const user = userEvent.setup();
    approveReply = (b, n) => (n === 0 ? problem(403, 'auth.mfa_required') : okAll(b));
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } }), item(2, { result: { status: 'verified' } })]} permissions={APPROVE} onStepUp={vi.fn()} />);
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Approve', 1));
    await screen.findByRole('alert');
    await user.click(selectBox('REG0002'));
    await user.click(bulkBtn('Approve', 2));
    await waitFor(() => expect(approveCalls()).toHaveLength(2));
    const [a, b] = approveCalls();
    expect(b!.headers.get('idempotency-key')).not.toBe(a!.headers.get('idempotency-key'));
  });

  it('S-02 / AC-16.2: per-id 403 lab.self_approval_forbidden → "You verified this result. Another pathologist must approve it."', async () => {
    const user = userEvent.setup();
    approveReply = (b) => HttpResponse.json({ results: b.items.map((i: any, k: number) => k === 0 ? { id: i.id, outcome: 'error', code: 'lab.self_approval_forbidden' } : { id: i.id, outcome: 'ok' }) });
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } }), item(2, { result: { status: 'verified' } })]} permissions={APPROVE} />);
    await user.click(selectBox('REG0001'));
    await user.click(selectBox('REG0002'));
    await user.click(bulkBtn('Approve', 2));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/1 done, 1 not done/)).toBeTruthy();
    expect(within(dlg).getByText('You verified this result. Another pathologist must approve it.')).toBeTruthy();
    expect(dlg.textContent).not.toMatch(/lab\.self_approval_forbidden/);
  });

  it('AC-13.5: per-id lab.critical_ack_required → "Record the critical-value notification before approving." with a link to the critical event', async () => {
    const user = userEvent.setup();
    approveReply = (b) => HttpResponse.json({ results: b.items.map((i: any) => ({ id: i.id, outcome: 'error', code: 'lab.critical_ack_required' })) });
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified', ...CRIT } })]} permissions={APPROVE} />);
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Approve', 1));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Record the critical-value notification before approving.')).toBeTruthy();
    const link = within(dlg).getByRole('link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain(CRIT_EVENT);
    expect(dlg.textContent).not.toMatch(/lab\.critical_ack_required/);
  });

  it('per-id lab.result_invalid_transition / lab.result_on_hold on approve are readable; a result the server calls common.not_found is listed per id (AC-15.2 for approve)', async () => {
    const user = userEvent.setup();
    const codes = ['lab.result_invalid_transition', 'lab.result_on_hold', 'common.not_found'];
    approveReply = (b) => HttpResponse.json({ results: b.items.map((i: any, k: number) => ({ id: i.id, outcome: 'error', code: codes[k] })) });
    wrap(<ApprovalQueue items={[item(1), item(2), item(3)].map((i) => ({ ...i, result: { ...i.result, status: 'verified' } }))} permissions={APPROVE} />);
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    await user.click(bulkBtn('Approve', 3));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/0 done, 3 not done/)).toBeTruthy();
    expect(dlg.textContent).not.toMatch(/lab\.|common\./);
    expect(within(dlg).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
  });

  it('has no axe violations (approval list with a banner)', async () => {
    const user = userEvent.setup();
    approveReply = () => problem(403, 'auth.mfa_required');
    wrap(<ApprovalQueue items={[item(1, { result: { status: 'verified' } })]} permissions={APPROVE} onStepUp={vi.fn()} />);
    await user.click(selectBox('REG0001'));
    await user.click(bulkBtn('Approve', 1));
    await screen.findByRole('alert');
    await noAxeViolations();
  });
});
