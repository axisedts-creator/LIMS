// M23–M28, M39, M40 (02-TRD §5.4; PRD AC-14.1–14.5). Tenant and actor come from ctx only. Bodies are the OpenAPI snake_case shapes and are
// re-validated here (the core validates the same schema first; the service must not depend on it). Error details are fixed text: no submitted value is echoed.
// [CONV] atomicity = the request transaction: every refusal throws before or instead of a partial write, so the core rolls the whole request back.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import * as sets from '../repository/codedsets.repo.js';
import * as cfg from '../repository/config.repo.js';
import { codeDto, defaultSettingsDto, protocolDto, settingsDto } from '../mappers/config.mappers.js';

export interface ConfigCtx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly tx: unknown }
type Row = Record<string, any>;
type Obj = Record<string, unknown>;

const CODE = /^[a-z0-9_]{2,64}$/;
const SNOMED = /^[0-9]{6,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path: string, message = 'Field invalid', code = 'common.field_invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const str = (v: unknown, p: string, min: number, max: number): string => (typeof v === 'string' && v.length >= min && v.length <= max ? v : fail(p));
const int = (v: unknown, p: string, min: number, max: number): number => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fail(p));
const bool = (v: unknown, p: string): boolean => (typeof v === 'boolean' ? v : fail(p));
const code = (v: unknown, p: string): string => (typeof v === 'string' && CODE.test(v) ? v : fail(p));
/** Query booleans arrive parsed (boolean) from the core or as the literal strings. */
const flag = (v: unknown, p: string): boolean | undefined => (v === undefined ? undefined : v === true || v === 'true' ? true : v === false || v === 'false' ? false : fail(p));
function strict(o: Obj, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`/${k.slice(0, 64)}`, 'Unknown field', 'common.unknown_field');
}
function scope(ctx: ConfigCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}
/** If-Match as the handler parsed it: undefined = header absent (428), 0 = malformed (400). */
function needVersion(v: number | undefined): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  return v >= 1 ? v : fail('/If-Match');
}
const pgState = (e: unknown): string | undefined => { const x = e as { code?: unknown; sqlState?: unknown } | null; return typeof x?.code === 'string' ? x.code : typeof x?.sqlState === 'string' ? x.sqlState : undefined; };
const conflict = (): never => { throw new LimsError('common.version_conflict'); };

// ====================================================================== settings (M39 / M40)
const SETTINGS_KEYS = ['manual_ast_standard', 'zone_suggestion_enabled', 'mic_suggestion_enabled', 'default_final_no_growth_hours', 'early_final_requires_reason', 'recent_window_days', 'unset'];

export async function getSettings(ctx: ConfigCtx): Promise<Obj> {
  const { tx, tenantId } = scope(ctx);
  const row = await cfg.getSettings(tx, { tenantId });
  return row ? settingsDto(row) : defaultSettingsDto();
}

export async function updateSettings(ctx: ConfigCtx, input: { ifMatch: number | undefined; body: unknown }): Promise<Obj> {
  const { tx, tenantId, userId } = scope(ctx);
  const b = isObj(input.body) ? input.body : fail('/');
  strict(b, SETTINGS_KEYS);
  const need = (k: string): unknown => (b[k] === undefined ? fail(`/${k}`, 'Field required', 'common.field_required') : b[k]);
  const values = {
    zone_suggestion_enabled: bool(need('zone_suggestion_enabled'), '/zone_suggestion_enabled'),
    mic_suggestion_enabled: bool(need('mic_suggestion_enabled'), '/mic_suggestion_enabled'),
    default_final_no_growth_hours: int(need('default_final_no_growth_hours'), '/default_final_no_growth_hours', 1, 720),
    early_final_requires_reason: bool(need('early_final_requires_reason'), '/early_final_requires_reason'),
    recent_window_days: int(need('recent_window_days'), '/recent_window_days', 1, 31),
  };
  let standard: string | null | undefined;
  if (b['manual_ast_standard'] !== undefined) standard = b['manual_ast_standard'] === 'CLSI' || b['manual_ast_standard'] === 'EUCAST' ? b['manual_ast_standard'] : fail('/manual_ast_standard');
  if (b['unset'] !== undefined) {
    const unset = b['unset'];
    if (!Array.isArray(unset) || unset.length > 1 || unset.some((u) => u !== 'manual_ast_standard')) return fail('/unset');
    if (unset.length === 1) { if (standard !== undefined) fail('/unset'); standard = null; }
  }
  const expectedVersion = needVersion(input.ifMatch);

  const current = await cfg.getSettings(tx, { tenantId });
  if (!current) {
    // No row yet = defaults at version 1: only If-Match "1" may create it. P-22: the insert loses a race without error -> 409.
    if (expectedVersion !== 1) return conflict();
    const row = await cfg.insertSettings(tx, { tenantId, userId, id: uuidv7(), values: { ...values, manual_ast_standard: standard ?? null } });
    return row ? settingsDto(row) : conflict();
  }
  const row = await cfg.updateSettings(tx, { tenantId, userId, expectedVersion, standard, values });
  return row ? settingsDto(row) : conflict();
}

