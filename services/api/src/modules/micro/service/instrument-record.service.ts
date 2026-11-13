// T-14: instruments.result.received.v1 consumer (02-TRD §4.8 steps 1–6, §8.2) + M19–M22 (steps 7–8) + vocabulary maps / AST defaults M33–M38 (§5.3, §5.4); PRD AC-08.1–08.12; 07-SECURITY S-05, BOLA, P2.
// The consumer runs inside the C0 wrapper's transaction (inbox dedupe + schema validation done): it opens none. The request handlers use the request transaction. Tenant comes from ctx.tenantId only.
// Lock order of every write path: culture FOR UPDATE, then the record FOR UPDATE (same as M3–M10). The sample barcode (P2) is stored on the record and shown in M19's DTO only: never logged, never in a metric label.
// [CONV] reasons beyond TRD §4.8: no_culture, multiple_cultures (0 / >1 cultures or specimens), culture_not_set_up, isolate_number_in_use, isolate_seq_missing, isolate_withdrawn; an unreadable lab lookup
//   (LabPort throws) stores lookup_unavailable and resolves (no dead letter); LIMS_MICRO_SPECIMEN_LOOKUP_PORT other than true/false rejects (TRD §6 fail fast).
// [CONV] order of checks in M20–M22: 404 -> 403 (record centre) -> 400 body -> 428 -> 409 version -> 409 state -> culture work. Applied / ignored are terminal (409 micro.instrument_record_conflict).
// [CONV] an AST row found with source = instrument and a LATER stored instrument_result_time is kept and the record closes ignored / duplicate; a missing incoming time counts as not older.
// [CONV] M19 omits isolate_seq outside 1..99 (the DTO range) — an out-of-range number is still visible through match_reason isolate_seq_out_of_range.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { nextCultureStatus, type CultureStatus } from '../domain/culture.state.js';
import { parseAstValue, type AstMethod } from '../domain/ast-value.js';
import { validateInterpretation } from '../domain/interpretation.js';
import { assertRecordTransition, RECORD_STATUSES, type RecordResolution, type RecordStatus } from '../domain/isolate.state.js';
import { loadMicroConfig } from '../config.js';
import * as sets from '../repository/codedsets.repo.js';
import * as cultureRepo from '../repository/cultures.repo.js';
import * as astRepo from '../repository/ast.repo.js';
import * as repo from '../repository/instrument-records.repo.js';
import { bad, conflict, guarded, isObj, needVersion, strictKeys, uuid, WORK } from './culture.service.js';

type Obj = Record<string, any>;
type Out = { body: Obj; version?: number };

export interface RecordCtx {
  readonly tenantId: string; readonly actor: { readonly id: string; readonly membershipId?: string | undefined }; readonly tx: any; readonly now?: () => Date | string;
  readonly metrics?: { inc(name: string, labels?: Record<string, string>): void };
  readonly ports?: { IdentityPort?: any; LabPort?: any };
}

const CODE = /^[a-z0-9_]{2,64}$/;
const SEQ_MAX = 99;
const METRIC = 'lims_micro_instrument_records_total';
const nowOf = (c: RecordCtx): Date => new Date(typeof c.now === 'function' ? c.now() : Date.now());
const text = (v: unknown, p: string, min: number, max: number): string => (typeof v === 'string' && v.length >= min && v.length <= max ? v : bad(p));
const optText = (v: unknown, p: string, max: number): string | null => (v === undefined || v === null ? null : text(v, p, 1, max));

// ================================================================ consumer
const COMPOSITE = [/^ORG:([0-9]{1,9})$/, /^AST:([0-9]{1,9}):/];
/** TRD §4.8 step 5: `ORG:<n>` / `AST:<n>:<code>:<method>` (C7 driver rule, CR-C10-007); anything else = absent. */
export function isolateSeqOf(analyteCode: string): number | null {
  for (const re of COMPOSITE) { const m = re.exec(analyteCode); if (m) return Number(m[1]); }
  return null;
}
const mappedCode = (v: unknown): string | null => (typeof v === 'string' && CODE.test(v) ? v : null);   // CHECK instrument_records__codes__ck: a malformed mapped code is "absent"

