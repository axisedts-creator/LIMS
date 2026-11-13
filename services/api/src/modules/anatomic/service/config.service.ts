// Configuration service — K1 settings, K2 update, K3–K5 stains, K6–K7 test profiles, K8–K10 assays, K11–K12 coded values, K20–K22 text templates (02-TRD §5.6/§5.7/§10.2).
// Every operation: IdentityPort.assertRole FIRST (reads anatomic.case.read, writes anatomic.config.manage — the privileged aal2 check lives behind it, its error is passed through) -> validate -> repo.
// Lazy tenant defaults (05-SCHEMA §2.3, 08 A17 P-22): the first settings/stain operation of a tenant creates its settings row and stain HE. No change reasons exist (D-62).
// No submitted value is echoed in an error and nothing is logged (REQ-SEC-098). The caller's transaction (requestTx) rolls back on any throw, so multi-row writes are atomic.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { bad, isObj, strict, text, UUID, uuid } from './case.service.js';
import * as cfg from '../repository/config.repo.js';
import * as coded from '../repository/codedValues.repo.js';
import * as tpl from '../repository/templates.repo.js';
import type { Row } from '../repository/_sql.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };
type Perm = 'anatomic.case.read' | 'anatomic.config.manage';
interface Ctx {
  tenantId: string; tx: any; actor: { id: string }; now: () => Date;
  ports: { IdentityPort: { assertRole(c: unknown, i: { permission: Perm }): Promise<unknown> }; CatalogPort: { getTest(c: unknown, i: { testId: string }): Promise<{ name: string; workflowType: string }> } };
}

// ---- helpers ----
const MAX = 500; // repo page ceiling
async function gate(hctx: unknown, permission: Perm): Promise<Ctx> {
  const c = hctx as Partial<Ctx> | null;
  if (typeof c?.tenantId !== 'string' || !c.tx || typeof c.actor?.id !== 'string' || !c.ports?.IdentityPort) throw new LimsError('auth.unauthenticated');
  await c.ports.IdentityPort.assertRole(c, { permission });
  return c as Ctx;
}
const put = (o: Obj, k: string, v: unknown): void => { if (v !== null && v !== undefined) o[k] = v; }; // no null on the wire
const ver = (r: Row): number => Number(r['version']);
const dup = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === '23505';
const audit = (c: Ctx) => ({ id: uuidv7(), tenant_id: c.tenantId, created_by: c.actor.id, updated_by: c.actor.id });

/** If-Match: "<version>"; "0" = create (K7/K12). Absent -> 428; malformed -> 400. */
export function ifMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"(0|[1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}
function str(v: unknown, path: string, max: number, min = 1, re?: RegExp): string {
  const s = text(v, path, max, min);
  if (re && !re.test(s)) throw bad(path);
  return s;
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(path);
  return v;
}
function flag(v: unknown, path: string): boolean { if (typeof v !== 'boolean') throw bad(path); return v; }
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T { if (typeof v !== 'string' || !allowed.includes(v as T)) throw bad(path); return v as T; }
/** query-string booleans arrive as strings */
function qflag(v: unknown, path: string): boolean {
  if (v === undefined) return false;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw bad(path);
}
const req = <T>(o: Obj, k: string, f: (v: unknown, p: string) => T, path: string): T => { if (o[k] === undefined) throw bad(`${path}/${k}`); return f(o[k], `${path}/${k}`); };
const opt = <T>(o: Obj, k: string, f: (v: unknown, p: string) => T, path: string): T | undefined => (o[k] === undefined ? undefined : f(o[k], `${path}/${k}`));

