// C12 T-06: settings (#26/#27) + coded sets (#28/#29). 05-SCHEMA §2.1-2.4, §6; 08 A17 P-22 (lazy row), P-1 (validation -> 400); AC-05.8 (tax codes carry no rate, 08 A2.2).
// Validation here is the P-1 gate (the pipeline's schema check is not relied on); nothing is written before every field is valid. Error messages are fixed text: no submitted value is echoed (02-CV §4.6).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { parseNumberingPattern } from '../domain/numbering.js';
import { type RepoCtx, type Row, first, isUuid } from '../repository/_base.js';
import { ensureSettings, updateSettings } from '../repository/settings.repo.js';
import { getStore } from '../repository/stores.repo.js';
import { listReasons, listTaxCodes, listUom, updateReason, updateTaxCode } from '../repository/codedSets.repo.js';

export interface SvcCtx { readonly tx: RepoCtx['tx']; readonly tenantId: string; readonly actor: { readonly id: string }; readonly now?: () => string }
export interface Result { readonly status: number; readonly body: unknown; readonly version?: number }

const rc = (c: SvcCtx): RepoCtx => ({ tx: c.tx, tenantId: c.tenantId, actorId: c.actor.id });
const field = (path: string, code = 'common.field_invalid'): FieldError => ({ path, code, message: code === 'common.field_required' ? 'Field required' : code === 'common.unknown_field' ? 'Unknown field' : 'Field invalid' });
const fail = (...errs: FieldError[]): never => { throw new LimsError('common.validation_failed', undefined, errs); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const nowMs = (c: SvcCtx): number => { const t = typeof c.now === 'function' ? Date.parse(c.now()) : NaN; return Number.isFinite(t) ? t : Date.now(); };

export const REASON_GROUPS = ['wastage', 'adjustment', 'supplier_return', 'po_cancel', 'po_close', 'transfer_discrepancy', 'fact_dismiss', 'fact_reverse', 'lot_status', 'calibration', 'count_variance'] as const;
const SETS = ['uom', 'reasons', 'tax_codes'] as const;
type SetName = (typeof SETS)[number];

// ---------- settings ----------
const BOOLS = ['vat_in_cost', 'po_self_approval_allowed', 'grn_without_po_allowed', 'count_locks_store', 'per_day_requires_activity'] as const;
const INTS: ReadonlyArray<readonly [string, number, number]> = [['over_receipt_tolerance_bp', 0, 5000], ['expiry_alert_days', 1, 365], ['reconciliation_gap_alert_bp', 0, 10000], ['backdate_max_days', 0, 31]];
const PATTERNS = ['po_no_pattern', 'grn_no_pattern', 'transfer_no_pattern', 'count_no_pattern', 'doc_no_pattern'] as const;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const ALLOWED = new Set<string>([...BOOLS, ...INTS.map((i) => i[0]), ...PATTERNS, 'consumption_enabled_at', 'default_consumption_store_id']);

function patternOk(p: unknown): boolean {
  if (typeof p !== 'string' || p.length > 40) return false; // DDL settings__patterns__ck: 1..40
  try { parseNumberingPattern(p); return true; } catch { return false; }
}

/** Wire view of the settings row: NULL fields omitted (02-CV §4.2), no ids / audit columns. */
function settingsDto(r: Row): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (r['consumption_enabled_at'] != null) o['consumption_enabled_at'] = new Date(r['consumption_enabled_at']).toISOString();
  for (const k of BOOLS) o[k] = r[k];
  for (const [k] of INTS) o[k] = r[k];
  if (r['default_consumption_store_id'] != null) o['default_consumption_store_id'] = r['default_consumption_store_id'];
  for (const k of PATTERNS) o[k] = r[k];
  o['version'] = r['version'];
  return o;
}

/** #26: first call creates the default row (INSERT ... ON CONFLICT (tenant_id) DO NOTHING, P-22). */
export async function getSettings(c: SvcCtx): Promise<Result> {
  const r = await ensureSettings(rc(c));
  return { status: 200, body: settingsDto(r), version: r.version };
}