export async function onInstrumentResult(ctx: RecordCtx, event: Obj): Promise<void> {
  const tenantId = ctx?.tenantId;
  if (typeof tenantId !== 'string' || typeof ctx.actor?.id !== 'string') throw new LimsError('auth.forbidden');
  const p = isObj(event?.payload) ? event.payload : bad('/payload');
  const kind = p['record_kind'];
  if (kind !== 'organism_id' && kind !== 'ast') return;                                  // AC-08.1: every other kind = the C0 inbox row only
  const lookupEnabled = loadMicroConfig().specimenLookupPort;                            // fail fast on a bad flag, before any write
  const analyteCode = text(p['instrument_analyte_code'], '/payload/instrument_analyte_code', 1, 64);
  const org = kind === 'organism_id' ? (isObj(p['organism']) ? p['organism'] : bad('/payload/organism')) : undefined;
  const ast = kind === 'ast' ? (isObj(p['ast']) ? p['ast'] : bad('/payload/ast')) : undefined;
  const sub = (org ?? ast)!;
  const rawSeq = sub['isolate_seq'];
  const method = ast === undefined ? null : text(ast['method'], '/payload/ast/method', 1, 13);
  const stored: Obj = {
    id: uuidv7(), tenantId, centreId: uuid(p['centre_id'], '/payload/centre_id'), eventId: uuid(event['event_id'], '/event_id'), idempotencyKey: text(event['idempotency_key'], '/idempotency_key', 1, 200),
    instrumentMessageId: uuid(p['instrument_message_id'], '/payload/instrument_message_id'), instrumentId: uuid(p['instrument_id'], '/payload/instrument_id'),
    sampleBarcode: text(p['sample_barcode'], '/payload/sample_barcode', 1, 40), recordKind: kind, analyteCode,
    isolateSeq: Number.isSafeInteger(rawSeq) && rawSeq >= 0 && rawSeq <= 999_999_999 ? rawSeq : isolateSeqOf(analyteCode),
    organismCodeRaw: org ? text(org['organism_code_raw'], '/payload/organism/organism_code_raw', 1, 64) : null,
    antibioticCodeRaw: ast ? text(ast['antibiotic_code_raw'], '/payload/ast/antibiotic_code_raw', 1, 64) : null,
    method, rawValue: ast ? text(ast['raw_value'], '/payload/ast/raw_value', 1, 32) : null,
    organismCode: org ? mappedCode(org['organism_code']) : null, antibioticCode: ast ? mappedCode(ast['antibiotic_code']) : null,
    interpretationRaw: ast ? optText(ast['interpretation_raw'], '/payload/ast/interpretation_raw', 16) : null,
    standard: ast ? optText(ast['standard'], '/payload/ast/standard', 7) : null, standardVersion: ast ? optText(ast['standard_version'], '/payload/ast/standard_version', 32) : null,
    resultTime: optText(p['instrument_result_time'], '/payload/instrument_result_time', 40), receivedAt: text(p['received_at'], '/payload/received_at', 1, 40), isRerun: p['is_rerun'] === true,
    userId: ctx.actor.id,
  };
  if (!(await repo.insertRecord(ctx.tx, stored as repo.NewRecord))) return;               // AC-08.2: the key exists = done (no second write, no second metric)

  const out = await resolveForConsumer(ctx, tenantId, stored, lookupEnabled);
  const years = out.eval.status === 'applied' || out.eval.status === 'ignored' ? await retentionYears(ctx) : null;
  await repo.settleRecord(ctx.tx, { tenantId, id: stored['id'], userId: ctx.actor.id, status: out.eval.status, reason: out.eval.reason ?? null, specimenId: out.specimenId, cultureId: out.cultureId,
    isolateId: out.eval.isolateId ?? null, astResultId: out.eval.astId ?? null, ignoreReason: out.eval.ignoreReason ?? null, ignoreComment: null, membershipId: null, resolved: false, years });
  ctx.metrics?.inc(METRIC, { tenant_id: tenantId, record_kind: kind, match_status: out.eval.status });
}

interface Eval { status: RecordStatus; reason?: string; isolateId?: string; astId?: string; ignoreReason?: string }
const pending = (reason: string): { eval: Eval; specimenId: null; cultureId: null } => ({ eval: { status: 'pending_match', reason }, specimenId: null, cultureId: null });

/** Steps 2–3 (specimen, culture) then 4–6 (evaluate). */
async function resolveForConsumer(ctx: RecordCtx, tenantId: string, rec: Obj, lookupEnabled: boolean): Promise<{ eval: Eval; specimenId: string | null; cultureId: string | null }> {
  if (!lookupEnabled) return pending('lookup_unavailable');                               // AC-08.4: matching is manual until C5 ships lookupSpecimens
  let refs: Obj[];
  try { refs = await ctx.ports!.LabPort.lookupSpecimens(ctx, { barcode: rec['sampleBarcode'] }); } catch { return pending('lookup_unavailable'); }
  if (!Array.isArray(refs) || refs.length === 0) return pending('unknown_barcode');
  if (refs.length > 1) return pending('multiple_cultures');
  const specimenId = refs[0]!['specimenId'] as string;
  const cands = await repo.candidateCultures(ctx.tx, { tenantId, specimenId });
  if (cands.length === 0) return { ...pending('no_culture'), specimenId };
  if (cands.length > 1) return { ...pending('multiple_cultures'), specimenId };
  const culture = await cultureRepo.lockCulture(ctx.tx, { tenantId, id: cands[0]!['id'] });
  if (!culture) return { ...pending('no_culture'), specimenId };
  const e = await evaluate(ctx, tenantId, ctx.actor.id, toRow(rec), culture, { force: false });
  return { eval: e, specimenId, cultureId: culture['id'] };
}