const STAIN_CODE = /^[A-Z0-9_]{1,32}$/, VALUE_CODE = /^[a-z0-9_]{1,32}$/, CODED_CODE = /^[A-Za-z0-9_.:-]{1,64}$/, SYNOPTIC_KEY = /^[a-z][a-z0-9_]{0,39}$/, SHORT_CODE = /^[a-z0-9_]{1,16}$/;
const KINDS = ['routine', 'special', 'ihc'] as const, CASE_KINDS = ['histology', 'cytology', 'ihc', 'molecular'] as const;
const SETS = ['diagnoses', 'cytology_adequacy', 'cancel_reasons'] as const;
const SECTIONS = ['gross', 'microscopy', 'impression', 'comment', 'addendum'] as const;

/** Every row of a list-style repo fn matching `pick` (pages of MAX; ponytail: linear scan, add code-keyed repo lookups if a tenant ever holds tens of thousands of rows). */
async function findAll(list: (tx: any, i: any) => Promise<Row[]>, c: Ctx, extra: Row, pick: (r: Row) => boolean): Promise<Row | undefined> {
  for (let offset = 0; ; offset += MAX) {
    const rows = await list(c.tx, { tenantId: c.tenantId, limit: MAX, offset, ...extra });
    const hit = rows.find(pick);
    if (hit || rows.length < MAX) return hit;
  }
}
/** repo INSERTs default is_active to true and take no is_active column; flip it after insert when the input asks for inactive */
async function deactivate(c: Ctx, update: (tx: any, i: any) => Promise<Row | undefined>, row: Row, isActive: boolean): Promise<Row> {
  if (isActive) return row;
  const r = await update(c.tx, { tenantId: c.tenantId, id: row['id'], expectedVersion: ver(row), actorId: c.actor.id, patch: { is_active: false } });
  if (!r) throw new LimsError('common.version_conflict');
  return r;
}
const findStain = (c: Ctx, code: string) => findAll(cfg.listStains, c, {}, (r) => r['code'] === code);

// ---- lazy defaults ----
async function ensureDefaults(c: Ctx): Promise<Row> {
  const have = await cfg.getSettings(c.tx, { tenantId: c.tenantId });
  if (have) return have;
  const made = await cfg.insertSettings(c.tx, { ...audit(c), default_routine_stain_code: 'HE' });
  if (!made) { // lost the create race: the winner commits both rows
    const row = await cfg.getSettings(c.tx, { tenantId: c.tenantId });
    if (!row) throw new LimsError('common.internal');
    return row;
  }
  if (!(await findStain(c, 'HE'))) await cfg.insertStain(c.tx, { ...audit(c), code: 'HE', display: 'Haematoxylin and eosin', kind: 'routine', sort_order: 0 });
  return made;
}

// ---- DTOs ----
const settingsDto = (r: Row): Obj => ({
  auto_accession_on_receipt: r['auto_accession_on_receipt'], require_gross_complete_for_processing: r['require_gross_complete_for_processing'],
  default_routine_stain_code: r['default_routine_stain_code'], max_images_per_case: r['max_images_per_case'], max_report_images: r['max_report_images'], version: ver(r),
});
const stainDto = (r: Row): Obj => {
  const o: Obj = { id: r['id'], code: r['code'], display: r['display'], kind: r['kind'], sort_order: r['sort_order'], is_active: r['is_active'], version: ver(r) };
  put(o, 'addon_test_id', r['addon_test_id']); return o;
};
const codedDto = (r: Row): Obj => {
  const o: Obj = { code: r['code'], display: r['display'], system: r['system'] ?? 'local', sort_order: r['sort_order'], is_active: r['is_active'], version: ver(r) };
  put(o, 'system_version', r['system_version']); return o;
};
const templateDto = (r: Row): Obj => ({ id: r['id'], short_code: r['short_code'], section: r['section'], title: r['title'], body: r['body'], is_active: r['is_active'], version: ver(r) });

