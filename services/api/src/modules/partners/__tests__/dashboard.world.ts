// C13 T18 test fixture (tester-owned, not a test file): seeded world + request context for the partner dashboard (A2 getPartnerDashboard).
// Builds on the T13 world (tracking-api.world.ts makeCtx: pipeline emulation, IdentityPort.assertRole, access-log validator, metrics) and the T12/T17 SQL world (projection.world.ts).
// SQL subset = projection.world.ts (single table per statement, bound $n only, no joins / sub-selects / GROUP BY) PLUS ONE aggregate per statement, added here:
//     SELECT count(*)[::int] [AS alias] FROM <t> WHERE ...      -> {alias|count: n}        (without ::int a bare count is a STRING, like node-pg bigint)
//     SELECT sum(<col>)[::int] [AS alias] FROM <t> WHERE ...    -> {alias|sum: total|null} (no rows -> null, like Postgres: coalesce in JS or in SQL is not supported)
//     SELECT max(<col>) [AS alias] FROM <t> WHERE ...           -> {alias|max: value|null}
// The world runs with rls=false: the handler must scope by tenant_id AND partner_id itself. All data synthetic.
import { LimsError } from '../../../core/errors.js';
import { TRACKING_DEFS } from './tracking.world.js';
import { id, makeWorld, P, SYSTEM, T_A, T_B, type Row, type World } from './projection.world.js';
import { makeCtx, NOW13, U, type Opts, type Who } from './tracking-api.world.js';

export { id, NOW13, P, SYSTEM, T_A, T_B, U };
export type { Row, Who, World };

const at = (s: string) => new Date(s);
/** tenant calendar day of NOW13 (2026-11-13T06:00Z = 11:45 NPT, UTC+05:45): [2026-11-12T18:15:00Z, 2026-11-13T18:15:00Z) */
export const DAY_START_NPT = '2026-11-12T18:15:00.000Z';
export const SYNCED = { x: '2026-11-13T05:10:00.000Z', y: '2026-11-12T09:30:00.000Z', b: '2026-11-13T01:00:00.000Z' };
const CENTRE = id(60);
const M = { adminX: id(910), memberX: id(911), adminY: id(912), adminZ: id(913), adminB: id(914) };

export const makeDashboardWorld = (): World => {
  const w = makeWorld({ defs: TRACKING_DEFS, tables: ['partners.manifests', 'partners.pickup_requests'] });
  const inner = w.tx.query.bind(w.tx);
  const AGG = /^\s*SELECT\s+(?:count\(\*\)|(sum|max)\(\s*(\w+)\s*\))(::(?:int|integer|bigint))?(?:\s+AS\s+(\w+))?\s+(FROM\s[\s\S]+)$/i;
  w.tx.query = async (text: string, values: unknown[] = []) => {
    const m = AGG.exec(text.replace(/\s+/g, ' ').replace(/;$/, ''));
    if (!m) return inner(text, values);
    const [, fn, col, cast, alias, rest] = m;
    const kind = (fn ?? 'count').toLowerCase();
    const r = await inner(`SELECT * ${rest}`, values);
    w.log[w.log.length - 1]!.text = text; // log the writer's statement, not the rewritten one
    const n = (x: unknown) => Number(x);
    let v: unknown;
    if (kind === 'count') v = cast ? r.rows.length : String(r.rows.length);
    else {
      const vals = r.rows.map((x) => x[col!]).filter((x) => x != null);
      if (kind === 'sum') v = vals.length === 0 ? null : cast ? vals.reduce((a, b) => a + n(b), 0) : String(vals.reduce((a, b) => a + n(b), 0));
      else v = vals.length === 0 ? null : vals.reduce((a, b) => (new Date(b as string).getTime() > new Date(a as string).getTime() ? b : a));
    }
    return { rows: [{ [alias ?? kind]: v }], rowCount: 1 };
  };
  return w;
};

let seq = 5000;
const nid = () => id(++seq);
const base = (tenant: string, partner: string) => ({ tenant_id: tenant, partner_id: partner });
function tracking(tenant: string, partner: string, status: string, lastEvent: string): Row {
  const order = nid();
  return { ...base(tenant, partner), order_id: order, line_id: nid(), manifest_id: id(70), receiving_centre_id: CENTRE, registration_no: `SYN-${seq}`, tracking_status: status, registered_at: at('2026-11-01T02:00:00Z'),
    last_event_at: at(lastEvent), cancelled_at: null, report_count: 0, stored_order_status: null, reconciled_at: null, version: 1, created_at: at('2026-11-01T02:00:00Z'), created_by: SYSTEM, updated_at: at(lastEvent), updated_by: SYSTEM };
}
function report(tenant: string, partner: string, order: string, status: 'valid' | 'superseded', isNew: boolean): Row {
  return { ...base(tenant, partner), report_id: nid(), version_no: 1, order_id: order, receiving_centre_id: CENTRE, status, kind: 'final', panel_names: null, is_new: isNew, seen_at: isNew ? null : at('2026-11-12T09:00:00Z'),
    seen_by: null, enriched_at: null, released_at: at('2026-11-12T05:00:00Z'), created_at: at('2026-11-12T05:00:00Z'), created_by: SYSTEM, updated_at: at('2026-11-12T05:00:00Z'), updated_by: SYSTEM };
}
const manifest = (tenant: string, partner: string, state: string, lineCount: number, submittedAt: string | null): Row =>
  ({ id: nid(), ...base(tenant, partner), manifest_no: `MF26${String(seq).padStart(6, '0')}`, state, line_count: lineCount, submitted_at: submittedAt ? at(submittedAt) : null });
