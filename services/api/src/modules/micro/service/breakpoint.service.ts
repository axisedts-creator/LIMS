// M41–M45 (read side) and M42 createBreakpointImport (02-TRD §5 M41–M45, §8 job micro.breakpoint_import_validate, §13 access_log; PRD AC-12.1, AC-12.3, AC-12.5;
// 07-SECURITY T-B1, T-B3, T-B4, T-B6, S-05, S-12, S-13, S-15). Tenant and actor come from ctx only; the permission (+ aal2) is asserted by the handler first.
// The API NEVER parses the CSV (T-12's job does): it checks size / UTF-8 / NUL / sha256 duplicate, stores the object through ctx.uploads.accept (the only writer),
// inserts ONE `uploaded` row, enqueues the validation job in the same transaction and writes one access_log row. File content is never a SQL parameter,
// a log field, an audit field or part of a response (T-B4). Error details are fixed text: no submitted value is echoed.
// [CONV] atomicity = the request transaction; the object is the only thing outside it, so every failure after accept() deletes it again.
// [CONV] the object path is server-built `{tenant_id}/breakpoints/{set_id}.csv` (S-15): neither the client file name nor metadata reaches it.
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { IncomingFile, UploadAcceptOptions } from '../../../core/uploads/index.js';
import { parseAstValue, type AstMethod, type AstValue } from '../domain/ast-value.js';
import { evaluateBreakpoint, type BpBand, type BpRow, type BpSet, type BreakpointNoneReason, type BreakpointResult } from '../domain/breakpoint-eval.js';
import { assertFourEyes, assertTransition, type BpStatus } from '../domain/breakpoint-set.state.js';
import { issueDto, rowDto, setDto } from '../mappers/breakpoint.mappers.js';
import * as repo from '../repository/breakpoints.repo.js';
import * as cfg from '../repository/config.repo.js';

export interface BreakpointCtx {
  readonly tenantId: string; readonly actor: { readonly id: string }; readonly tx: unknown;
  readonly uploads: { accept(file: IncomingFile, opts: UploadAcceptOptions): Promise<{ objectPath: string; sha256: string; byteSize: number }> };
  readonly storage: { delete(bucket: 'micro-imports', path: string): Promise<void> };
  readonly audit: { access(e: object): Promise<void> };
  readonly core?: { user?(ctx: unknown, i: { userId: string }): Promise<{ displayName: string }> };
  readonly now?: () => Date;
  readonly ports?: { IdentityPort?: { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown> } };
}
type Row = Record<string, any>;
type Obj = Record<string, unknown>;
export type Page = { limit: number; next_cursor?: string };