// ---- K1 / K2 settings ----
export async function getSettings(hctx: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  return { status: 200, body: settingsDto(await ensureDefaults(c)) };
}
export async function updateSettings(hctx: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const version = ifMatch(headers);
  const b = strict(body, ['auto_accession_on_receipt', 'require_gross_complete_for_processing', 'default_routine_stain_code', 'max_images_per_case', 'max_report_images']);
  const patch: Row = {
    auto_accession_on_receipt: req(b, 'auto_accession_on_receipt', flag, ''), require_gross_complete_for_processing: req(b, 'require_gross_complete_for_processing', flag, ''),
    default_routine_stain_code: req(b, 'default_routine_stain_code', (v, p) => str(v, p, 32, 1, STAIN_CODE), ''),
    max_images_per_case: req(b, 'max_images_per_case', (v, p) => int(v, p, 1, 200), ''), max_report_images: req(b, 'max_report_images', (v, p) => int(v, p, 0, 24), ''),
  };
  const cur = await ensureDefaults(c);
  const stain = await findStain(c, patch['default_routine_stain_code'] as string);
  if (!stain || !stain['is_active'] || stain['kind'] !== 'routine') throw bad('/default_routine_stain_code'); // §10.2: an active routine stain
  const updated = await cfg.updateSettings(c.tx, { tenantId: c.tenantId, id: cur['id'], expectedVersion: version, actorId: c.actor.id, patch });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: settingsDto(updated) };
}

