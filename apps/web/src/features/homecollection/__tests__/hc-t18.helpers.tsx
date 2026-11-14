// HC-T18 shared test helpers (tester-owned; not a test file). No vi.mock here: every test file declares its own mocks (hoisted per file).
// Synthetic data only (01-PRD §"Every criterion is a test"): tenant "Synthetic Lab Alpha", centre HC-A1, "Test Phlebo 01", "Test Patient 0042".
import { expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
export const API = `${ORIGIN}/v1/homecollection`;

export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE = U(1);
export const DATE = '2026-11-14'; // board date (Asia/Kathmandu)
export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });

export const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
export const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

export interface Call { method: string; url: URL; headers: Headers; body?: any }
export const recorder = (calls: Call[]) => async (r: Request) => {
  calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) });
};
export const isEnabled = (el: HTMLElement | null | undefined) => !!el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
/** No problem+json code or internal identifier is ever shown to a user. */
export const noRawCodes = () => expect(document.body.textContent).not.toMatch(/\b(homecollection|common|auth|frontdesk|catalog)\.[a-z_]+\b|urn:lims|Bearer |jwt-synthetic/);
/** "DD/MM/YYYY hh:mm AM" in Asia/Kathmandu — the kit DateTimePicker's typed format. */
export const kathmandu = (d: Date | string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
      .formatToParts(new Date(d)).map((x) => [x.type, x.value]),
  );
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']} ${String(p['dayPeriod']).toUpperCase()}`;
};
/** No per-keystroke timer: the default `userEvent.type` delay caused load-dependent 20 s timeouts (HC-T18-ruling.md). */
const user = userEvent.setup({ delay: null });
/** Clears a text field and types `v`; values over 20 characters are pasted (the keyboard walk-through still types char by char). */
export const fill = async (el: HTMLElement, v: string) => {
  await user.clear(el);
  if (!v) return;
  if (v.length > 20) { await user.click(el); await user.paste(v); } else await user.type(el, v);
};
/** Opens the select named `label` inside `scope` and picks the option. */
export const pick = async (scope: HTMLElement, option: RegExp | string, label: RegExp) => {
  await user.click(within(scope).getByRole('button', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
};

// ---- fixtures (TRD §5.1 VisitSummaryDto / RouteDto / H12 rows) ----
const spec = (expected: number, collected = 0) => ({ expected, collected, held: 0, received: 0, rejected: 0 });
export const visit = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(1000 + n), version: 3, kind: 'booking', status: 'unassigned', centre_id: CENTRE, branch_id: U(2), patient_id: U(3000 + n),
  patient_display_name: `Test Patient ${String(40 + n).padStart(4, '0')}`, open_flag_kinds: [] as string[], specimens_summary: spec(2), ...o,
} as { id: string; version: number; kind: string; status: string; centre_id: string; branch_id: string; patient_id: string; patient_display_name: string; open_flag_kinds: string[]; specimens_summary: ReturnType<typeof spec>; order_id: string; window_start: string; window_end: string });
export const route = (n: number, visitIds: string[], o: Record<string, unknown> = {}) => ({
  id: U(4000 + n), version: 4, centre_id: CENTRE, route_date: DATE, phlebotomist: { membership_id: U(5000 + n), display_name: `Test Phlebo ${String(n).padStart(2, '0')}` },
  visit_ids_in_order: visitIds, active_visits: visitIds.length, completed_visits: 0, ...o,
});

// Unassigned: V1 no window + address_missing; V2 scheduled (08:45–09:15 KTM) with area; V3 front-desk visit.
export const V1 = visit(2, { open_flag_kinds: ['address_missing'] });
export const V2 = visit(3, { window_start: '2026-11-14T03:00:00.000Z', window_end: '2026-11-14T03:30:00.000Z', area_hint: 'Baneshwor, Kathmandu' });
export const V3 = visit(4, { kind: 'front_desk', order_id: U(6004) });
// Route R1 (Test Phlebo 01): A1 assigned + order + 1/2 tubes, A2 in progress + order, A3 assigned WITHOUT order_id (no labels link), version 4.
const inRoute = (n: number, seq: number, o: Record<string, unknown>) => visit(n, { route_id: U(4001), route_date: DATE, route_sequence: seq, phlebotomist: { membership_id: U(5001), display_name: 'Test Phlebo 01' }, ...o });
export const A1 = inRoute(10, 1, { status: 'assigned', order_id: U(6010), specimens_summary: spec(2, 1), window_start: '2026-11-14T02:30:00.000Z', window_end: '2026-11-14T03:00:00.000Z' });
export const A2 = inRoute(11, 2, { status: 'in_progress', order_id: U(6011), specimens_summary: spec(3, 0), open_flag_kinds: ['held_collection'] });
export const A3 = inRoute(12, 3, { status: 'assigned', specimens_summary: spec(0) });
export const R1 = route(1, [A1.id, A2.id, A3.id], { last_ack_at: '2026-11-14T02:00:00.000Z' });
// Route R2 (Test Phlebo 02): one visit, phone never synced.
export const B1 = visit(20, { route_id: U(4002), route_date: DATE, route_sequence: 1, status: 'assigned', order_id: U(6020), phlebotomist: { membership_id: U(5002), display_name: 'Test Phlebo 02' } });
export const R2 = route(2, [B1.id]);
export const VISITS = [V1, V2, V3, A1, A2, A3, B1];
export const ROUTES = [R1, R2];
export const reasons = (rows: [string, string, boolean?][]) => rows.map(([code, display, requires_text]) => ({ code, display, requires_text: !!requires_text, is_active: true }));
export const CODES = {
  visit_cancel_reasons: reasons([['patient_cancelled', 'Patient cancelled'], ['duplicate', 'Duplicate visit'], ['other', 'Other', true]]),
  unassign_reasons: reasons([['phlebotomist_unavailable', 'Phlebotomist unavailable'], ['wrong_route', 'Wrong route'], ['other', 'Other', true]]),
};
export const PERMS_READ = ['homecollection.visit.read'];
export const PERMS_DISPATCH = [...PERMS_READ, 'homecollection.visit.assign', 'lab.specimen.label_print'];
export const CENTRES = [{ id: CENTRE, name: 'HC-A1' }, { id: U(7), name: 'HC-A2' }];
/** The row (role=row) of the table `table` containing `text`. */
export const rowOf = (table: HTMLElement, text: RegExp | string) => within(table).getAllByRole('row').find((r) => (typeof text === 'string' ? r.textContent!.includes(text) : text.test(r.textContent ?? '')))!;
export { userEvent };