/** #27: full replace of the mutable fields; If-Match always required (428 absent, 409 stale). */
export async function putSettings(c: SvcCtx, i: { expectedVersion: number | undefined; body: unknown }): Promise<Result> {
  if (i.expectedVersion === undefined) throw new LimsError('common.precondition_required');
  const b = i.body;
  if (!isObj(b)) return fail(field('', 'common.field_invalid'));
  const errs: FieldError[] = [];
  for (const k of Object.keys(b)) if (!ALLOWED.has(k)) errs.push(field(`/${k}`, 'common.unknown_field')); // mass assignment: tenant_id / id / version / is_active never reach the row
  const req = (k: string, ok: boolean) => { if (b[k] === undefined) errs.push(field(`/${k}`, 'common.field_required')); else if (!ok) errs.push(field(`/${k}`)); };
  for (const k of BOOLS) req(k, typeof b[k] === 'boolean');
  for (const [k, lo, hi] of INTS) req(k, isInt(b[k], lo, hi));
  for (const k of PATTERNS) req(k, patternOk(b[k]));
  const at = b['consumption_enabled_at'];
  if (at !== undefined && at !== null && !(typeof at === 'string' && ISO_UTC.test(at) && Number.isFinite(Date.parse(at)))) errs.push(field('/consumption_enabled_at'));
  const store = b['default_consumption_store_id'];
  if (store !== undefined && store !== null && !isUuid(store)) errs.push(field('/default_consumption_store_id'));
  if (errs.length) return fail(...errs);

  const r = rc(c);
  const cur = await ensureSettings(r);
  // done_when: unset -> value must be >= now - 3600 s (no retroactive deduction); an unchanged value or a later change is not re-checked.
  if (typeof at === 'string' && cur.consumption_enabled_at == null && Date.parse(at) < nowMs(c) - 3_600_000) return fail(field('/consumption_enabled_at'));
  // same answer for another tenant's store and an unknown id: no existence oracle (getRow filters by tenant)
  if (typeof store === 'string' && !(await getStore(r, store))) return fail(field('/default_consumption_store_id'));

  const patch: Row = { consumption_enabled_at: at ?? null, default_consumption_store_id: store ?? null };
  for (const k of [...BOOLS, ...INTS.map((x) => x[0]), ...PATTERNS]) patch[k] = b[k];
  const row = await updateSettings(r, i.expectedVersion, patch);
  return { status: 200, body: settingsDto(row), version: row.version };
}

// ---------- coded sets ----------
const REASON_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const TAX_CODE = /^[A-Z0-9_]{1,16}$/;

function setOf(name: unknown): SetName {
  if (!SETS.includes(name as SetName)) return fail(field('/set_name'));
  return name as SetName;
}
const groupOf = (g: unknown): string | undefined => {
  if (g === undefined) return undefined;
  if (!REASON_GROUPS.includes(g as (typeof REASON_GROUPS)[number])) return fail(field('/reason_group'));
  return g as string;
};

const reasonDto = (r: Row) => ({ code: r['code'], display: r['display'], reason_group: r['reason_group'], sort_order: r['sort_order'], is_active: r['is_active'] ?? true });
const taxDto = (r: Row) => ({ code: r['code'], display: r['display'], is_active: r['is_active'] ?? true });

/** #28: global ∪ tenant, a tenant row (active or not) shadows the global row; inactive rows are not listed. */
export async function listCodedSet(c: SvcCtx, i: { setName: unknown; reasonGroup: unknown }): Promise<Result> {
  const set = setOf(i.setName);
  const group = groupOf(i.reasonGroup);
  const r = rc(c);
  if (set === 'uom') return { status: 200, body: { data: (await listUom(r)).map((u) => ({ code: u['code'], display: u['display'], uom_kind: u['uom_kind'], sort_order: u['sort_order'], is_active: u['is_active'] })) } };
  if (set === 'reasons') {
    // reason_group is optional (contract required:false): without it every group is listed; sequential, single tx client
    const groups = group === undefined ? REASON_GROUPS : [group];
    const rows: Row[] = [];
    for (const g of groups) rows.push(...(await listReasons(r, g)));
    return { status: 200, body: { data: rows.map(reasonDto) } };
  }
  // ponytail: JS code-point order, not the DB collation, so the order is the same on every database
  return { status: 200, body: { data: (await listTaxCodes(r)).map(taxDto).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)) } };
}