// ---- K3–K5 stains ----
export async function listStains(hctx: unknown, query: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  const q = strict(query ?? {}, ['kind', 'include_inactive']);
  const kind = opt(q, 'kind', (v, p) => oneOf(v, p, KINDS), '');
  const all = qflag(q['include_inactive'], '/include_inactive');
  await ensureDefaults(c);
  const rows = await cfg.listStains(c.tx, { tenantId: c.tenantId, activeOnly: !all, limit: MAX });
  return { status: 200, body: { data: rows.filter((r) => !kind || r['kind'] === kind).map(stainDto) } };
}
export async function createStain(hctx: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const b = strict(body, ['code', 'display', 'kind', 'sort_order', 'addon_test_id']);
  const row: Row = {
    code: req(b, 'code', (v, p) => str(v, p, 32, 1, STAIN_CODE), ''), display: req(b, 'display', (v, p) => str(v, p, 120), ''), kind: req(b, 'kind', (v, p) => oneOf(v, p, KINDS), ''),
    sort_order: req(b, 'sort_order', (v, p) => int(v, p, 0, 9999), ''), addon_test_id: opt(b, 'addon_test_id', uuid, ''),
  };
  await ensureDefaults(c);
  try { return { status: 201, body: stainDto(await cfg.insertStain(c.tx, { ...audit(c), ...row })) }; } catch (e) { throw dup(e) ? bad('/code') : e; }
}
export async function updateStain(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const version = ifMatch(headers);
  const id = isObj(params) && typeof params['stain_id'] === 'string' && UUID.test(params['stain_id']) ? params['stain_id'] : undefined;
  const b = strict(body, ['display', 'kind', 'sort_order', 'is_active', 'addon_test_id']); // code is immutable
  const patch: Row = {
    display: req(b, 'display', (v, p) => str(v, p, 120), ''), kind: req(b, 'kind', (v, p) => oneOf(v, p, KINDS), ''), sort_order: req(b, 'sort_order', (v, p) => int(v, p, 0, 9999), ''),
    is_active: req(b, 'is_active', flag, ''), addon_test_id: opt(b, 'addon_test_id', uuid, '') ?? null, // PUT: omitted = cleared
  };
  const settings = await ensureDefaults(c);
  const cur = id ? await cfg.getStain(c.tx, { tenantId: c.tenantId, id }) : undefined;
  if (!cur) throw new LimsError('common.not_found');
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  if (cur['code'] === settings['default_routine_stain_code'] && (!patch['is_active'] || patch['kind'] !== 'routine')) { // AC-14.2
    throw new LimsError('common.validation_failed', 'Choose another default routine stain first',
      [{ path: patch['is_active'] ? '/kind' : '/is_active', code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
  }
  const updated = await cfg.updateStain(c.tx, { tenantId: c.tenantId, id: cur['id'], expectedVersion: version, actorId: c.actor.id, patch });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: stainDto(updated) };
}

// ---- K6–K7 test profiles ----
const profileDto = (r: Row, name: string): Obj => {
  const o: Obj = { test_id: r['test_id'], test_name: name, case_kind: r['case_kind'], is_addon: r['is_addon'], requires_gross: r['requires_gross'], default_synoptic_template_keys: r['default_synoptic_template_keys'] ?? [], is_active: r['is_active'], version: ver(r) };
  put(o, 'default_stain_code', r['default_stain_code']); return o;
};
export async function listTestProfiles(hctx: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  const rows = await cfg.listTestProfiles(c.tx, { tenantId: c.tenantId, limit: MAX });
  const data: Obj[] = [];
  for (const r of rows) data.push(profileDto(r, (await c.ports.CatalogPort.getTest(c, { testId: r['test_id'] })).name)); // port errors pass through unchanged (08 P-23)
  return { status: 200, body: { data } };
}
export async function upsertTestProfile(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const testId = uuid(isObj(params) ? params['test_id'] : undefined, '/test_id');
  const version = ifMatch(headers);
  const b = strict(body, ['case_kind', 'is_addon', 'requires_gross', 'default_stain_code', 'default_synoptic_template_keys', 'is_active']);
  const keys = opt(b, 'default_synoptic_template_keys', (v, p) => {
    if (!Array.isArray(v) || v.length > 5) throw bad(p);
    return v.map((k, n) => str(k, `${p}/${n}`, 40, 1, SYNOPTIC_KEY));
  }, '') ?? [];
  const fields: Row = {
    case_kind: req(b, 'case_kind', (v, p) => oneOf(v, p, CASE_KINDS), ''), is_addon: req(b, 'is_addon', flag, ''), requires_gross: req(b, 'requires_gross', flag, ''),
    default_stain_code: opt(b, 'default_stain_code', (v, p) => str(v, p, 32, 1, STAIN_CODE), '') ?? null, default_synoptic_template_keys: keys, is_active: req(b, 'is_active', flag, ''),
  };
  const test = await c.ports.CatalogPort.getTest(c, { testId });
  if (test.workflowType !== 'anatomic' && test.workflowType !== 'molecular') throw bad('/test_id');
  const cur = await findAll(cfg.listTestProfiles, c, {}, (r) => r['test_id'] === testId);
  if (version === 0) {
    if (cur) throw new LimsError('common.version_conflict');
    let row: Row;
    try { row = await cfg.insertTestProfile(c.tx, { ...audit(c), test_id: testId, ...fields }); } catch (e) { throw dup(e) ? new LimsError('common.version_conflict') : e; }
    row = await deactivate(c, cfg.updateTestProfile, row, fields['is_active'] as boolean);
    return { status: 201, body: profileDto(row, test.name) };
  }
  if (!cur) throw new LimsError('common.not_found');
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  const updated = await cfg.updateTestProfile(c.tx, { tenantId: c.tenantId, id: cur['id'], expectedVersion: version, actorId: c.actor.id, patch: fields });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: profileDto(updated, test.name) };
}

// ---- K8–K10 assays ----
const targetDto = (t: Row, values: Row[]): Obj => {
  const o: Obj = { id: t['id'], code: t['code'], display: t['display'], allows_quantitative: t['allows_quantitative'], sort_order: t['sort_order'], is_active: t['is_active'] };
  put(o, 'unit_code', t['unit_code']); put(o, 'decimals', t['decimals']);
  o['result_values'] = values.map((v) => ({ code: v['code'], display: v['display'], is_abnormal: v['is_abnormal'], sort_order: v['sort_order'], is_active: v['is_active'] }));
  return o;
};
/** ponytail: 1 + targets queries per assay; the config screen reads a handful of assays. Batch the child reads if a tenant ever holds hundreds. */
async function assayDto(c: Ctx, a: Row, activeOnly: boolean): Promise<Obj> {
  const targets: Obj[] = [];
  for (const t of await cfg.listAssayTargets(c.tx, { tenantId: c.tenantId, assayId: a['id'], activeOnly })) {
    targets.push(targetDto(t, await cfg.listAssayTargetValues(c.tx, { tenantId: c.tenantId, targetId: t['id'], activeOnly })));
  }
  const o: Obj = { id: a['id'], code: a['code'], display: a['display'], is_active: a['is_active'], targets, version: ver(a) };
  put(o, 'method_text_default', a['method_text_default']); return o;
}
interface TargetIn { code: string; display: string; allows_quantitative: boolean; unit_code?: string; decimals?: number; sort_order: number; is_active: boolean; values: ValueIn[] }
interface ValueIn { code: string; display: string; is_abnormal: boolean; sort_order: number; is_active: boolean }
function parseAssay(body: unknown): { code: string; display: string; method?: string; is_active: boolean; targets: TargetIn[] } {
  const b = strict(body, ['code', 'display', 'method_text_default', 'is_active', 'targets']);
  const code = req(b, 'code', (v, p) => str(v, p, 32, 1, STAIN_CODE), ''), display = req(b, 'display', (v, p) => str(v, p, 120), '');
  const method = opt(b, 'method_text_default', (v, p) => text(v, p, 200), ''), is_active = req(b, 'is_active', flag, '');
  const raw = b['targets'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) throw bad('/targets');
  const seen = new Set<string>();
  const targets = raw.map((tr, n): TargetIn => {
    const p = `/targets/${n}`, t = strict(tr, ['code', 'display', 'allows_quantitative', 'unit_code', 'decimals', 'sort_order', 'is_active', 'result_values'], p);
    const tcode = req(t, 'code', (v, q) => str(v, q, 32, 1, STAIN_CODE), p);
    if (seen.has(tcode)) throw bad(`${p}/code`);
    seen.add(tcode);
    const rv = t['result_values'];
    if (!Array.isArray(rv) || rv.length < 1 || rv.length > 20) throw bad(`${p}/result_values`);
    const vseen = new Set<string>();
    const values = rv.map((vr, k): ValueIn => {
      const vp = `${p}/result_values/${k}`, v = strict(vr, ['code', 'display', 'is_abnormal', 'sort_order', 'is_active'], vp);
      const vcode = req(v, 'code', (x, q) => str(x, q, 32, 1, VALUE_CODE), vp);
      if (vseen.has(vcode)) throw bad(`${vp}/code`);
      vseen.add(vcode);
      return { code: vcode, display: req(v, 'display', (x, q) => str(x, q, 120), vp), is_abnormal: req(v, 'is_abnormal', flag, vp), sort_order: req(v, 'sort_order', (x, q) => int(x, q, 0, 9999), vp), is_active: req(v, 'is_active', flag, vp) };
    });
    const out: TargetIn = { code: tcode, display: req(t, 'display', (x, q) => str(x, q, 120), p), allows_quantitative: req(t, 'allows_quantitative', flag, p), sort_order: req(t, 'sort_order', (x, q) => int(x, q, 0, 9999), p), is_active: req(t, 'is_active', flag, p), values };
    const unit = opt(t, 'unit_code', (x, q) => text(x, q, 32), p), dec = opt(t, 'decimals', (x, q) => int(x, q, 0, 6), p);
    if (unit !== undefined) out.unit_code = unit;
    if (dec !== undefined) out.decimals = dec;
    return out;
  });
  const out: ReturnType<typeof parseAssay> = { code, display, is_active, targets };
  if (method !== undefined) out.method = method;
  return out;
}
const targetFields = (t: TargetIn): Row => ({ display: t.display, allows_quantitative: t.allows_quantitative, unit_code: t.unit_code ?? null, decimals: t.decimals ?? null, sort_order: t.sort_order, is_active: t.is_active });
const valueFields = (v: ValueIn): Row => ({ display: v.display, is_abnormal: v.is_abnormal, sort_order: v.sort_order, is_active: v.is_active });
const insertTarget = async (c: Ctx, assayId: unknown, t: TargetIn): Promise<Row> =>
  deactivate(c, cfg.updateAssayTarget, await cfg.insertAssayTarget(c.tx, { ...audit(c), assay_id: assayId, code: t.code, ...targetFields(t) }), t.is_active);
const insertValue = async (c: Ctx, targetId: unknown, v: ValueIn): Promise<Row> =>
  deactivate(c, cfg.updateAssayTargetValue, await cfg.insertAssayTargetValue(c.tx, { ...audit(c), target_id: targetId, code: v.code, ...valueFields(v) }), v.is_active);
/** patch only when something differs, so untouched rows keep their version */
const changed = (cur: Row, next: Row): Row | undefined => (Object.entries(next).some(([k, v]) => (cur[k] ?? null) !== v) ? next : undefined);

export async function listAssays(hctx: unknown, query: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  const q = strict(query ?? {}, ['include_inactive']);
  const all = qflag(q['include_inactive'], '/include_inactive');
  const data: Obj[] = [];
  for (const a of await cfg.listAssays(c.tx, { tenantId: c.tenantId, activeOnly: !all, limit: MAX })) data.push(await assayDto(c, a, !all));
  return { status: 200, body: { data } };
}
export async function createAssay(hctx: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const a = parseAssay(body);
  let row: Row;
  try { row = await cfg.insertAssay(c.tx, { ...audit(c), code: a.code, display: a.display, method_text_default: a.method ?? null }); } catch (e) { throw dup(e) ? bad('/code') : e; }
  row = await deactivate(c, cfg.updateAssay, row, a.is_active);
  for (const t of a.targets) {
    const tr = await insertTarget(c, row['id'], t);
    for (const v of t.values) await insertValue(c, tr['id'], v);
  }
  return { status: 201, body: await assayDto(c, row, false) };
}
export async function updateAssay(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const version = ifMatch(headers);
  const id = isObj(params) && typeof params['assay_id'] === 'string' && UUID.test(params['assay_id']) ? params['assay_id'] : undefined;
  const a = parseAssay(body);
  const cur = id ? await cfg.getAssay(c.tx, { tenantId: c.tenantId, id }) : undefined;
  if (!cur) throw new LimsError('common.not_found');
  if (a.code !== cur['code']) throw bad('/code'); // immutable
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  const existing = await cfg.listAssayTargets(c.tx, { tenantId: c.tenantId, assayId: cur['id'] });
  const plan: { t: TargetIn; row: Row | undefined; values: Map<string, Row> }[] = [];
  for (const t of a.targets) plan.push({ t, row: existing.find((r) => r['code'] === t.code), values: new Map() });
  for (const row of existing) { // never removed: every stored target and value must be in the input
    const p = plan.find((x) => x.row?.['id'] === row['id']);
    if (!p) throw bad('/targets');
    for (const v of await cfg.listAssayTargetValues(c.tx, { tenantId: c.tenantId, targetId: row['id'] })) {
      if (!p.t.values.some((x) => x.code === v['code'])) throw bad('/targets');
      p.values.set(v['code'], v);
    }
  }
  const updated = await cfg.updateAssay(c.tx, {
    tenantId: c.tenantId, id: cur['id'], expectedVersion: version, actorId: c.actor.id, patch: { display: a.display, method_text_default: a.method ?? null, is_active: a.is_active },
  });
  if (!updated) throw new LimsError('common.version_conflict');
  for (const { t, row, values } of plan) {
    let tr = row;
    if (!tr) tr = await insertTarget(c, cur['id'], t);
    else {
      const patch = changed(tr, targetFields(t));
      if (patch && !(await cfg.updateAssayTarget(c.tx, { tenantId: c.tenantId, id: tr['id'], expectedVersion: ver(tr), actorId: c.actor.id, patch }))) throw new LimsError('common.version_conflict');
    }
    for (const v of t.values) {
      const vr = values.get(v.code);
      if (!vr) await insertValue(c, tr['id'], v);
      else {
        const patch = changed(vr, valueFields(v));
        if (patch && !(await cfg.updateAssayTargetValue(c.tx, { tenantId: c.tenantId, id: vr['id'], expectedVersion: ver(vr), actorId: c.actor.id, patch }))) throw new LimsError('common.version_conflict');
      }
    }
  }
  return { status: 200, body: await assayDto(c, updated, false) };
}

// ---- K11–K12 coded values (set_name: diagnoses | cytology_adequacy | cancel_reasons — no change reasons, D-62) ----
// resolved at call time (not import time) so importing this module never touches coded.* exports a partial repo mock may omit
const setRepo = () => ({
  diagnoses: { list: coded.listCodedDiagnoses, insert: coded.insertCodedDiagnosis, update: coded.updateCodedDiagnosis },
  cytology_adequacy: { list: coded.listCodedCytologyAdequacies, insert: coded.insertCodedCytologyAdequacy, update: coded.updateCodedCytologyAdequacy },
  cancel_reasons: { list: coded.listCodedCancelReasons, insert: coded.insertCodedCancelReason, update: coded.updateCodedCancelReason },
} as const);
const setName = (params: unknown): (typeof SETS)[number] => oneOf(isObj(params) ? params['set_name'] : undefined, '/set_name', SETS);
export const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
export function decodeCursor(v: unknown): number {
  try {
    const o = (JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8')) as { o?: unknown } | null)?.o;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0 && o <= 1_000_000) return o;
  } catch { /* fall through */ }
  throw new LimsError('common.invalid_cursor');
}

export async function listCodedValues(hctx: unknown, params: unknown, query: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  const set = setName(params);
  const q = strict(query ?? {}, ['include_inactive', 'q', 'limit', 'cursor']);
  const all = qflag(q['include_inactive'], '/include_inactive');
  const needle = opt(q, 'q', (v, p) => text(v, p, 60), '') ?? '';
  let limit = 50;
  if (q['limit'] !== undefined) {
    const raw = q['limit'], n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
    limit = n;
  }
  const offset = q['cursor'] === undefined ? 0 : decodeCursor(q['cursor']);
  let rows: Row[];
  if (set === 'cancel_reasons') {
    // tenant rows shadow platform rows of the same code (05-SCHEMA §1), also when the tenant row is inactive
    const mine = await findAllRows(coded.listCodedCancelReasons, c);
    const shadow = new Set(mine.map((r) => r['code']));
    const lower = needle.toLowerCase();
    rows = [...mine, ...(await coded.listGlobalCancelReasons(c.tx)).filter((g) => !shadow.has(g['code']))]
      .filter((r) => (all || r['is_active']) && (!lower || String(r['display']).toLowerCase().includes(lower)))
      .sort((x, y) => Number(x['sort_order']) - Number(y['sort_order']) || (x['code'] < y['code'] ? -1 : x['code'] > y['code'] ? 1 : 0))
      .slice(offset, offset + limit + 1);
  } else rows = await setRepo()[set].list(c.tx, { tenantId: c.tenantId, activeOnly: !all, q: needle, limit: limit + 1, offset });
  const more = rows.length > limit;
  return { status: 200, body: { data: rows.slice(0, limit).map(codedDto), page: { limit, ...(more ? { next_cursor: encodeCursor(offset + limit) } : {}) } } };
}
async function findAllRows(list: (tx: any, i: any) => Promise<Row[]>, c: Ctx, extra: Row = {}): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += MAX) {
    const rows = await list(c.tx, { tenantId: c.tenantId, limit: MAX, offset, ...extra });
    out.push(...rows);
    if (rows.length < MAX) return out;
  }
}
export async function upsertCodedValue(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const set = setName(params);
  const code = str(isObj(params) ? params['code'] : undefined, '/code', 64, 1, CODED_CODE);
  const version = ifMatch(headers);
  const b = strict(body, ['display', 'system', 'system_version', 'sort_order', 'is_active']);
  const fields: Row = {
    display: req(b, 'display', (v, p) => str(v, p, 300), ''), system: opt(b, 'system', (v, p) => str(v, p, 32), ''), system_version: opt(b, 'system_version', (v, p) => str(v, p, 32), ''),
    sort_order: req(b, 'sort_order', (v, p) => int(v, p, 0, 9999), ''), is_active: req(b, 'is_active', flag, ''),
  };
  const r = setRepo()[set];
  const cur = await findAll(r.list, c, {}, (x) => x['code'] === code);
  if (version === 0) {
    if (cur) throw new LimsError('common.version_conflict');
    let row: Row;
    try { row = await r.insert(c.tx, { ...audit(c), code, ...fields }); } catch (e) { throw dup(e) ? new LimsError('common.version_conflict') : e; }
    return { status: 201, body: codedDto(await deactivate(c, r.update, row, fields['is_active'] as boolean)) };
  }
  if (!cur) throw new LimsError('common.not_found');
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  const updated = await r.update(c.tx, { tenantId: c.tenantId, id: cur['id'], expectedVersion: version, actorId: c.actor.id, patch: fields });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: codedDto(updated) };
}

