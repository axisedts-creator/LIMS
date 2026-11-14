// C12.T-09 test helpers (not a test file). Synthetic data only. Operations #30-#39: lots, stock balances, movements, FEFO suggestion, opened containers (#40 discard belongs to T-10).
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention and gate order as T-08 (masters.helpers.ts):
//   * `handlers[operationId](req, ctx)`; success => { status, body }; failure => the handler THROWS a LimsError. Header keys lower-case; If-Match = `"<version>"`. Query values arrive already typed.
//   * GATE ORDER. Tenant scope (#30-#33) and #34 / #35 WITHOUT `store_id` (visible branches): `IdentityPort.assertRole(ctx, { permission })` with NO branchId is the FIRST thing, before any tx statement
//     and before body / query validation. Store scope (#34 / #35 with store_id, #36-#39; #39 through the container's store): request validation (400 / 428) first, tx untouched; then load the store
//     (or the container, then its store) via RLS -> unknown or branch not visible => 404 common.not_found -> assertRole({ permission, branchId }) => 403 (P-B8: 404 beats 403).
//   * TENANT TIME. The tenant timezone is read through `ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone'] })` => `{ timezone: 'Asia/Kathmandu' }` (02-TRD §4.7 / §5 preamble). "Today", lot expiry
//     ("expiry_on < today" = expired), the end of the expiry day and `opened_at + open_stability_days` (wall-clock days) are all computed in that zone. The clock is `ctx.now()` (ISO string), never `new Date()`.
//   * END OF DAY. "End of the expiry day" = the last instant of that local calendar day. The tests accept any instant in the last second of the day (23:59:59.000 .. 23:59:59.999 local), because the spec
//     does not fix the millisecond (domain/fefo.ts uses start-of-next-day minus 1 ms).
//   * Money (PE-3): `value_paisa`, `avg_unit_cost_paisa_x1e6`, `last_receipt_unit_cost_paisa_x1e6`, `value_basis` are present only when getActor().permissions includes `inventory.cost.read`.
//   * IN-USE LOT (AC-07.2) is observable through #37: with `instrument_id` the list is ordered newest opened_at first (`-opened_at`), so `data[0]` is the in-use container.
//   * PRIVILEGED (PE-1): #32 / #33 call assertRole({ permission: 'inventory.stock.adjust' }); at aal1 the port rejects with `auth.mfa_required` (403) and the handler lets it through untouched.
import { LimsError } from '../../../../core/errors.js';
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, makeCtx, onlyKeys, rej, uid, type Opts, type Req, type Tx } from './masters.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid };
export type { Req, Tx };
export const READ = 'inventory.item.read';
export const BENCH = 'inventory.bench.record';
export const ADJUST = 'inventory.stock.adjust';
export const COST = 'inventory.cost.read';

/** operationId -> permission the handler must assert (02-TRD §5.2). */
export const PERMISSION: Record<string, string> = {
  listInventoryLots: READ, getInventoryLot: READ, setInventoryLotStatus: ADJUST, correctInventoryLotExpiry: ADJUST, listStockBalances: READ, listStockMovements: READ,
  getFefoSuggestion: READ, listOpenedContainers: READ, openContainer: BENCH, finishContainer: BENCH,
};

export interface LotOpts extends Opts { tz?: string; now?: string; aal?: 'aal1' | 'aal2' }
export interface LotStub { ctx: any; roleCalls: any[]; settingsCalls: any[] }

/** makeCtx plus: tenant timezone through getTenantSettings, a frozen clock (ctx.now) and an MFA level (aal1 refuses the privileged permission with auth.mfa_required). */
export function makeLotCtx(tx: Tx, tenantId: string, o: LotOpts = {}): LotStub {
  const permissions = o.permissions ?? [READ, BENCH];
  const st = makeCtx(tx, tenantId, { ...o, permissions });
  const port = st.ctx.ports.IdentityPort;
  const settingsCalls: any[] = [];
  const roleCalls = st.roleCalls;
  const base = port.assertRole.bind(port);
  port.assertRole = async (c: unknown, req: { permission: string; branchId?: string }) => {
    await base(c, req); // records the request, rejects a missing permission with auth.forbidden
    if (req.permission === ADJUST && (o.aal ?? 'aal2') === 'aal1') throw new LimsError('auth.mfa_required');
  };
  port.getTenantSettings = async (_c: unknown, req: { keys: string[] }) => { settingsCalls.push(req); return { timezone: o.tz ?? 'Asia/Kathmandu' }; };
  if (o.now) st.ctx.now = () => o.now as string;
  return { ctx: st.ctx, roleCalls, settingsCalls };
}