const pickup = (tenant: string, partner: string, state: string): Row => ({ id: nid(), ...base(tenant, partner), state });
const stmt = (tenant: string, partner: string, month: string, fy: string, closing: string, synced: string): Row =>
  ({ ...base(tenant, partner), credit_party_id: id(40), period_month: month, fiscal_year_bs: fy, invoiced_paisa: '100', paid_paisa: '0', credited_paisa: '0', closing_balance_paisa: closing, synced_at: at(synced), is_stale: false,
    created_at: at(synced), created_by: SYSTEM, updated_at: at(synced), updated_by: SYSTEM });

/**
 * Users/partners always. With `data` (default true), "today" = 2026-11-13 in Asia/Kathmandu:
 *  PARTNER X (EXPECTED_X): manifests submitted today 3 (07:45 NPT) + 2 (exactly 00:00 NPT = 2026-11-12T18:15Z, UTC date is yesterday) = 5; NOT counted: one submitted 23:59:59 NPT yesterday (5 lines),
 *    a draft (7), a discarded draft (6). Orders: in_lab 3, reported 4 (last_event today 03:00Z, at the NPT midnight 18:15Z, 1 s before it, 3 days ago) -> reported_today 2, action_needed 2,
 *    partially_reported 1 / registered 1 / in_transit 1 / cancelled 1 (today) count nowhere. Reports: valid is_new 3; NOT counted: superseded is_new 1, valid seen 2. Pickups: requested 2 + scheduled 1 = 3
 *    (picked_up 4, cancelled 1, rejected 1 not). Statements: Oct (latest month) closing 150000 + an older month with a BIGGER balance (999999) and two FY rows -> outstanding 150000, as_of = latest synced_at.
 *  PARTNER Y (EXPECTED_Y) and tenant B's partner (EXPECTED_B): other numbers (isolation). Y's closing balance is 0 (a real zero, not "absent"). PARTNER Z is suspended; its user may not call.
 */
