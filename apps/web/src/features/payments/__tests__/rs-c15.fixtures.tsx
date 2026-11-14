// RS-C15 shared fixtures + DOM helpers (tester-owned; NOT a test file: no vi.mock here, every test file declares its own mocks because they are hoisted per file).
import { expect } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
export const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

export const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

const TONES = ['neutral', 'info', 'success', 'warning', 'danger', 'critical'];
/** Every status chip in `root` is tone + icon + word (10-DESIGN-SYSTEM s6 "colour-only status"). Returns the chips.
 *  FilterBar multi-select options are `lims-option lims-chip` (role="option"): filter controls, not status displays (RS-C15 ruling), so they are skipped. */
export function chipsAreComplete(root: ParentNode): HTMLElement[] {
  const chips = [...root.querySelectorAll<HTMLElement>('.lims-chip:not([role="option"])')];
  for (const c of chips) {
    expect(TONES, `tone of chip "${c.textContent}"`).toContain(c.getAttribute('data-tone'));
    expect(c.querySelector('svg'), `icon of chip "${c.textContent}"`).not.toBeNull();
    expect((c.textContent ?? '').trim().length, 'chip word').toBeGreaterThan(0);
  }
  return chips;
}

const HEAD = '[role="columnheader"], th';
const CELL = '[role="gridcell"], [role="rowheader"], [role="cell"], td, th';
/** The data rows' cells under the column whose header text matches `header` (exact, case-insensitive) inside the table/grid `grid`. */
export function columnCells(grid: HTMLElement, header: RegExp): HTMLElement[] {
  const heads = [...grid.querySelectorAll<HTMLElement>(HEAD)];
  const i = heads.findIndex((h) => header.test((h.textContent ?? '').trim()));
  expect(i, `column ${header} among ${heads.map((h) => h.textContent).join(' | ')}`).toBeGreaterThanOrEqual(0);
  return [...grid.querySelectorAll<HTMLElement>('[role="row"], tr')]
    .map((r) => [...r.querySelectorAll<HTMLElement>(CELL)])
    .filter((cells) => cells.length === heads.length && !cells.some((c) => c.matches(HEAD)))
    .map((cells) => cells[i]!);
}
/** Same as columnCells but includes the row-header cell when it is the first column. */
export const dataRows = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>('[role="row"], tr')].filter((r) => r.querySelector(CELL) && !r.querySelector(HEAD));

/** Normalise react-aria generated ids so DOM snapshots are stable. */
export const norm = (html: string) =>
  html
    .replace(/react-aria\d*-:?[\w-]+:?/g, 'aria-id')
    .replace(/:r[0-9a-z]+:/g, ':rN:')
    .replace(/(id|for|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-activedescendant)="[^"]*(?:aria-id|:rN:)[^"]*"/g, '$1="ID"')
    .replace(/></g, '>\n<');

// ---- reconciliation ----
export const reconCodes = {
  finding_kinds: [['missed_settlement', 'Missed settlement'], ['late_payment_found', 'Late payment found'], ['amount_mismatch', 'Amount mismatch'], ['gateway_unreachable', 'Provider unreachable']]
    .map(([code, display]) => ({ code: code!, display: display!, requires_text: false, is_active: true })),
  finding_resolutions: [
    { code: 'confirmed_ok', display: 'Confirmed OK', requires_text: false, is_active: true },
    { code: 'other', display: 'Other', requires_text: true, is_active: true },
  ],
};
export const reconRuns = [
  { id: U(501), business_date: '2026-11-10', trigger: 'cron', status: 'completed', started_at: '2026-11-10T20:40:00.000Z', finished_at: '2026-11-10T21:05:00.000Z', counts: { checked: 120, ok: 117, findings: 3, critical: 1 }, version: 1 },
  { id: U(502), business_date: '2026-11-12', trigger: 'manual', status: 'running', started_at: '2026-11-12T05:00:00.000Z', counts: { checked: 0, ok: 0, findings: 0, critical: 0 }, version: 1 },
  { id: U(503), business_date: '2026-11-09', trigger: 'cron', status: 'failed', started_at: '2026-11-09T20:40:00.000Z', finished_at: '2026-11-09T21:00:00.000Z', counts: { checked: 40, ok: 40, findings: 0, critical: 0 }, version: 1 },
];
const finding = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(600 + n), kind: 'missed_settlement', severity: 'warning', intent_id: U(100 + n), our_status: 'initiated', gateway_status_raw: 'COMPLETE', our_amount: npr(50000),
  gateway_amount: npr(50000), auto_action: 'settled', status: 'open', created_at: '2026-11-10T21:00:00.000Z', version: 1, ...o,
});
export const reconFindings = [
  finding(1),
  finding(2, { kind: 'amount_mismatch', severity: 'critical', our_status: 'settled', gateway_amount: npr(45000), auto_action: 'none' }),
  finding(3, { kind: 'late_payment_found', severity: 'critical', our_status: 'expired', auto_action: 'held' }),
  finding(4, { kind: 'gateway_unreachable', severity: 'info', intent_id: undefined, our_status: undefined, gateway_status_raw: undefined, our_amount: undefined, gateway_amount: undefined, auto_action: 'none' }),
];
export const reconStats = { lastSuccessfulRunAt: '2026-11-10T21:05:00.000Z', openCritical: 2, underReview: 1 };