// ====================================================================== coded sets (M23 / M24)
function setName(v: unknown): sets.SetName {
  return typeof v === 'string' && (sets.SET_NAMES as readonly string[]).includes(v) ? (v as sets.SetName) : fail('/set_name');
}

export async function listCodeSet(ctx: ConfigCtx, input: { params: unknown; query: unknown }): Promise<Obj> {
  const { tx } = scope(ctx);
  const set = setName((input.params as Obj | undefined)?.['set_name']);
  const q = isObj(input.query) ? input.query : {};
  const rows = await sets.listCodes(tx, {
    setName: set, includeInactive: flag(q['include_inactive'], '/include_inactive') ?? false, q: q['q'] === undefined ? undefined : str(q['q'], '/q', 1, 40),
  });
  return { data: rows.map((r) => codeDto(set, r)) };
}

const EXTRA_RULES: Readonly<Record<string, (v: unknown) => unknown>> = {
  organism_group_code: (v) => code(v, '/organism_group_code'),
  gram_class: (v) => (['gram_positive', 'gram_negative', 'yeast', 'mould', 'other'].includes(v as string) ? v : fail('/gram_class')),
  is_alert: (v) => bool(v, '/is_alert'),
  snomed_ct_concept_id: (v) => (typeof v === 'string' && SNOMED.test(v) ? v : fail('/snomed_ct_concept_id')),
  antibiotic_class: (v) => str(v, '/antibiotic_class', 1, 64),
  indicates_growth: (v) => bool(v, '/indicates_growth'),
  result_flag: (v) => (v === 'N' || v === 'A' ? v : fail('/result_flag')),
  requires_isolate: (v) => bool(v, '/requires_isolate'),
};

const INSERT_REQUIRED: readonly string[] = ['indicates_growth', 'result_flag', 'requires_isolate'];