// ------------------------------------------------------------------ time helpers (tenant time)
/** YYYY-MM-DD of instant `d` in `tz`. */
export const ymdIn = (tz: string, d: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const addDays = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Local wall-clock parts of `iso` in `tz`. */
export function wall(iso: string, tz: string): { ymd: string; hms: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value])) as Record<string, string>;
  return { ymd: `${p['year']}-${p['month']}-${p['day']}`, hms: `${p['hour']}:${p['minute']}:${p['second']}` };
}
/** True when `iso` lies in the last second of local day `ymd` in `tz` (23:59:59.000 .. 23:59:59.999). */
export function isEndOfDay(iso: string, ymd: string, tz: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const w = wall(iso, tz);
  return w.ymd === ymd && w.hms === '23:59:59';
}

// ------------------------------------------------------------------ decimals
export const DECIMAL = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;
/** Numeric value of a DecimalString (tolerates "30", "30.0", "30.000000"); also asserts the wire pattern. */
export function qty(s: unknown): number {
  if (typeof s !== 'string' || !DECIMAL.test(s)) throw new Error(`not a DecimalString: ${JSON.stringify(s)}`);
  return Number(s);
}

// ------------------------------------------------------------------ contract shapes (inventory.yaml components; no tenant / audit columns ever)
export const LOT_KEYS = ['id', 'item_id', 'lot_no', 'expiry_on', 'manufactured_on', 'status', 'status_reason_code', 'version', 'last_receipt_unit_cost_paisa_x1e6', 'balances'];
export const BALANCE_KEYS = ['store_id', 'item_id', 'item_code', 'item_name', 'lot_id', 'lot_no', 'expiry_on', 'lot_status', 'qty_base', 'available_qty_base', 'has_open_container', 'reorder_level_base', 'value_paisa', 'avg_unit_cost_paisa_x1e6'];
export const MOVEMENT_KEYS = ['id', 'occurred_at', 'business_date', 'store_id', 'item_id', 'lot_id', 'lot_no', 'movement_kind', 'qty_base', 'balance_qty_after', 'value_paisa', 'value_basis', 'doc_type', 'doc_id', 'doc_no',
  'instrument_id', 'attributed_test_id', 'rule_id', 'reason_code', 'created_by_display'];
export const FEFO_KEYS = ['store_id', 'item_id', 'qty_base', 'lines', 'shortfall_qty_base'];
export const FEFO_LINE_KEYS = ['lot_id', 'lot_no', 'expiry_on', 'effective_expiry_at', 'has_open_container', 'take_qty_base', 'available_qty_base'];
export const CONTAINER_KEYS = ['id', 'store_id', 'item_id', 'lot_id', 'lot_no', 'instrument_id', 'opened_at', 'open_expiry_at', 'status', 'finished_at', 'discard_document_id', 'notes', 'version'];
/** Money fields that must vanish without inventory.cost.read (02-TRD §6.3: every `_paisa` / `_paisa_x1e6` property and value_basis). */
export const COST_FIELD = /_paisa(_x1e6)?$|^value_basis$/;
export const costKeys = (o: object): string[] => Object.keys(o).filter((k) => COST_FIELD.test(k));

export const reason = (over: Record<string, unknown> = {}) => ({ reason_code: 'syn_quarantine', ...over });
export const setStatus = (over: Record<string, unknown> = {}) => ({ status: 'quarantined', ...reason(), ...over });
export const correctExpiry = (over: Record<string, unknown> = {}) => ({ expiry_on: '2027-06-30', reason_code: 'syn_expiry_fix', ...over });
export const newContainer = (store: string, item: string, over: Record<string, unknown> = {}) => ({ store_id: store, item_id: item, ...over });