/** The stored record in the column names evaluate() reads (the consumer has the insert values, the handlers the DB row). */
const toRow = (r: Obj): Obj => ({ id: r['id'], centre_id: r['centreId'], instrument_id: r['instrumentId'], instrument_analyte_code: r['analyteCode'], isolate_seq: r['isolateSeq'], record_kind: r['recordKind'],
  organism_code_raw: r['organismCodeRaw'], antibiotic_code_raw: r['antibioticCodeRaw'], method: r['method'], raw_value: r['rawValue'], organism_code: r['organismCode'], antibiotic_code: r['antibioticCode'],
  interpretation_raw: r['interpretationRaw'], standard: r['standard'], standard_version: r['standardVersion'], instrument_result_time: r['resultTime'] });

/** D-65: read once per request / job; only when a record closes. Floor 1. */
async function retentionYears(c: RecordCtx): Promise<number> {
  const s = await c.ports?.IdentityPort?.getTenantSettings?.(c, { keys: ['retention'] });
  const y = s?.retention?.rawInstrumentYears;
  return Number.isSafeInteger(y) && y >= 1 && y <= 100 ? y : 1;
}

// ---------------------------------------------------------------- steps 4–6
/** An active code of the resolved view: the mapped code carried by the event wins, else the instrument's active vocabulary map, else null = needs_mapping (step 4). */
async function localCode(c: RecordCtx, tenantId: string, view: 'organisms' | 'antibiotics', kind: 'organism' | 'antibiotic', rec: Obj): Promise<string | null> {
  const active = async (code: string): Promise<boolean> => (await sets.codeRows(c.tx, { view, tenantId, codes: [code] })).get(code)?.['is_active'] === true;
  const carried = kind === 'organism' ? rec['organism_code'] : rec['antibiotic_code'];
  if (typeof carried === 'string' && (await active(carried))) return carried;
  const raw = kind === 'organism' ? rec['organism_code_raw'] : rec['antibiotic_code_raw'];
  const map = await repo.activeMap(c.tx, { tenantId, instrumentId: rec['instrument_id'], kind, codeRaw: raw });
  return map && (await active(map['local_code'])) ? (map['local_code'] as string) : null;
}

interface Opts { force: boolean; seq?: number | undefined }
/** Steps 3–6 against a locked, non-cancelled culture. Writes the clinical rows (isolate, counter, AST) and answers the record's next state; never touches the record itself. */
async function evaluate(c: RecordCtx, tenantId: string, userId: string, rec: Obj, culture: Obj, o: Opts): Promise<Eval> {
  const seq = o.seq ?? (typeof rec['isolate_seq'] === 'number' ? rec['isolate_seq'] : isolateSeqOf(rec['instrument_analyte_code']));
  if (seq !== null && (seq < 1 || seq > SEQ_MAX)) return { status: 'pending_match', reason: 'isolate_seq_out_of_range' };    // AC-08.11 (DB limit isolates__seq__ck)
  if (culture['status'] === 'final_submitted') return { status: 'late_after_final' };                                         // AC-08.9: nothing applied
  if (culture['status'] === 'awaiting_setup') return { status: 'pending_match', reason: 'culture_not_set_up' };
  const isOrg = rec['record_kind'] === 'organism_id';
  const code = isOrg ? await localCode(c, tenantId, 'organisms', 'organism', rec) : await localCode(c, tenantId, 'antibiotics', 'antibiotic', rec);
  if (code === null) return { status: 'needs_mapping' };
  return guarded(() => (isOrg ? applyOrganism(c, tenantId, userId, rec, culture, seq, code, o.force) : applyAst(c, tenantId, userId, rec, culture, seq, code, o.force)));
}

/** The isolate a record addresses: its number, or the only live isolate when there is no number. 'none' = absent, 'ambiguous' = no number and several live isolates. */
async function findIsolate(tx: any, tenantId: string, culture: Obj, seq: number | null): Promise<{ iso?: Obj; reason?: string; all: Obj[] }> {
  const all = await repo.isolatesOfCulture(tx, { tenantId, cultureId: culture['id'] });
  if (seq !== null) {
    const iso = all.find((i) => i['isolate_seq'] === seq);
    if (iso) return { iso, all };
    return (await repo.isolateBySpecimenSeq(tx, { tenantId, specimenId: culture['specimen_id'], seq })) ? { reason: 'isolate_number_in_use', all } : { all };
  }
  const live = all.filter((i) => i['status'] !== 'withdrawn');
  if (live.length === 1) return { iso: live[0]!, all };
  if (live.length > 1 || all.length > 0) return { reason: 'isolate_seq_missing', all };
  // review #2: isolate 1 is specimen-wide (isolates__specimen_seq__uq); another culture of the specimen may own it
  return (await repo.isolateBySpecimenSeq(tx, { tenantId, specimenId: culture['specimen_id'], seq: 1 })) ? { reason: 'isolate_number_in_use', all } : { all };
}