export function seedDashboard(w: World, o: { data?: boolean } = {}) {
  const T = w.t;
  T['partners.partners']!.push(
    { id: P.x, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active', conversion_mode: 'on_receipt' },
    { id: P.y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active', conversion_mode: 'on_receipt' },
    { id: P.z, tenant_id: T_A, partner_code: 'SYN-Z', name: 'Synthetic Partner Z', status: 'suspended', conversion_mode: 'on_receipt' },
    { id: P.b, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active', conversion_mode: 'on_receipt' });
  const user = (k: Who, tenant: string, partner: string, role: string) => ({ id: U[k], tenant_id: tenant, partner_id: partner, membership_id: M[k], partner_role: role, status: 'active', display_name: `Synthetic ${k}` });
  T['partners.partner_users']!.push(user('adminX', T_A, P.x, 'partner_admin'), user('memberX', T_A, P.x, 'partner_member'), user('adminY', T_A, P.y, 'partner_admin'),
    user('adminZ', T_A, P.z, 'partner_admin'), user('adminB', T_B, P.b, 'partner_admin'));
  if (o.data === false) return;

  const trk = T['partners.order_tracking']!, rep = T['partners.order_reports']!;
  const orders = (tenant: string, partner: string, status: string, lastEvents: string[]) => lastEvents.map((le) => { const t = tracking(tenant, partner, status, le); trk.push(t); return t; });
  const OLD = '2026-11-10T02:00:00Z';
  // ---- partner X
  T['partners.manifests']!.push(
    manifest(T_A, P.x, 'received', 3, '2026-11-13T02:00:00Z'), manifest(T_A, P.x, 'submitted', 2, DAY_START_NPT), manifest(T_A, P.x, 'received', 5, '2026-11-12T18:14:59Z'),
    manifest(T_A, P.x, 'draft', 7, null), manifest(T_A, P.x, 'discarded', 6, null));
  const xLab = orders(T_A, P.x, 'in_lab', [OLD, '2026-11-12T02:00:00Z', '2026-11-13T04:00:00Z']);
  orders(T_A, P.x, 'reported', ['2026-11-13T03:00:00Z', DAY_START_NPT, '2026-11-12T18:14:59Z', OLD]);
  orders(T_A, P.x, 'action_needed', [OLD, '2026-11-13T01:00:00Z']);
  orders(T_A, P.x, 'partially_reported', ['2026-11-13T02:00:00Z']); orders(T_A, P.x, 'registered', ['2026-11-13T02:00:00Z']);
  orders(T_A, P.x, 'in_transit', ['2026-11-13T02:00:00Z']); orders(T_A, P.x, 'cancelled', ['2026-11-13T02:00:00Z']);
  rep.push(report(T_A, P.x, xLab[0]!.order_id, 'valid', true), report(T_A, P.x, xLab[1]!.order_id, 'valid', true), report(T_A, P.x, xLab[2]!.order_id, 'valid', true),
    report(T_A, P.x, xLab[0]!.order_id, 'superseded', true), report(T_A, P.x, xLab[1]!.order_id, 'valid', false), report(T_A, P.x, xLab[2]!.order_id, 'valid', false));
  T['partners.pickup_requests']!.push(...['requested', 'requested', 'scheduled', 'picked_up', 'picked_up', 'picked_up', 'picked_up', 'cancelled', 'rejected'].map((s) => pickup(T_A, P.x, s)));
  T['partners.statement_months']!.push(stmt(T_A, P.x, '2026-10-01', '2083/84', '150000', SYNCED.x), stmt(T_A, P.x, '2026-09-01', '2083/84', '999999', '2026-11-01T00:00:00Z'),
    stmt(T_A, P.x, '2026-07-01', '2082/83', '777777', '2026-11-01T00:00:00Z'), stmt(T_A, P.x, '2026-07-01', '2083/84', '888888', '2026-11-01T00:00:00Z'));
  // ---- partner Y (same tenant)
  T['partners.manifests']!.push(manifest(T_A, P.y, 'received', 11, '2026-11-13T02:00:00Z'));
  const yLab = orders(T_A, P.y, 'in_lab', [OLD, OLD, OLD, OLD]); orders(T_A, P.y, 'reported', ['2026-11-13T03:00:00Z']); orders(T_A, P.y, 'action_needed', [OLD, OLD]);
  rep.push(report(T_A, P.y, yLab[0]!.order_id, 'valid', true), report(T_A, P.y, yLab[1]!.order_id, 'valid', true));
  T['partners.pickup_requests']!.push(...Array.from({ length: 5 }, () => pickup(T_A, P.y, 'requested')));
  T['partners.statement_months']!.push(stmt(T_A, P.y, '2026-10-01', '2083/84', '0', SYNCED.y));
  // ---- tenant B
  T['partners.manifests']!.push(manifest(T_B, P.b, 'received', 13, '2026-11-13T02:00:00Z'));
  const bLab = orders(T_B, P.b, 'in_lab', [OLD, OLD, OLD, OLD, OLD]); orders(T_B, P.b, 'reported', ['2026-11-13T03:00:00Z', '2026-11-13T03:00:00Z', '2026-11-13T03:00:00Z']); orders(T_B, P.b, 'action_needed', [OLD]);
  rep.push(...bLab.slice(0, 4).map((t) => report(T_B, P.b, t.order_id, 'valid', true)));
  T['partners.pickup_requests']!.push(...Array.from({ length: 6 }, () => pickup(T_B, P.b, 'requested')));
  T['partners.statement_months']!.push(stmt(T_B, P.b, '2026-10-01', '2083/84', '5550000', SYNCED.b));
}

const npr = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
export const EXPECTED_X = { submitted_today: 5, in_lab: 3, reported_today: 2, rejected_open: 2, new_reports: 3, open_pickups: 3, outstanding: npr(150000), outstanding_as_of: SYNCED.x };
export const EXPECTED_Y = { submitted_today: 11, in_lab: 4, reported_today: 1, rejected_open: 2, new_reports: 2, open_pickups: 5, outstanding: npr(0), outstanding_as_of: SYNCED.y };
export const EXPECTED_B = { submitted_today: 13, in_lab: 5, reported_today: 3, rejected_open: 1, new_reports: 4, open_pickups: 6, outstanding: npr(5550000), outstanding_as_of: SYNCED.b };

/** request ctx (makeCtx) + the tenant-settings seams the writer may use for "today": IdentityPort.getTenantSettings({keys}) and ctx.core.tenant(ctx) both answer `timezone`. */
export function dashCtx(w: World, who: Who, handlers: Record<string, (req: any, ctx: any) => Promise<any>>, o: Opts & { tz?: string } = {}) {
  const c = makeCtx(w, who, handlers, o);
  const tz = o.tz ?? 'Asia/Kathmandu';
  const settingsCalls: string[][] = [];
  c.ctx.ports.IdentityPort.getTenantSettings = async (_c: unknown, input: { keys?: string[] } = {}) => {
    settingsCalls.push(input.keys ?? []);
    const all: Record<string, string> = { timezone: tz, calendarDisplay: 'BS' };
    return Object.fromEntries(Object.entries(all).filter(([k]) => !input.keys || input.keys.includes(k)));
  };
  c.ctx.core = { tenant: async () => ({ displayName: 'Synthetic Lab Alpha', timezone: tz }) };
  return { ...c, settingsCalls };
}
export { LimsError };