// ---- review queue ----
export const reviewIntents = [
  { id: U(101), order_id: U(201), centre_id: U(3), gateway: 'esewa', status: 'held_for_review', amount: npr(12345600), hold_reason: 'amount_mismatch', created_at: '2026-11-10T04:00:00.000Z', last_checked_at: '2026-11-10T04:20:00.000Z', version: 3 },
  { id: U(102), order_id: U(202), centre_id: U(3), gateway: 'khalti', status: 'failed', amount: npr(50000), failure_reason: 'provider_declined', created_at: '2026-11-10T03:00:00.000Z', version: 2 },
  { id: U(103), order_id: U(203), centre_id: U(3), gateway: 'esewa', status: 'expired', amount: npr(75000), created_at: '2026-11-10T02:00:00.000Z', version: 2 },
];
export const holdReasons = [{ code: 'amount_mismatch', display: 'Amount differs from the due', requires_text: false, is_active: true }];

// ---- intent detail ----
export const intentCodes = {
  resolution_reasons: [{ code: 'gateway_confirmed_paid', display: 'Provider confirmed paid', requires_text: false, is_active: true }],
  cancel_reasons: [{ code: 'patient_changed_method', display: 'Patient changed method', requires_text: false, is_active: true }],
  refund_reasons: [{ code: 'overpaid', display: 'Overpaid', requires_text: false, is_active: true }],
};
export const intentDetail = {
  id: U(101), order_id: U(201), centre_id: U(3), gateway: 'esewa', environment: 'production', status: 'settled', amount: npr(12345600),
  created_at: '2026-11-10T04:00:00.000Z', settled_at: '2026-11-10T04:25:00.000Z', last_checked_at: '2026-11-10T04:20:00.000Z', version: 7,
  gateway_txn_ref: 'esewa-txn-0001', last_gateway_status_raw: 'COMPLETE', verified_amount: npr(12345600), verification_method: 'status_check', refunded_amount: npr(1000000),
  ledger_entry_id: U(301), created_by_actor_type: 'user',
  transitions: [
    { to_status: 'created', cause: 'create', actor_type: 'user', at: '2026-11-10T04:00:00.000Z' },
    { from_status: 'initiated', to_status: 'settled', cause: 'poll', actor_type: 'system', at: '2026-11-10T04:25:00.000Z' },
  ],
  gateway_checks: [{ operation: 'esewa_status', outcome: 'answer', gateway_status_raw: 'COMPLETE', http_status: 200, at: '2026-11-10T04:20:00.000Z' }],
  callbacks: [{ kind: 'esewa_success', outcome_code: 'accepted', signature_valid: true, at: '2026-11-10T04:19:00.000Z' }],
  refunds: [
    { id: U(701), status: 'completed', amount: npr(500000), reason_code: 'overpaid', requested_at: '2026-11-10T05:00:00.000Z' },
    { id: U(702), status: 'failed', amount: npr(300000), reason_code: 'overpaid', requested_at: '2026-11-10T05:10:00.000Z' },
    { id: U(703), status: 'pending_approval', amount: npr(200000), reason_code: 'overpaid', requested_at: '2026-11-10T05:20:00.000Z' },
  ],
};

// ---- refunds list ----
export const refundCodes = {
  refund_reject_reasons: [{ code: 'not_valid', display: 'Not valid', requires_text: false, is_active: true }],
  refund_fail_reasons: [{ code: 'provider_declined', display: 'Provider declined', requires_text: false, is_active: true }],
  refund_hold_reasons: [{ code: 'provider_unclear', display: 'Provider answer unclear', requires_text: false, is_active: true }],
};
const refund = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(700 + n), intent_id: U(100 + n), order_id: U(200 + n), gateway: 'esewa', mode: 'manual', status: 'pending_approval', amount: npr(200000), reason_code: 'overpaid',
  requested_by: { membership_id: U(90), display_name: 'Synthetic Cashier' }, requested_at: '2026-11-10T05:00:00.000Z', version: 1, ...o,
});
export const refunds = [refund(1), refund(2, { status: 'completed', approved_by: { membership_id: U(91), display_name: 'Synthetic Finance' }, approved_at: '2026-11-10T06:00:00.000Z' }), refund(3, { status: 'failed' }), refund(4, { status: 'rejected' })];

// ---- static QR ----
export const worksheets = [
  { id: U(801), business_date: '2026-11-09', centre_id: U(3), system_entries: 12, system_total: npr(1500000), statement_total: npr(1500000), difference: npr(0), status: 'matched', created_at: '2026-11-10T01:00:00.000Z' },
  { id: U(802), business_date: '2026-11-08', centre_id: U(3), system_entries: 9, system_total: npr(900000), statement_total: npr(895000), difference: npr(-5000), status: 'accepted_with_difference', statement_reference: 'STMT-SYN-1', created_at: '2026-11-09T01:00:00.000Z' },
];

// ---- settings ----
export const accounts = [
  { gateway: 'esewa', environment: 'production', is_enabled: true, esewa_product_code: 'SYNTH', secret: { is_set: true, fingerprint: 'ab12cd34' }, version: 2 },
  { gateway: 'khalti', environment: 'production', is_enabled: false, khalti_website_url: 'https://synthetic.example', api_refunds_enabled: false, secret: { is_set: false }, version: 1 },
];
export const paySettings = { refund_two_person_threshold: npr(1000000), purchase_order_label: 'PO number', reconciliation_enabled: true, version: 4 };