async function applyOrganism(c: RecordCtx, tenantId: string, userId: string, rec: Obj, culture: Obj, seq: number | null, organism: string, force: boolean): Promise<Eval> {
  const at = nowOf(c);
  const f = await findIsolate(c.tx, tenantId, culture, seq);
  if (f.reason) return { status: 'pending_match', reason: f.reason };
  let iso = f.iso;
  if (!iso) {                                                                                  // step 5: absent -> create with that number, counter = greatest(counter, seq)
    const n = seq ?? 1;
    await repo.raiseCounter(c.tx, { tenantId, specimenId: culture['specimen_id'], seq: n, userId });
    const made = await repo.insertInstrumentIsolate(c.tx, { id: uuidv7(), tenantId, centreId: culture['centre_id'], cultureId: culture['id'], specimenId: culture['specimen_id'], seq: n, organismCode: organism, at, userId });
    if (culture['status'] === 'incubating') {                                                  // C3: the first isolate = growth_detected (as M7)
      const to = nextCultureStatus('incubating' as CultureStatus, 'growth');
      await cultureRepo.updateAfterRead(c.tx, { tenantId, id: culture['id'], status: to, nextReadDueAt: culture['next_read_due_at'] == null ? null : new Date(culture['next_read_due_at']), userId });
      await cultureRepo.insertTransition(c.tx, { id: uuidv7(), tenantId, centreId: culture['centre_id'], cultureId: culture['id'], from: 'incubating', to, reason: null, occurredAt: at.toISOString(), userId });
    }
    return { status: 'applied', isolateId: made['id'] };
  }
  if (iso['status'] === 'withdrawn') return { status: 'pending_match', reason: 'isolate_withdrawn' };
  if (iso['status'] === 'identified' && iso['organism_code'] === organism) return { status: 'applied', isolateId: iso['id'] };    // same organism: no-op
  if (iso['status'] === 'identified' && iso['organism_source'] === 'manual' && !force) return { status: 'conflict', reason: 'organism_differs', isolateId: iso['id'] };
  iso = await repo.identifyByInstrument(c.tx, { tenantId, id: iso['id'], expectedVersion: Number(iso['version']), organismCode: organism, at, userId });
  if (!iso) return conflict();                                                                 // the culture is locked: only a trigger-level surprise gets here
  return { status: 'applied', isolateId: iso['id'] };
}

const STANDARDS = ['CLSI', 'EUCAST', 'ECOFF'];
/** Step 6 "Standard" + "Category": payload standard, else the instrument default, else unknown; a category only when the standard has that code and a version is known. */
async function astValues(c: RecordCtx, tenantId: string, rec: Obj, antibiotic: string): Promise<repo.AstValues> {
  const method = rec['method'] as AstMethod;
  const parsed = parseAstValue(rec['raw_value'], method);
  let standard: string | null; let version: string | null; let source: string | null;
  if (STANDARDS.includes(rec['standard'])) { standard = rec['standard']; version = rec['standard_version'] ?? null; source = 'instrument_payload'; }
  else {
    const d = await repo.astDefault(c.tx, { tenantId, instrumentId: rec['instrument_id'] });
    if (d) { standard = d['standard']; version = d['standard_version']; source = 'instrument_default'; } else { standard = 'unknown'; version = null; source = null; }
  }
  let category: string | null = null;
  const raw = typeof rec['interpretation_raw'] === 'string' ? rec['interpretation_raw'].trim().toUpperCase() : '';
  if (raw !== '' && STANDARDS.includes(standard!) && version !== null) {
    const catalog = { interpretations: (await astRepo.catalogInterpretations(c.tx)) as any, restrictions: (await astRepo.catalogRestrictions(c.tx)) as any };
    if (validateInterpretation({ category_code: raw, standard, standard_version: version, antibiotic_code: antibiotic, raw_value: rec['raw_value'] }, catalog).ok) category = raw;
  }
  return { rawValue: rec['raw_value'], rawQualifier: parsed.ok ? parsed.value.raw_qualifier ?? null : null, rawNumeric: parsed.ok ? parsed.value.raw_numeric ?? null : null,
    unitCode: parsed.ok ? parsed.value.unit_code ?? null : null, categoryCode: category, standard, standardVersion: version, standardSource: source, interpretationRaw: rec['interpretation_raw'] ?? null,
    interpretationSource: category === null ? null : 'instrument', instrumentRecordId: rec['id'], instrumentId: rec['instrument_id'], resultTime: rec['instrument_result_time'] ?? null };
}

const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());