export const BUCKET = 'micro-imports' as const;
export const MAX_BYTES = 5_242_880;   // 5 MiB [CONV] (TRD §5 M42)
const JOB = 'micro.breakpoint_import_validate';
const STANDARDS = ['CLSI', 'EUCAST', 'ECOFF'] as const;
const STATUSES = ['uploaded', 'validating', 'validated', 'invalid', 'active', 'retired', 'discarded'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CODE = /^[a-z0-9_]{2,64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path: string, message = 'Field invalid', code = 'common.field_invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const str = (v: unknown, p: string, min: number, max: number): string => (typeof v === 'string' && v.length >= min && v.length <= max ? v : fail(p));
const need = (o: Obj, k: string, p: string): unknown => (o[k] === undefined ? fail(p, 'Field required', 'common.field_required') : o[k]);
function strict(o: Obj, allowed: readonly string[], base = ''): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${base}/${k.slice(0, 64)}`, 'Unknown field', 'common.unknown_field');
}
function scope(c: BreakpointCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  return { tx: c.tx, tenantId: c.tenantId, userId: c.actor.id };
}
const pgState = (e: unknown): string | undefined => { const x = e as { code?: unknown; sqlState?: unknown } | null; return typeof x?.code === 'string' ? x.code : typeof x?.sqlState === 'string' ? x.sqlState : undefined; };
const invalidImport = (detail: string): LimsError => new LimsError('micro.breakpoint_import_invalid', detail);

// ---------------------------------------------------------------- display names (TRD §5.4: ctx.core.user, never IdentityPort.getActor)
async function userDisplay(c: BreakpointCtx, memo: Map<string, string>, userId: unknown, fallback: unknown): Promise<string> {
  const given = typeof fallback === 'string' && fallback.length > 0 ? fallback.slice(0, 200) : '—';
  if (typeof userId !== 'string') return given;
  const hit = memo.get(userId);
  if (hit !== undefined) return hit;
  let name = given;
  if (typeof c.core?.user === 'function') name = await c.core.user(c, { userId }).then((u) => (u.displayName.length > 0 ? u.displayName.slice(0, 200) : '—'), () => given);
  memo.set(userId, name);
  return name;
}
async function toDto(c: BreakpointCtx, memo: Map<string, string>, row: Row): Promise<Obj> {
  const importedBy = await userDisplay(c, memo, row['created_by'], row['imported_by_display']);
  const activatedBy = row['activated_by'] != null || row['activated_by_display'] != null ? await userDisplay(c, memo, row['activated_by'], row['activated_by_display']) : undefined;
  return setDto(row, { importedBy, activatedBy });
}

// ---------------------------------------------------------------- query parsing + cursors
function limitOf(v: unknown): number {
  if (v === undefined) return 50;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : fail('/limit');
}
const cursorIn = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !CURSOR.test(v)) throw new LimsError('common.invalid_cursor');
  return v;
};
const encode = (a: unknown, id: string): string => Buffer.from(JSON.stringify([a, id]), 'utf8').toString('base64url');
function decode(raw: string): [unknown, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && UUID.test(v[1])) return [v[0], v[1]];
  } catch { /* fall through */ }
  throw new LimsError('common.invalid_cursor');
}
function lineCursor(raw: string | undefined): { lineNo: number; id: string } | undefined {
  if (raw === undefined) return undefined;
  const [n, id] = decode(raw);
  if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > 1_000_000) throw new LimsError('common.invalid_cursor');
  return { lineNo: n as number, id };
}
const queryOf = (q: unknown, allowed: readonly string[]): Obj => { const o = q === undefined || q === null ? {} : isObj(q) ? q : fail('/'); strict(o, allowed); return o; };
const setIdOf = (params: unknown): string => {
  const v = isObj(params) ? params['set_id'] : undefined;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : fail('/set_id');
};
async function ownSet(c: BreakpointCtx, tenantId: string, id: string): Promise<Row> {
  const row = await repo.getSet(c.tx as any, { tenantId, id });
  if (!row) throw new LimsError('common.not_found');   // S-01: same answer for missing and another tenant's set
  return row;
}

// ================================================================ M41 / M43
export async function listSets(c: BreakpointCtx, input: { query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scope(c);
  const q = queryOf(input.query, ['standard', 'status', 'cursor', 'limit']);
  const standard = q['standard'] === undefined ? undefined : (STANDARDS as readonly unknown[]).includes(q['standard']) ? (q['standard'] as string) : fail('/standard');
  let statuses: string[] | undefined;
  if (q['status'] !== undefined) {
    const parts = typeof q['status'] === 'string' ? q['status'].split(',') : fail('/status');
    statuses = parts.every((s) => (STATUSES as readonly string[]).includes(s)) && parts.length <= STATUSES.length ? parts : fail('/status');
  }
  const limit = limitOf(q['limit']);
  const raw = cursorIn(q['cursor']);
  let cursor: repo.SetCursor | undefined;
  if (raw !== undefined) {
    const [ms, id] = decode(raw);
    if (typeof ms !== 'string' || !ISO_UTC.test(ms)) throw new LimsError('common.invalid_cursor');
    cursor = { ms, id };
  }
  const rows = await repo.listSets(tx, { tenantId, standard, statuses, cursor, limit });
  const page = rows.slice(0, limit);
  const memo = new Map<string, string>();
  const data: Obj[] = [];
  for (const r of page) data.push(await toDto(c, memo, r));
  const info: Page = { limit };
  const last = page[page.length - 1];
  if (rows.length > limit && last) info.next_cursor = encode(new Date(last['created_at']).toISOString(), last['id']);
  return { data, page: info };
}

export async function getSet(c: BreakpointCtx, input: { params: unknown }): Promise<Obj> {
  const { tenantId } = scope(c);
  const row = await ownSet(c, tenantId, setIdOf(input.params));
  return toDto(c, new Map(), row);
}

// ================================================================ M44 / M45
export async function listIssues(c: BreakpointCtx, input: { params: unknown; query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scope(c);
  const setId = setIdOf(input.params);
  const q = queryOf(input.query, ['severity', 'cursor', 'limit']);
  const severity = q['severity'] === undefined ? undefined : q['severity'] === 'error' || q['severity'] === 'warning' ? q['severity'] : fail('/severity');
  const limit = limitOf(q['limit']);
  const cursor = lineCursor(cursorIn(q['cursor']));
  await ownSet(c, tenantId, setId);
  const rows = await repo.listIssues(tx, { tenantId, setId, severity, cursor, limit });
  const page = rows.slice(0, limit);
  const info: Page = { limit };
  const last = page[page.length - 1];
  if (rows.length > limit && last) info.next_cursor = encode(last['line_no'] ?? 0, last['id']);
  return { data: page.map(issueDto), page: info };
}

export async function listRows(c: BreakpointCtx, input: { params: unknown; query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scope(c);
  const setId = setIdOf(input.params);
  const q = queryOf(input.query, ['antibiotic_code', 'organism_code', 'cursor', 'limit']);
  const codeQ = (k: string): string | undefined => (q[k] === undefined ? undefined : typeof q[k] === 'string' && CODE.test(q[k] as string) ? (q[k] as string) : fail(`/${k}`));
  const antibioticCode = codeQ('antibiotic_code');
  const organismCode = codeQ('organism_code');
  const limit = limitOf(q['limit']);
  const cursor = lineCursor(cursorIn(q['cursor']));
  await ownSet(c, tenantId, setId);
  const rows = await repo.listRows(tx, { tenantId, setId, antibioticCode, organismCode, cursor, limit });
  const page = rows.slice(0, limit);
  const bands = await repo.bandsOf(tx, { tenantId, setId, rowIds: page.map((r) => r['id'] as string) });
  const info: Page = { limit };
  const last = page[page.length - 1];
  if (rows.length > limit && last) info.next_cursor = encode(last['line_no'], last['id']);
  return { data: page.map((r) => rowDto(r, bands.filter((b) => b['row_id'] === r['id']))), page: info };
}

// ================================================================ M42
interface Meta { standard: string; standardVersion: string; title: string; licence: string; intendedEffectiveFrom: string | null }
function parseMeta(v: unknown): Meta {
  let m: unknown = v;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return fail('/metadata'); } }   // a multipart text part may arrive unparsed
  if (!isObj(m)) return fail('/metadata');
  strict(m, ['standard', 'standard_version', 'title', 'licence_attestation_text', 'intended_effective_from'], '/metadata');
  const standard = need(m, 'standard', '/metadata/standard');
  if (!(STANDARDS as readonly unknown[]).includes(standard)) fail('/metadata/standard');
  let intended: string | null = null;
  if (m['intended_effective_from'] !== undefined) {
    const s = m['intended_effective_from'];
    intended = typeof s === 'string' && ISO_UTC.test(s) && !Number.isNaN(Date.parse(s)) ? s : fail('/metadata/intended_effective_from');
  }
  return {
    standard: standard as string,
    standardVersion: str(need(m, 'standard_version', '/metadata/standard_version'), '/metadata/standard_version', 1, 32),
    title: str(need(m, 'title', '/metadata/title'), '/metadata/title', 1, 120),
    licence: str(need(m, 'licence_attestation_text', '/metadata/licence_attestation_text'), '/metadata/licence_attestation_text', 20, 500),
    intendedEffectiveFrom: intended,
  };
}
function parseFile(v: unknown): IncomingFile {
  if (!isObj(v)) return fail('/file', 'Field required', 'common.field_required');
  strict(v, ['filename', 'mimeType', 'bytes'], '/file');
  if (!(v['bytes'] instanceof Uint8Array)) return fail('/file/bytes');
  return { filename: str(v['filename'], '/file/filename', 1, 255), mimeType: str(v['mimeType'], '/file/mimeType', 1, 255), bytes: v['bytes'] };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** NUL byte or not valid UTF-8 -> 422. Only for a file that claims to be a .csv of type text/csv: anything else is the 415 of ctx.uploads.accept. */
function assertCsvText(f: IncomingFile): void {
  const claimsCsv = /\.csv$/i.test(f.filename.split(/[\\/]/).pop() ?? '') && f.mimeType.split(';')[0]!.trim().toLowerCase() === 'text/csv';
  if (!claimsCsv) return;
  if (f.bytes.includes(0)) throw invalidImport('file is not text');
  try { utf8.decode(f.bytes); } catch { throw invalidImport('file is not UTF-8'); }
}

export async function createImport(c: BreakpointCtx, input: { body: unknown }): Promise<{ body: Obj; version: number }> {
  const { tx, tenantId, userId } = scope(c);
  const b = isObj(input.body) ? input.body : fail('/');
  strict(b, ['metadata', 'file']);
  const meta = parseMeta(need(b, 'metadata', '/metadata'));
  const file = parseFile(need(b, 'file', '/file'));

  if (file.bytes.length > MAX_BYTES) throw new LimsError('common.payload_too_large');   // S-12: before hashing or storing anything
  assertCsvText(file);
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  if (await repo.findLiveBySha(tx, { tenantId, standard: meta.standard, sha256 })) throw invalidImport('duplicate file');

  const id = uuidv7();
  const objectPath = `${tenantId}/breakpoints/${id}.csv`;
  const up = await c.uploads.accept(file, { allow: ['text/csv'], maxBytes: MAX_BYTES, bucket: BUCKET, objectPath, scan: 'not_applicable' });
  try {
    let row: Row;
    try {
      row = await repo.insertSet(tx, {
        id, tenantId, userId, standard: meta.standard, standardVersion: meta.standardVersion, title: meta.title, licence: meta.licence,
        bucket: BUCKET, objectPath: up.objectPath, sha256: up.sha256, bytes: up.byteSize, intendedEffectiveFrom: meta.intendedEffectiveFrom,
      });
    } catch (e) {
      if (pgState(e) === '23505') throw invalidImport('duplicate file');   // lost the race against an identical upload (partial unique index)
      throw e;
    }
    await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [JOB, JSON.stringify({ tenant_id: tenantId, set_id: id }), id]);
    await c.audit.access({ action: 'breakpoint_set.import', entityType: 'micro_breakpoint_set', entityId: id, outcome: 'allowed' });
    const dto = await toDto(c, new Map(), row);
    return { body: dto, version: row['version'] };
  } catch (e) {
    await c.storage.delete(BUCKET, up.objectPath).catch(() => undefined);   // the request tx rolls back: leave no orphan object
    throw e;
  }
}

// ================================================================ T-13 lifecycle M46–M48 (03-APP-FLOW §2.5 B4–B6; PRD AC-13.1–13.3, AC-07.6; 07-SECURITY S-10, S-11, T-B2)
// [CONV] atomicity = the request transaction. Order: validate input (400) -> If-Match present (428) -> read the set (404, tenant-bound) -> state (409 invalid
// transition) -> version (409) -> four eyes (403): all of it BEFORE the first write, so a refused request leaves nothing behind (not even the lazy settings row).
// Activation and retirement then take the tenant's micro.settings row FOR UPDATE (03-APP-FLOW §2.5 serialisation) and re-check the set under that lock,
// because a parallel request may have changed it in between; the UPDATEs themselves keep `version` / `status` in the WHERE as the last guard.
const clock = (c: BreakpointCtx): Date => (typeof c.now === 'function' ? c.now() : new Date());
const BACKDATE_MS = 60_000;   // M46: an explicit or intended effective_from may be at most 60 s in the past
const conflict = (): never => { throw new LimsError('common.version_conflict'); };
function needVersion(v: number | undefined): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  return Number.isSafeInteger(v) && v >= 1 ? v : fail('/If-Match');
}
function bodyOf(v: unknown, allowed: readonly string[]): Obj {
  const o = v === undefined ? {} : isObj(v) ? v : fail('/');
  strict(o, allowed);
  return o;
}
/** Status first (a set that already moved on is an invalid transition for everybody), then the If-Match version. */
function assertState(row: Row, to: BpStatus, version: number): void {
  assertTransition(row['status'] as BpStatus, to);
  if (row['version'] !== version) conflict();
}
async function present(c: BreakpointCtx, row: Row): Promise<{ body: Obj; version: number }> {
  return { body: await toDto(c, new Map(), row), version: row['version'] };
}

export async function activate(c: BreakpointCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<{ body: Obj; version: number }> {
  const { tx, tenantId, userId } = scope(c);
  const setId = setIdOf(input.params);
  const b = bodyOf(input.body, ['effective_from']);
  const now = clock(c);
  const floor = now.getTime() - BACKDATE_MS;
  let explicit: Date | undefined;
  if (b['effective_from'] !== undefined) {
    const s = b['effective_from'];
    explicit = typeof s === 'string' && ISO_UTC.test(s) && !Number.isNaN(Date.parse(s)) ? new Date(s) : fail('/effective_from');
    if (explicit.getTime() < floor) fail('/effective_from');
  }
  const version = needVersion(input.ifMatch);

  const seen = await ownSet(c, tenantId, setId);
  assertState(seen, 'active', version);
  assertFourEyes({ actorId: userId, createdBy: seen['created_by'] });   // S-11: the importer never activates their own import

  // intended_effective_from is honoured unless it is further back than the 60 s window; never back-dated otherwise (M46).
  const intended = seen['intended_effective_from'] == null ? null : new Date(seen['intended_effective_from']);
  const effectiveFrom = explicit ?? (intended !== null && intended.getTime() >= floor ? intended : now);

  await repo.lockSettings(tx, { tenantId, userId, id: uuidv7() });
  const cur = await ownSet(c, tenantId, setId);   // re-check under the lock
  assertState(cur, 'active', version);
  await repo.closeActive(tx, { tenantId, standard: cur['standard'], exceptId: setId, effectiveTo: effectiveFrom.toISOString(), userId, now: now.toISOString() });
  const row = await repo.activateSet(tx, { tenantId, id: setId, version, userId, effectiveFrom: effectiveFrom.toISOString(), now: now.toISOString() });
  if (!row) return conflict();
  await c.audit.access({ action: 'breakpoint_set.activate', entityType: 'micro_breakpoint_set', entityId: setId, outcome: 'allowed' });
  return present(c, row);
}

export async function retire(c: BreakpointCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<{ body: Obj; version: number }> {
  const { tx, tenantId, userId } = scope(c);
  const setId = setIdOf(input.params);
  bodyOf(input.body, []);
  const version = needVersion(input.ifMatch);
  assertState(await ownSet(c, tenantId, setId), 'retired', version);

  await repo.lockSettings(tx, { tenantId, userId, id: uuidv7() });
  assertState(await ownSet(c, tenantId, setId), 'retired', version);
  const row = await repo.retireSet(tx, { tenantId, id: setId, version, userId, now: clock(c).toISOString() });
  if (!row) return conflict();
  await c.audit.access({ action: 'breakpoint_set.retire', entityType: 'micro_breakpoint_set', entityId: setId, outcome: 'allowed' });
  return present(c, row);
}

export async function discard(c: BreakpointCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<{ body: Obj; version: number }> {
  const { tx, tenantId, userId } = scope(c);
  const setId = setIdOf(input.params);
  bodyOf(input.body, []);
  const version = needVersion(input.ifMatch);
  assertState(await ownSet(c, tenantId, setId), 'discarded', version);
  // Rows / bands / issues are never touched (AC-13.4); the status guard in the UPDATE settles a race with the validation job (B2/B3).
  const row = await repo.discardSet(tx, { tenantId, id: setId, version, userId });
  if (!row) { assertState(await ownSet(c, tenantId, setId), 'discarded', version); return conflict(); }
  return present(c, row);
}

// ================================================================ T-13 lookup (TRD §4.5) + M13
export type LookupResult = BreakpointResult | { suggestion: 'none'; reason: BreakpointNoneReason | 'disabled' };
export interface LookupEntry { antibiotic_code: string; method: AstMethod; raw_value: string; qualifier_code?: string | undefined }
export interface LookupInput extends LookupEntry { organism_code: string | null; specimen_site_code?: string | null | undefined }
const NONE = (reason: BreakpointNoneReason | 'disabled'): LookupResult => ({ suggestion: 'none', reason });

/** One evaluation path for M13 and for M12 accept_suggestion (T-10 re-evaluates through this, never from a cache). Reads only; the clock is ctx.now(). */
async function lookupMany(c: BreakpointCtx, base: { organism_code: string | null; specimen_site_code: string | null }, entries: readonly LookupEntry[]): Promise<LookupResult[]> {
  const { tx, tenantId } = scope(c);
  const now = clock(c);
  const settings = await cfg.getSettings(tx, { tenantId });   // absent row = defaults (standard unset): never created here
  const standard: string | null = settings?.['manual_ast_standard'] ?? null;
  const enabled = (m: AstMethod): boolean =>
    standard !== null && (m === 'zone_diameter' ? (settings?.['zone_suggestion_enabled'] ?? true) === true : m === 'mic' ? (settings?.['mic_suggestion_enabled'] ?? false) === true : false);

  const out: (LookupResult | undefined)[] = entries.map(() => undefined);
  const todo: { i: number; e: LookupEntry; parsed: AstValue }[] = [];
  entries.forEach((e, i) => {
    if (!enabled(e.method)) { out[i] = NONE('disabled'); return; }
    const p = parseAstValue(e.raw_value, e.method);
    if (!p.ok) { out[i] = NONE('value_invalid'); return; }
    todo.push({ i, e, parsed: p.value });
  });
  if (todo.length > 0 && standard !== null) {
    const t = now.getTime();
    const sets: BpSet[] = (await repo.lookupSets(tx, { tenantId, standard }))
      .map((s) => ({ id: s['id'], standard: s['standard'], standard_version: s['standard_version'], status: s['status'], effective_from: new Date(s['effective_from']), effective_to: s['effective_to'] == null ? null : new Date(s['effective_to']) }))
      .filter((s) => s.effective_from.getTime() <= t && (s.effective_to === null || t < s.effective_to.getTime()));   // only the sets valid at t are read further
    let rows: BpRow[] = []; let bands: BpBand[] = [];
    if (sets.length > 0 && base.organism_code !== null) {
      rows = (await repo.lookupRows(tx, { tenantId, setIds: sets.map((s) => s.id), antibioticCodes: [...new Set(todo.map((x) => x.e.antibiotic_code))] })) as BpRow[];
      if (rows.length > 0) bands = (await repo.lookupBands(tx, { tenantId, rowIds: rows.map((r) => r.id) })) as BpBand[];
    }
    const group = sets.length > 0 && base.organism_code !== null ? await repo.groupOf(tx, { code: base.organism_code }) : null;
    for (const { i, e, parsed } of todo) {
      const r = evaluateBreakpoint({ now, standard, sets, rows, bands, request: {
        antibiotic_code: e.antibiotic_code, method: e.method, qualifier_code: e.qualifier_code ?? null, parsed,
        organism_code: base.organism_code ?? '', organism_group_code: group, specimen_site_code: base.specimen_site_code } });
      // An isolate without an organism has no row to match (an `any` row would be a guess): no_row, but never hide a missing set.
      out[i] = base.organism_code === null && r.suggestion !== 'none' ? NONE('no_row') : r;
    }
  }
  return out.map((r) => r ?? NONE('no_active_set'));
}

export async function lookup(c: BreakpointCtx, input: LookupInput): Promise<LookupResult> {
  const [r] = await lookupMany(c, { organism_code: input.organism_code, specimen_site_code: input.specimen_site_code ?? null }, [input]);
  return r!;
}

const METHODS = ['mic', 'zone_diameter', 'other'] as const;
function parseEntries(v: unknown): LookupEntry[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 60) return fail('/entries');
  return v.map((raw, i) => {
    const p = `/entries/${i}`;
    if (!isObj(raw)) return fail(p);
    strict(raw, ['antibiotic_code', 'method', 'raw_value', 'qualifier_code'], p);
    const code = (k: string): string => { const x = need(raw, k, `${p}/${k}`); return typeof x === 'string' && CODE.test(x) ? x : fail(`${p}/${k}`); };
    const method = need(raw, 'method', `${p}/method`);
    if (!(METHODS as readonly unknown[]).includes(method)) fail(`${p}/method`);
    return {
      antibiotic_code: code('antibiotic_code'), method: method as AstMethod, raw_value: str(need(raw, 'raw_value', `${p}/raw_value`), `${p}/raw_value`, 1, 32),
      ...(raw['qualifier_code'] === undefined ? {} : { qualifier_code: code('qualifier_code') }),
    };
  });
}

/** M13: suggestions only. No write, no event, no access_log row (TRD §5 M13 "none (no state)"). */
export async function previewInterpretation(c: BreakpointCtx, input: { params: unknown; body: unknown }): Promise<Obj> {
  const { tx, tenantId } = scope(c);
  const isolateId = isObj(input.params) && typeof input.params['isolate_id'] === 'string' && UUID.test(input.params['isolate_id']) ? input.params['isolate_id'].toLowerCase() : fail('/isolate_id');
  const b = isObj(input.body) ? input.body : fail('/');
  strict(b, ['entries']);
  const entries = parseEntries(need(b, 'entries', '/entries'));
  const isolate = await repo.isolateOf(tx, { tenantId, id: isolateId });
  if (!isolate) throw new LimsError('common.not_found');   // S-01: unknown and another tenant's isolate answer the same
  // 02-TRD §13: object first, then permission with the object's centre_id (isolates are centre-scoped). The handler's tenant-level check stays.
  const identity = c.ports?.IdentityPort;
  if (!identity) throw new LimsError('auth.forbidden');    // fail closed
  await identity.assertRole(c, { permission: 'micro.culture.work', centreId: isolate['centre_id'] });
  const site = isolate['culture_id'] == null ? null : await repo.cultureSite(tx, { tenantId, id: isolate['culture_id'] });
  const res = await lookupMany(c, { organism_code: isolate['organism_code'] ?? null, specimen_site_code: site }, entries);
  return {
    results: entries.map((e, i) => {
      const r = res[i]!;
      return r.suggestion === 'none' ? { antibiotic_code: e.antibiotic_code, method: e.method, reason: r.reason } : { antibiotic_code: e.antibiotic_code, method: e.method, suggestion: r.suggestion };
    }),
  };
}