// ---- K20–K22 text templates ----
export async function listTextTemplates(hctx: unknown, query: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  const q = strict(query ?? {}, ['section', 'include_inactive']);
  const section = opt(q, 'section', (v, p) => oneOf(v, p, SECTIONS), '');
  const all = qflag(q['include_inactive'], '/include_inactive');
  // 02-TRD §5.6 K20: up to 1000 templates; filter by section before the cap so no section loses rows
  const rows = (await findAllRows(tpl.listTextTemplates, c, { activeOnly: !all })).filter((r) => !section || r['section'] === section);
  return { status: 200, body: { data: rows.slice(0, 1000).map(templateDto) } };
}
export async function createTextTemplate(hctx: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const b = strict(body, ['short_code', 'section', 'title', 'body']);
  const row: Row = {
    short_code: req(b, 'short_code', (v, p) => str(v, p, 16, 1, SHORT_CODE), ''), section: req(b, 'section', (v, p) => oneOf(v, p, SECTIONS), ''),
    title: req(b, 'title', (v, p) => str(v, p, 120), ''), body: req(b, 'body', (v, p) => str(v, p, 8000), ''),
  };
  try { return { status: 201, body: templateDto(await tpl.insertTextTemplate(c.tx, { ...audit(c), ...row })) }; } catch (e) { throw dup(e) ? bad('/short_code') : e; }
}
export async function updateTextTemplate(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const version = ifMatch(headers);
  const id = isObj(params) && typeof params['text_template_id'] === 'string' && UUID.test(params['text_template_id']) ? params['text_template_id'] : undefined;
  const b = strict(body, ['title', 'body', 'is_active']); // short_code and section are immutable
  const patch: Row = { title: req(b, 'title', (v, p) => str(v, p, 120), ''), body: req(b, 'body', (v, p) => str(v, p, 8000), ''), is_active: req(b, 'is_active', flag, '') };
  const cur = id ? await tpl.getTextTemplate(c.tx, { tenantId: c.tenantId, id }) : undefined;
  if (!cur) throw new LimsError('common.not_found');
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  const updated = await tpl.updateTextTemplate(c.tx, { tenantId: c.tenantId, id: cur['id'], expectedVersion: version, actorId: c.actor.id, patch });
  if (!updated) throw new LimsError('common.version_conflict');
  return { status: 200, body: templateDto(updated) };
}