async function applyAst(c: RecordCtx, tenantId: string, userId: string, rec: Obj, culture: Obj, seq: number | null, antibiotic: string, force: boolean): Promise<Eval> {
  const f = await findIsolate(c.tx, tenantId, culture, seq);
  if (f.reason === 'isolate_seq_missing') return { status: 'pending_match', reason: f.reason };
  const iso = f.iso;
  if (!iso) return { status: 'pending_match', reason: 'isolate_missing' };                      // AST never creates an isolate
  if (iso['status'] === 'withdrawn') return { status: 'pending_match', reason: 'isolate_withdrawn' };
  const v = await astValues(c, tenantId, rec, antibiotic);
  const existing = await repo.findAst(c.tx, { tenantId, isolateId: iso['id'], antibioticCode: antibiotic, method: rec['method'] });
  if (!existing) {
    const pos = iso['ast_panel_id'] ? await repo.panelPosition(c.tx, { tenantId, panelId: iso['ast_panel_id'], antibioticCode: antibiotic }) : undefined;
    const made = await repo.insertInstrumentAst(c.tx, { id: uuidv7(), tenantId, centreId: culture['centre_id'], cultureId: culture['id'], isolateId: iso['id'], antibioticCode: antibiotic, method: rec['method'], v,
      offPanel: !pos, sortOrder: pos ? Number(pos['sort_order']) : null, userId });
    return { status: 'applied', isolateId: iso['id'], astId: made['id'] };
  }
  if (existing['source'] === 'instrument') {
    const incoming = ms(rec['instrument_result_time']); const stored = ms(existing['instrument_result_time']);
    if (incoming !== null && stored !== null && incoming < stored) return { status: 'ignored', ignoreReason: 'duplicate', isolateId: iso['id'], astId: existing['id'] };   // older rerun
  } else if (existing['raw_value'] != null && !force) {
    return { status: 'conflict', reason: 'manual_value_exists', isolateId: iso['id'], astId: existing['id'] };
  }
  const done = await repo.replaceWithInstrumentAst(c.tx, { tenantId, id: existing['id'], expectedVersion: Number(existing['version']), v, userId });
  if (!done) return conflict();
  return { status: 'applied', isolateId: iso['id'], astId: done['id'] };
}

// ================================================================ M19 – M22
const READ = 'micro.culture.read';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const KEY_TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const isoOf = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string).toISOString());
const put = (o: Obj, k: string, v: unknown): void => { if (v !== null && v !== undefined) o[k] = v; };

/** InstrumentRecordDto (TRD §5.6): no nulls on the wire; sample_barcode only here (P2). */
export function recordDto(r: Obj): Obj {
  const o: Obj = { id: r['id'], version: Number(r['version']), record_kind: r['record_kind'], instrument_id: r['instrument_id'], instrument_message_id: r['instrument_message_id'], sample_barcode: r['sample_barcode'],
    received_at: isoOf(r['received_at']), is_rerun: r['is_rerun'] === true, match_status: r['match_status'] };
  if (Number.isInteger(r['isolate_seq']) && r['isolate_seq'] >= 1 && r['isolate_seq'] <= SEQ_MAX) o['isolate_seq'] = r['isolate_seq'];
  for (const k of ['organism_code_raw', 'antibiotic_code_raw', 'method', 'raw_value', 'interpretation_raw', 'standard', 'standard_version', 'match_reason', 'culture_id', 'isolate_id', 'ast_result_id',
    'organism_code', 'antibiotic_code', 'ignore_reason_code', 'ignore_comment']) put(o, k, r[k]);
  put(o, 'instrument_result_time', isoOf(r['instrument_result_time']));
  put(o, 'expires_at', isoOf(r['expires_at']));
  return o;
}

const ID_PARAM = (params: unknown, name: string): string => uuid(isObj(params) ? params[name] : undefined, `/${name}`).toLowerCase();
const identityOf = (c: RecordCtx): any => { const i = c.ports?.IdentityPort; if (!i) throw new LimsError('auth.forbidden'); return i; };   // fail closed
const scopeOf = (c: RecordCtx): { tx: any; tenantId: string; userId: string } => {
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  return { tx: c.tx, tenantId: c.tenantId, userId: c.actor.id };
};
const recordConflict = (): never => { throw new LimsError('micro.instrument_record_conflict'); };

function limitOf(v: unknown): number {
  if (v === undefined) return 50;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : bad('/limit');
}
const instantQ = (q: Obj, k: string): string | undefined => {
  const v = q[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !ISO_UTC.test(v) || new Date(v).toISOString() !== v) return bad(`/${k}`);
  return v;
};
const uuidQ = (q: Obj, k: string): string | undefined => (q[k] === undefined ? undefined : typeof q[k] === 'string' && UUID.test(q[k]) ? (q[k] as string).toLowerCase() : bad(`/${k}`));
const queryOf = (q: unknown, allowed: readonly string[]): Obj => {
  const o = q === undefined || q === null ? {} : isObj(q) ? q : bad('/');
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: `/${k.slice(0, 64)}`, code: 'common.unknown_field', message: 'Unknown field' } satisfies FieldError]);
  return o;
};
const encode = (v: unknown[]): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
function decode(raw: unknown): unknown[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !CURSOR.test(raw)) throw new LimsError('common.invalid_cursor');
  try { const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); if (Array.isArray(v)) return v; } catch { /* fall through */ }
  throw new LimsError('common.invalid_cursor');
}