/** #29: create or update this tenant's row; If-Match only when the tenant row exists (absent or stale -> 409). uom is global only (404). */
export async function putTenantCode(c: SvcCtx, i: { setName: unknown; code: unknown; expectedVersion: number | undefined; body: unknown }): Promise<Result> {
  const set = setOf(i.setName);
  if (set === 'uom') throw new LimsError('common.not_found');
  const reasons = set === 'reasons';
  const b = i.body;
  const errs: FieldError[] = [];
  const code = i.code;
  if (typeof code !== 'string' || !(reasons ? REASON_CODE : TAX_CODE).test(code)) errs.push(field('/code'));
  if (!isObj(b)) return fail(...errs, field(''));
  const allowed = reasons ? ['display', 'is_active', 'sort_order', 'reason_group'] : ['display', 'is_active']; // tax codes carry no rate: rate-like fields are unknown fields (AC-05.8)
  for (const k of Object.keys(b)) if (!allowed.includes(k)) errs.push(field(`/${k}`, 'common.unknown_field'));
  const { display, is_active: active, sort_order: sort, reason_group: group } = b;
  if (display === undefined) errs.push(field('/display', 'common.field_required'));
  else if (typeof display !== 'string' || display.length < 1 || display.length > 80) errs.push(field('/display'));
  if (active === undefined) errs.push(field('/is_active', 'common.field_required'));
  else if (typeof active !== 'boolean') errs.push(field('/is_active'));
  if (sort !== undefined && !isInt(sort, 0, 9999)) errs.push(field('/sort_order'));
  if (reasons) {
    if (group === undefined) errs.push(field('/reason_group', 'common.field_required'));
    else if (!REASON_GROUPS.includes(group as (typeof REASON_GROUPS)[number])) errs.push(field('/reason_group'));
  }
  if (errs.length) return fail(...errs);

  const r = rc(c);
  const find = (): Promise<Row | null> => reasons
    ? first(r, 'SELECT * FROM inventory.cs_reasons WHERE tenant_id = $1 AND reason_group = $2 AND code = $3', [group, code])
    : first(r, 'SELECT * FROM inventory.cs_tax_codes WHERE tenant_id = $1 AND code = $2', [code]);
  const patch: Row = { display, is_active: active, ...(sort === undefined ? {} : { sort_order: sort }) };
  const update = (row: Row) => (reasons ? updateReason : updateTaxCode)(r, row['id'], i.expectedVersion!, patch);

  let row = await find();
  if (!row) {
    if (i.expectedVersion !== undefined) throw new LimsError('common.version_conflict'); // the client expected an existing row
    const cols = reasons ? ['reason_group', 'code', 'display', 'is_active', ...(sort === undefined ? [] : ['sort_order'])] : ['code', 'display', 'is_active'];
    const vals: unknown[] = reasons ? [group, code, display, active, ...(sort === undefined ? [] : [sort])] : [code, display, active];
    // ON CONFLICT DO NOTHING: two parallel first PUTs never raise a unique violation (it would abort the request transaction); the loser re-reads and answers 409
    row = await first(r, `INSERT INTO inventory.${reasons ? 'cs_reasons' : 'cs_tax_codes'} (id, tenant_id, created_by, updated_by, ${cols.join(', ')})
                          VALUES ($2, $1, $3, $3, ${cols.map((_, n) => `$${n + 4}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING *`, [uuidv7(), r.actorId, ...vals]);
    if (row) return { status: 200, body: reasons ? reasonDto(row) : taxDto(row), version: row.version };
    row = await find();
    if (!row) throw new LimsError('common.version_conflict');
  }
  if (i.expectedVersion === undefined) throw new LimsError('common.version_conflict'); // #29 declares no 428 in the contract (review item 1)
  const out = await update(row);
  return { status: 200, body: reasons ? reasonDto(out) : taxDto(out), version: out.version };
}