export async function upsertCode(ctx: ConfigCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<{ body: Obj; version: number }> {
  const { tx, tenantId, userId } = scope(ctx);
  const p = isObj(input.params) ? input.params : {};
  const set = setName(p['set_name']);
  // S-24 / T-E2: the ast_interpretations categories are global and fixed; no permission can write them.
  if (set === 'ast_interpretations') throw new LimsError('auth.forbidden');
  const c = code(p['code'], '/code');
  const b = isObj(input.body) ? input.body : fail('/');
  const extras = sets.EXTRAS[set];
  strict(b, ['display', 'sort_order', 'is_active', ...extras.map((e) => e.name)]);
  const need = (k: string): unknown => (b[k] === undefined ? fail(`/${k}`, 'Field required', 'common.field_required') : b[k]);
  const display = str(need('display'), '/display', 1, 200);
  const sortOrder = int(need('sort_order'), '/sort_order', 0, 100000);
  const isActive = bool(need('is_active'), '/is_active');
  const values: Obj = {};
  for (const e of extras) if (b[e.name] !== undefined) values[e.name] = EXTRA_RULES[e.name]!(b[e.name]);
  if (typeof values['organism_group_code'] === 'string' && !(await sets.activeCodeExists(tx, { setName: 'organism_groups', code: values['organism_group_code'] }))) fail('/organism_group_code');

  const existing = await sets.findTenantCode(tx, { tenantId, setName: set, code: c });
  let row: Row | undefined;
  if (existing) {
    // Updating a tenant row (incl. the one that shadows a global code) is optimistic-locked; the global row is never written.
    row = await sets.updateTenantCode(tx, { tenantId, userId, expectedVersion: needVersion(input.ifMatch), setName: set, code: c, display, sortOrder, isActive, values });
  } else {
    // 05-SCHEMA §8: these extras are NOT NULL with no DEFAULT, so a new tenant row must supply them (updates keep the stored value).
    for (const e of extras) if (INSERT_REQUIRED.includes(e.name)) need(e.name);
    row = await sets.insertTenantCode(tx, { tenantId, userId, id: uuidv7(), setName: set, code: c, display, sortOrder, isActive, values });
  }
  if (!row) return conflict();
  return { body: codeDto(set, { ...row, source: 'tenant' }), version: row['version'] };
}

// ====================================================================== plating protocols (M25–M28)
interface ProtocolInput {
  code?: string; display: string; hours: number[]; finalHours: number; gram: boolean; site?: string;
  media: Array<{ media_code: string; incubation_text?: string }>; applies: Array<{ test_id?: string; specimen_type_code?: string }>;
}
const PROTOCOL_KEYS = ['display', 'read_schedule_hours', 'final_no_growth_hours', 'requires_gram_stain', 'default_specimen_site_code', 'media', 'applies_to'];

function parseProtocol(body: unknown, withCode: boolean): ProtocolInput {
  const b = isObj(body) ? body : fail('/');
  strict(b, withCode ? ['code', ...PROTOCOL_KEYS] : PROTOCOL_KEYS);
  const need = (k: string): unknown => (b[k] === undefined ? fail(`/${k}`, 'Field required', 'common.field_required') : b[k]);
  const out: ProtocolInput = { display: '', hours: [], finalHours: 0, gram: false, media: [], applies: [] };
  if (withCode) out.code = code(need('code'), '/code');
  out.display = str(need('display'), '/display', 1, 120);
  const h = need('read_schedule_hours');
  if (!Array.isArray(h) || h.length < 1 || h.length > 10) fail('/read_schedule_hours');
  out.hours = (h as unknown[]).map((x) => int(x, '/read_schedule_hours', 1, 720));
  if (out.hours.some((x, i) => i > 0 && x <= out.hours[i - 1]!)) fail('/read_schedule_hours'); // strictly ascending (schema CHECK leaves this to the service)
  out.finalHours = int(need('final_no_growth_hours'), '/final_no_growth_hours', 1, 720);
  out.gram = bool(need('requires_gram_stain'), '/requires_gram_stain');
  if (b['default_specimen_site_code'] !== undefined) out.site = code(b['default_specimen_site_code'], '/default_specimen_site_code');
  const m = need('media');
  if (!Array.isArray(m) || m.length < 1 || m.length > 12) fail('/media');
  out.media = (m as unknown[]).map((it, i) => {
    const o = isObj(it) ? it : fail(`/media/${i}`);
    strict(o, ['media_code', 'incubation_text']);
    return { media_code: code(o['media_code'], `/media/${i}/media_code`), ...(o['incubation_text'] === undefined ? {} : { incubation_text: str(o['incubation_text'], `/media/${i}/incubation_text`, 1, 120) }) };
  });
  const a = need('applies_to');
  if (!Array.isArray(a) || a.length > 50) fail('/applies_to');
  const seen = new Set<string>();
  out.applies = (a as unknown[]).map((it, i) => {
    const o = isObj(it) ? it : fail(`/applies_to/${i}`);
    strict(o, ['test_id', 'specimen_type_code']);
    if (o['test_id'] === undefined && o['specimen_type_code'] === undefined) fail(`/applies_to/${i}`); // an empty key would match everything
    const key = {
      ...(o['test_id'] === undefined ? {} : { test_id: typeof o['test_id'] === 'string' && UUID.test(o['test_id']) ? o['test_id'].toLowerCase() : fail(`/applies_to/${i}/test_id`) }),
      ...(o['specimen_type_code'] === undefined ? {} : { specimen_type_code: code(o['specimen_type_code'], `/applies_to/${i}/specimen_type_code`) }),
    };
    const id = `${key.test_id ?? ''}|${key.specimen_type_code ?? ''}`;
    if (seen.has(id)) fail(`/applies_to/${i}`);
    seen.add(id);
    return key;
  });
  return out;
}

/** Coded references the DB cannot FK across the global/tenant union (05-SCHEMA §8). */
async function checkRefs(tx: any, p: ProtocolInput): Promise<void> {
  if (p.site !== undefined && !(await sets.activeCodeExists(tx, { setName: 'specimen_sites', code: p.site }))) fail('/default_specimen_site_code');
  const known = new Set<string>();
  for (const [i, m] of p.media.entries()) {
    if (known.has(m.media_code)) continue;
    if (!(await sets.activeCodeExists(tx, { setName: 'media', code: m.media_code }))) fail(`/media/${i}/media_code`);
    known.add(m.media_code);
  }
}

async function checkKeyClash(tx: any, tenantId: string, ownCode: string, p: ProtocolInput): Promise<void> {
  for (const k of p.applies) {
    if (await cfg.keyClash(tx, { tenantId, excludeCode: ownCode, testId: k.test_id, specimenTypeCode: k.specimen_type_code })) throw new LimsError('micro.code_duplicate');
  }
}

async function writeProtocol(tx: any, s: { tenantId: string; userId: string }, protoCode: string, versionNo: number, p: ProtocolInput): Promise<Row> {
  try {
    const row = await cfg.insertProtocol(tx, {
      ...s, id: uuidv7(), code: protoCode, versionNo,
      values: { display: p.display, read_schedule_hours: p.hours, final_no_growth_hours: p.finalHours, requires_gram_stain: p.gram, default_specimen_site_code: p.site },
    });
    for (const [i, m] of p.media.entries()) await cfg.insertMedia(tx, { ...s, id: uuidv7(), protocolId: row['id'], mediaCode: m.media_code, sortOrder: i, incubationText: m.incubation_text });
    for (const k of p.applies) await cfg.insertKey(tx, { ...s, id: uuidv7(), protocolCode: protoCode, testId: k.test_id, specimenTypeCode: k.specimen_type_code });
    return row;
  } catch (e) {
    // A concurrent request won the partial unique indexes after our pre-checks.
    if (pgState(e) === '23505') throw new LimsError('micro.code_duplicate');
    if (pgState(e) === '23503') fail('/applies_to'); // test_id is not a catalog test of this tenant
    throw e;
  }
}

async function dtos(tx: any, tenantId: string, rows: readonly Row[]): Promise<Obj[]> {
  if (rows.length === 0) return [];
  const media = await cfg.mediaOf(tx, { tenantId, protocolIds: rows.map((r) => r['id']) });
  const keys = await cfg.keysOf(tx, { tenantId, codes: [...new Set(rows.map((r) => r['code'] as string))] });
  return rows.map((r) => protocolDto(r, media.filter((m) => m['protocol_id'] === r['id']),
    r['superseded_at'] == null ? keys.filter((k) => k['protocol_code'] === r['code']) : []));
}

export async function listProtocols(ctx: ConfigCtx, input: { query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scope(ctx);
  const q = isObj(input.query) ? input.query : {};
  const rows = await cfg.listProtocols(tx, {
    tenantId, includeSuperseded: flag(q['include_superseded'], '/include_superseded') ?? false, isActive: flag(q['is_active'], '/is_active'),
  });
  return { data: await dtos(tx, tenantId, rows) };
}

export async function createProtocol(ctx: ConfigCtx, input: { body: unknown }): Promise<Obj> {
  const { tx, tenantId, userId } = scope(ctx);
  const p = parseProtocol(input.body, true);
  const protoCode = p.code!;
  await checkRefs(tx, p);
  if (await cfg.activeCodeTaken(tx, { tenantId, code: protoCode })) throw new LimsError('micro.code_duplicate');
  await checkKeyClash(tx, tenantId, protoCode, p);
  const row = await writeProtocol(tx, { tenantId, userId }, protoCode, 1, p);
  return (await dtos(tx, tenantId, [row]))[0]!;
}

const protocolId = (params: unknown): string => {
  const v = isObj(params) ? params['protocol_id'] : undefined;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : fail('/protocol_id');
};

/** The row is locked, so two concurrent new versions of one protocol serialise and the loser sees a stale version. */
async function loadCurrent(tx: any, tenantId: string, id: string, expected: number): Promise<Row> {
  const cur = await cfg.getProtocol(tx, { tenantId, id, forUpdate: true });
  if (!cur) throw new LimsError('common.not_found');
  if (cur['version'] !== expected || cur['superseded_at'] != null) return conflict();
  return cur;
}

export async function versionProtocol(ctx: ConfigCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Obj> {
  const { tx, tenantId, userId } = scope(ctx);
  const id = protocolId(input.params);
  const p = parseProtocol(input.body, false);
  const expected = needVersion(input.ifMatch);
  const cur = await loadCurrent(tx, tenantId, id, expected);
  await checkRefs(tx, p);
  await checkKeyClash(tx, tenantId, cur['code'], p); // own keys are not a clash: v(n+1) replaces them
  await cfg.supersedeProtocol(tx, { tenantId, userId, id });
  await cfg.deactivateKeys(tx, { tenantId, userId, code: cur['code'] });
  const row = await writeProtocol(tx, { tenantId, userId }, cur['code'], cur['version_no'] + 1, p);
  return (await dtos(tx, tenantId, [row]))[0]!;
}

export async function deactivateProtocol(ctx: ConfigCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Obj> {
  const { tx, tenantId, userId } = scope(ctx);
  const id = protocolId(input.params);
  if (input.body !== undefined && !(isObj(input.body) && Object.keys(input.body).length === 0)) fail('/');
  const expected = needVersion(input.ifMatch);
  const cur = await cfg.getProtocol(tx, { tenantId, id, forUpdate: true });
  if (!cur) throw new LimsError('common.not_found');
  if (cur['version'] !== expected) return conflict();
  const row = await cfg.deactivateProtocol(tx, { tenantId, userId, id });
  if (cur['superseded_at'] == null) await cfg.deactivateKeys(tx, { tenantId, userId, code: cur['code'] });
  return (await dtos(tx, tenantId, [row]))[0]!;
}