export async function listRecords(c: RecordCtx, input: { query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scopeOf(c);
  const q = queryOf(input.query, ['match_status', 'culture_id', 'instrument_id', 'received_at_from', 'received_at_to', 'sort', 'cursor', 'limit']);
  let statuses: readonly string[] = repo.OPEN;                                                  // default = the open statuses
  if (q['match_status'] !== undefined) {
    const parts = typeof q['match_status'] === 'string' && q['match_status'].length <= 120 ? q['match_status'].split(',') : bad('/match_status');
    statuses = parts.every((s) => (RECORD_STATUSES as readonly string[]).includes(s)) ? [...new Set(parts)] : bad('/match_status');
  }
  const sort = q['sort'] === undefined ? '-received_at' : q['sort'] === 'received_at' || q['sort'] === '-received_at' ? (q['sort'] as string) : bad('/sort');
  const limit = limitOf(q['limit']);
  const cur = decode(q['cursor']);
  const cursor = cur === undefined ? undefined : cur.length === 3 && cur[0] === sort && typeof cur[1] === 'string' && KEY_TS.test(cur[1]) && typeof cur[2] === 'string' && UUID.test(cur[2]) ? { key: cur[1], id: cur[2] } : (() => { throw new LimsError('common.invalid_cursor'); })();
  const f: repo.RecordFilter = { tenantId, statuses };
  const cultureId = uuidQ(q, 'culture_id'); if (cultureId) f.cultureId = cultureId;
  const instrumentId = uuidQ(q, 'instrument_id'); if (instrumentId) f.instrumentId = instrumentId;
  const from = instantQ(q, 'received_at_from'); if (from) f.receivedFrom = from;
  const to = instantQ(q, 'received_at_to'); if (to) f.receivedTo = to;
  const rows = await repo.listRecords(tx, f, sort === '-received_at', cursor, limit);
  const page = rows.slice(0, limit);
  const info: Obj = { limit };
  const last = page[page.length - 1];
  if (rows.length > limit && last) info['next_cursor'] = encode([sort, last['sort_key'], last['id']]);
  return { data: page.map(recordDto), page: info };
}

/** Object first: absent / another tenant's / another centre's = 404; then the centre-scoped permission (02-CV §10.1). Unlocked read — the culture is locked before the record. */
async function loadRecord(c: RecordCtx, params: unknown): Promise<{ tx: any; tenantId: string; userId: string; rec: Obj }> {
  const s = scopeOf(c);
  const rec = await repo.getRecord(s.tx, { tenantId: s.tenantId, id: ID_PARAM(params, 'record_id') });
  if (!rec) throw new LimsError('common.not_found');
  await identityOf(c).assertRole(c, { permission: WORK, centreId: rec['centre_id'] });
  return { ...s, rec };
}

const RESOLUTIONS: readonly string[] = ['use_instrument', 'keep_existing'];
const resolutionOf = (v: unknown): RecordResolution | undefined => (v === undefined ? undefined : typeof v === 'string' && RESOLUTIONS.includes(v) ? (v as RecordResolution) : bad('/resolution'));
const SEQ_FIELD = (v: unknown): number | undefined => (v === undefined ? undefined : Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= SEQ_MAX ? (v as number) : bad('/isolate_seq'));

/** Version, then state (applied / ignored are terminal; assign = pending_match; apply = a record that has a culture; conflict only with a resolution; keep_existing only on a conflict). */
function guardRecord(rec: Obj, expected: number, action: 'assign' | 'apply' | 'ignore', resolution: RecordResolution | undefined): void {
  if (Number(rec['version']) !== expected) conflict();
  const st = rec['match_status'] as RecordStatus;
  if (st === 'applied' || st === 'ignored') recordConflict();
  if (resolution === 'keep_existing' && st !== 'conflict') recordConflict();
  if (action === 'ignore') return;
  if (st === 'conflict') { if (resolution === undefined) recordConflict(); return; }
  if (action === 'assign' && st !== 'pending_match') recordConflict();
  if (action === 'apply' && rec['culture_id'] == null) recordConflict();                      // nothing to apply to: assign a culture first
}

/** Steps 7–8 for M20/M21 after the guards: culture then record locks, evaluate (or keep_existing), transition check, one settle. */
async function resolveManually(c: RecordCtx, s: { tx: any; tenantId: string; userId: string }, rec: Obj, cultureId: string, o: { action: 'assign' | 'apply'; expected: number; resolution?: RecordResolution | undefined; seq?: number | undefined }): Promise<Out> {
  const culture = await cultureRepo.lockCulture(s.tx, { tenantId: s.tenantId, id: cultureId });
  if (!culture) throw new LimsError('common.not_found');
  await identityOf(c).assertRole(c, { permission: WORK, centreId: culture['centre_id'] });
  const fresh = await repo.getRecord(s.tx, { tenantId: s.tenantId, id: rec['id'], forUpdate: true });
  if (!fresh) throw new LimsError('common.not_found');
  guardRecord(fresh, o.expected, o.action, o.resolution);                                      // re-checked under the lock: the loser of a race ends here
  if (culture['status'] === 'cancelled') throw new LimsError('micro.culture_invalid_transition');
  const from = fresh['match_status'] as RecordStatus;
  const out: Eval = o.resolution === 'keep_existing' ? { status: 'ignored', ignoreReason: 'kept_manual' }
    : await evaluate(c, s.tenantId, s.userId, fresh, culture, { force: o.resolution === 'use_instrument', seq: o.seq });
  if (out.status !== from && (out.status === 'applied' || out.status === 'conflict' || (out.status === 'ignored' && out.ignoreReason === 'kept_manual'))) {
    assertRecordTransition(from, out.status, o.action, from === 'conflict' ? o.resolution : undefined);
  }
  const years = out.status === 'applied' || out.status === 'ignored' ? await retentionYears(c) : null;
  const row = await repo.settleRecord(s.tx, { tenantId: s.tenantId, id: fresh['id'], userId: s.userId, status: out.status, reason: out.reason ?? null, specimenId: culture['specimen_id'], cultureId: culture['id'],
    isolateId: out.isolateId ?? null, astResultId: out.astId ?? null, ignoreReason: out.ignoreReason ?? null, ignoreComment: null, membershipId: c.actor.membershipId ?? null,
    resolved: out.status === 'applied' || out.status === 'ignored', years });
  return { body: recordDto(row), version: Number(row['version']) };
}

export async function assignRecord(c: RecordCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const s = await loadRecord(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['culture_id', 'isolate_seq', 'resolution']);                                  // S-05: no match_status / expires_at / ids
  const cultureId = uuid(b['culture_id'], '/culture_id').toLowerCase();
  const seq = SEQ_FIELD(b['isolate_seq']); const resolution = resolutionOf(b['resolution']);
  const expected = needVersion(input.ifMatch);
  guardRecord(s.rec, expected, 'assign', resolution);
  return resolveManually(c, s, s.rec, cultureId, { action: 'assign', expected, resolution, seq });
}

export async function applyRecord(c: RecordCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const s = await loadRecord(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['resolution']);
  const resolution = resolutionOf(b['resolution']);
  const expected = needVersion(input.ifMatch);
  guardRecord(s.rec, expected, 'apply', resolution);
  return resolveManually(c, s, s.rec, s.rec['culture_id'], { action: 'apply', expected, resolution });
}

export async function ignoreRecord(c: RecordCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const s = await loadRecord(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['reason_code', 'comment']);
  const reason = typeof b['reason_code'] === 'string' && CODE.test(b['reason_code']) ? b['reason_code'] : bad('/reason_code');
  const comment = b['comment'] === undefined ? null : text(b['comment'], '/comment', 1, 300);
  const expected = needVersion(input.ifMatch);
  guardRecord(s.rec, expected, 'ignore', undefined);
  const fresh = await repo.getRecord(s.tx, { tenantId: s.tenantId, id: s.rec['id'], forUpdate: true });
  if (!fresh) throw new LimsError('common.not_found');
  guardRecord(fresh, expected, 'ignore', undefined);
  if ((await sets.codeRows(s.tx, { view: 'record_ignore_reasons', tenantId: s.tenantId, codes: [reason] })).get(reason)?.['is_active'] !== true) bad('/reason_code');   // coded set micro.record_ignore_reasons
  assertRecordTransition(fresh['match_status'], 'ignored', 'ignore');
  const years = await retentionYears(c);
  const row = await repo.settleRecord(s.tx, { tenantId: s.tenantId, id: fresh['id'], userId: s.userId, status: 'ignored', reason: fresh['match_reason'] ?? null, specimenId: null, cultureId: null,
    isolateId: fresh['isolate_id'] ?? null, astResultId: fresh['ast_result_id'] ?? null, ignoreReason: reason, ignoreComment: comment, membershipId: c.actor.membershipId ?? null, resolved: true, years });
  return { body: recordDto(row), version: Number(row['version']) };
}

// ================================================================ M33 – M38
const pgState = (e: unknown): string | undefined => { const x = e as { code?: unknown } | null; return typeof x?.code === 'string' ? x.code : undefined; };
const KINDS = ['organism', 'antibiotic'];
const mapDto = (r: Obj): Obj => ({ id: r['id'], version: Number(r['version']), instrument_id: r['instrument_id'], kind: r['kind'], code_raw: r['code_raw'], local_code: r['local_code'],
  is_active: r['is_active'] === true, created_at: isoOf(r['created_at']), updated_at: isoOf(r['updated_at']) });
const defaultDto = (r: Obj): Obj => ({ instrument_id: r['instrument_id'], standard: r['standard'], standard_version: r['standard_version'], version: Number(r['version']) });

/** local_code must be an active code of the resolved organisms / antibiotics view (the DB cannot FK across the global/tenant union). */
async function assertLocalCode(tx: any, tenantId: string, kind: string, localCode: string): Promise<void> {
  const view = kind === 'organism' ? 'organisms' : 'antibiotics';
  if ((await sets.codeRows(tx, { view, tenantId, codes: [localCode] })).get(localCode)?.['is_active'] !== true) bad('/local_code');
}

export async function listMaps(c: RecordCtx, input: { query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scopeOf(c);
  const q = queryOf(input.query, ['instrument_id', 'kind', 'is_active', 'cursor', 'limit']);
  const kind = q['kind'] === undefined ? undefined : typeof q['kind'] === 'string' && KINDS.includes(q['kind']) ? q['kind'] : bad('/kind');
  const active = q['is_active'] === undefined ? undefined : q['is_active'] === true || q['is_active'] === 'true' ? true : q['is_active'] === false || q['is_active'] === 'false' ? false : bad('/is_active');
  const limit = limitOf(q['limit']);
  const cur = decode(q['cursor']);
  const afterId = cur === undefined ? undefined : cur.length === 1 && typeof cur[0] === 'string' && UUID.test(cur[0]) ? cur[0] : (() => { throw new LimsError('common.invalid_cursor'); })();
  const a: Parameters<typeof repo.listMaps>[1] = { tenantId, limit };
  const instrumentId = uuidQ(q, 'instrument_id'); if (instrumentId) a.instrumentId = instrumentId;
  if (kind) a.kind = kind; if (active !== undefined) a.isActive = active; if (afterId) a.afterId = afterId;
  const rows = await repo.listMaps(tx, a);
  const page = rows.slice(0, limit);
  const info: Obj = { limit };
  if (rows.length > limit && page.length > 0) info['next_cursor'] = encode([page[page.length - 1]!['id']]);
  return { data: page.map(mapDto), page: info };
}

export async function createMap(c: RecordCtx, input: { body: unknown }): Promise<Out> {
  const { tx, tenantId, userId } = scopeOf(c);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['instrument_id', 'kind', 'code_raw', 'local_code']);
  const instrumentId = uuid(b['instrument_id'], '/instrument_id').toLowerCase();
  const kind = typeof b['kind'] === 'string' && KINDS.includes(b['kind']) ? b['kind'] : bad('/kind');
  const codeRaw = text(b['code_raw'], '/code_raw', 1, 64);
  const localCode = typeof b['local_code'] === 'string' && CODE.test(b['local_code']) ? b['local_code'] : bad('/local_code');
  await assertLocalCode(tx, tenantId, kind, localCode);
  try {
    const row = await repo.insertMap(tx, { id: uuidv7(), tenantId, instrumentId, kind, codeRaw, localCode, userId });
    return { body: mapDto(row), version: Number(row['version']) };
  } catch (e) {
    if (pgState(e) === '23505') throw new LimsError('micro.code_duplicate');                  // active (instrument, kind, code_raw) key
    if (pgState(e) === '23503') bad('/instrument_id');                                         // composite FK to instruments.instruments (P-1)
    throw e;
  }
}

async function loadMap(c: RecordCtx, params: unknown, ifMatch: number | undefined): Promise<{ tx: any; tenantId: string; userId: string; row: Obj; expected: number }> {
  const s = scopeOf(c);
  const row = await repo.getMap(s.tx, { tenantId: s.tenantId, id: ID_PARAM(params, 'map_id'), forUpdate: true });
  if (!row) throw new LimsError('common.not_found');
  const expected = needVersion(ifMatch);
  if (Number(row['version']) !== expected) conflict();
  return { ...s, row, expected };
}

export async function updateMap(c: RecordCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['local_code']);
  const localCode = typeof b['local_code'] === 'string' && CODE.test(b['local_code']) ? b['local_code'] : bad('/local_code');
  const m = await loadMap(c, input.params, input.ifMatch);
  await assertLocalCode(m.tx, m.tenantId, m.row['kind'], localCode);
  const row = await repo.updateMap(m.tx, { tenantId: m.tenantId, id: m.row['id'], expectedVersion: m.expected, localCode, userId: m.userId });
  if (!row) return conflict();
  return { body: mapDto(row), version: Number(row['version']) };
}

export async function deactivateMap(c: RecordCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  if (input.body !== undefined && !(isObj(input.body) && Object.keys(input.body).length === 0)) bad('/');
  const m = await loadMap(c, input.params, input.ifMatch);
  const row = await repo.deactivateMap(m.tx, { tenantId: m.tenantId, id: m.row['id'], expectedVersion: m.expected, userId: m.userId });
  if (!row) return conflict();
  return { body: mapDto(row), version: Number(row['version']) };
}

export async function listDefaults(c: RecordCtx): Promise<Obj> {
  const { tx, tenantId } = scopeOf(c);
  return { data: (await repo.listDefaults(tx, { tenantId })).map(defaultDto) };
}

/** M38: create without If-Match, replace with it (the row is locked first, so a race ends as 409). */
export async function putDefault(c: RecordCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId } = scopeOf(c);
  const instrumentId = ID_PARAM(input.params, 'instrument_id');
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['standard', 'standard_version']);
  const standard = typeof b['standard'] === 'string' && STANDARDS.includes(b['standard']) ? b['standard'] : bad('/standard');   // 'unknown' is not a default
  const standardVersion = text(b['standard_version'], '/standard_version', 1, 32);
  const existing = await repo.getDefault(tx, { tenantId, instrumentId });
  let row: Obj | undefined;
  if (existing) {
    const expected = needVersion(input.ifMatch);
    if (Number(existing['version']) !== expected) conflict();
    row = await repo.updateDefault(tx, { tenantId, instrumentId, expectedVersion: expected, standard, standardVersion, userId });
  } else {
    try { row = await repo.insertDefault(tx, { id: uuidv7(), tenantId, instrumentId, standard, standardVersion, userId }); } catch (e) {
      if (pgState(e) === '23503') bad('/instrument_id');
      throw e;
    }
  }
  if (!row) return conflict();
  return { body: defaultDto(row), version: Number(row['version']) };
}

export { READ as READ_PERMISSION };
