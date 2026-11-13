// C13 T08 — manifest drafting, partner side: M1–M7, M10, P2 (02-TRD §5.2; 03-APP-FLOW §2.1 MS1/MS4, §4.1 M1/M5; US-04.1/.2/.3/.7/.8).
// Order in every operation: partnerContext.require (actor type, active partner) -> IdentityPort.assertRole -> If-Match shape -> manifest row lock (bound by
// tenant + partner from the token, so a foreign / unknown id is the same common.not_found) -> If-Match version (409) -> draft-only (409) -> validation -> writes.
// The manifest FOR UPDATE lock serialises writers of one manifest: a second writer with the same If-Match waits, then sees the bumped version and gets 409.
// created_by / updated_by come from ctx.actor only. Nothing submitted (name, phone, ref, note, orderable id) is ever echoed in an error or logged.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { HandlerContext, HandlerResult } from '../../../core/module.js';
import { validateLine, type LineContext, type LineIssue } from '../domain/line-validation.js';
import { formatManifestNo, manifestYy } from '../domain/manifest-number.js';
import { assertEditable, assertTransition, MANIFEST_STATES, type ManifestState } from '../domain/manifest.state.js';
import { toLineDto, toManifestDto, toManifestSummaryDto, toPriceListItemDto, type CentreName } from '../mappers/manifest.dto.js';
import * as counters from '../repository/counters.repo.js';
import * as lines from '../repository/manifest-lines.repo.js';
import * as manifests from '../repository/manifests.repo.js';
import { partnerContext } from './partner-context.service.js';

type Row = Record<string, any>;
type Req = { params?: unknown; query?: unknown; headers?: unknown; body?: unknown };
type Core = { centre(c: unknown, i: { centreId: string }): Promise<{ id: string; name: string }>; tenant(c: unknown): Promise<{ timezone: string }> };

const SUBMIT = 'partners.manifest.submit'; // M1, M4–M7, M10, P2
const READ = 'partners.order.read'; // M2, M3
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_VERSION = 2147483647;
const MAX_LINE_NO = 200; // 05-SCHEMA manifest_lines__line_no__ck

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const notFound = (): never => { throw new LimsError('common.not_found'); };
const invalid = (): never => { throw new LimsError('common.validation_failed'); };
const body = (req: Req): Record<string, unknown> => (isObj(req.body) ? req.body : {});
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

async function gate(ctx: HandlerContext, permission: string): Promise<counters.Scope> {
  const ref = await partnerContext.require(ctx); // staff actor / non-active partner are refused here, before any write
  await ctx.ports.IdentityPort.assertRole(ctx, { permission });
  return { tx: ctx.tx as counters.Q, tenantId: ctx.tenantId as string, partnerId: ref.partnerId, actorId: ctx.actor!.id };
}

/** [CONV] If-Match "<n>" as T07: missing -> 428, malformed -> 400. */
function ifMatch(req: Req): number {
  const h = isObj(req.headers) ? req.headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) return invalid();
  return Number(m[1]);
}
const param = (req: Req, name: string): string => { const v = isObj(req.params) ? req.params[name] : undefined; return typeof v === 'string' && v !== '' ? v : notFound(); };
// a non-uuid path id can never match a row; answering 404 here keeps the pg uuid cast from turning it into a 500
const pathId = (req: Req, name: string): string => { const v = param(req, name); return UUID.test(v) ? v : notFound(); };

const centreOf = async (ctx: HandlerContext, centreId: string): Promise<CentreName> => {
  const c = await (ctx.core as unknown as Core).centre(ctx, { centreId });
  return { id: c.id, name: c.name };
};

async function lockManifest(s: counters.Scope, id: string): Promise<Row> { return (await manifests.lock(s, id)) ?? notFound(); }
const checkVersion = (row: Row, expected: number): void => { if (Number(row['version']) !== expected) throw new LimsError('common.version_conflict'); };
const conflict = (): never => { throw new LimsError('common.version_conflict'); };

/** Manifest + lines DTO (M1, M3, M4, M10). */
async function fullDto(ctx: HandlerContext, s: counters.Scope, m: Row): Promise<ReturnType<typeof toManifestDto>> {
  const [centre, ls, counts] = await Promise.all([centreOf(ctx, m['receiving_centre_id']), lines.listByManifest(s, m['id']), m['state'] === 'draft' ? undefined : manifests.lineCounts(s, [m['id']])]);
  const names = await referrerNames(s, ls);
  return toManifestDto(m, centre, counts?.get(m['id']) ?? { converted: 0, failed: 0 }, ls.map((l) => toLineDto(l, names.get(l['referrer_id']))));
}
async function referrerNames(s: counters.Scope, ls: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(ls.map((l) => l['referrer_id']).filter(isUuid))];
  return new Map((await lines.referrers(s, ids)).map((r) => [r['id'] as string, r['display_name'] as string]));
}

// ---- M1 ----
export async function create(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, SUBMIT);
  const b = body(req);
  const notes = b['notes'] === undefined ? null : typeof b['notes'] === 'string' && b['notes'].length <= 500 ? b['notes'] : invalid();
  const collectedOn = b['collected_on'] === undefined ? null : typeof b['collected_on'] === 'string' && ISO_DAY.test(b['collected_on']) && !Number.isNaN(Date.parse(b['collected_on'])) ? b['collected_on'] : invalid();
  const snap = (await manifests.partnerSnapshot(s)) ?? notFound(); // branch / centre / mode are copied from the partner, never from the request (MS1)
  const tz = (await (ctx.core as unknown as Core).tenant(ctx)).timezone;
  const yy = manifestYy(new Date(ctx.now()), tz); // A.D. year in the TENANT timezone
  const seq = await counters.nextSeq(s, Number(yy)); // ONE atomic upsert; gaps are allowed (a rolled-back request burns nothing: same tx)
  const row = await manifests.insert(s, { id: uuidv7(), manifestNo: formatManifestNo(yy, seq), branchId: snap['receiving_branch_id'], centreId: snap['receiving_centre_id'], mode: snap['conversion_mode'], notes, collectedOn }); // ponytail: seq > 999999 in a year throws RangeError -> 500
  return { status: 201, body: await fullDto(ctx, s, row) };
}

// ---- M2 ----
const encodeCursor = (sort: string, k: string, i: string): string => Buffer.from(JSON.stringify({ v: 1, s: sort, k, i })).toString('base64url');
function decodeCursor(raw: unknown, sort: string): { key: string; id: string } {
  const bad = (): never => { throw new LimsError('common.invalid_cursor'); };
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return bad();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return bad(); }
  if (!isObj(o) || o['v'] !== 1 || o['s'] !== sort || typeof o['k'] !== 'string' || !ISO_US.test(o['k']) || typeof o['i'] !== 'string' || !UUID.test(o['i'])) return bad();
  return { key: o['k'], id: o['i'] };
}
const instant = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : invalid());

export async function list(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, READ);
  const q = isObj(req.query) ? req.query : {};
  const states = q['state'] === undefined ? undefined : String(q['state']).split(',');
  if (states && !states.every((x) => (MANIFEST_STATES as readonly string[]).includes(x))) invalid();
  const sort = q['sort'] === '-submitted_at' ? 'submitted_at' : 'created_at';
  const n = Number(q['limit']);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], sort);
  const rows = await manifests.list(s, { ...(states ? { states } : {}), ...(instant(q['created_at_from']) ? { from: instant(q['created_at_from'])! } : {}), ...(instant(q['created_at_to']) ? { to: instant(q['created_at_to'])! } : {}), sort, ...(cursor ? { cursor } : {}), limit });
  const page = rows.slice(0, limit);
  const counts = await manifests.lineCounts(s, page.filter((r) => r['state'] !== 'draft').map((r) => r['id']));
  const centres = new Map<string, CentreName>();
  for (const r of page) if (!centres.has(r['receiving_centre_id'])) centres.set(r['receiving_centre_id'], await centreOf(ctx, r['receiving_centre_id']));
  const last = rows.length > limit ? page[page.length - 1] : undefined;
  const keyOf = (r: Row): string => String(r[`${sort === 'created_at' ? 'created' : 'submitted'}_key`] ?? new Date(r[sort]).toISOString());
  return { status: 200, body: {
    data: page.map((r) => toManifestSummaryDto(r, centres.get(r['receiving_centre_id'])!, counts.get(r['id']))),
    page: { limit, ...(last ? { next_cursor: encodeCursor(sort, keyOf(last), last['id']) } : {}) },
  } };
}

// ---- M3 ----
export async function get(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, READ);
  const m = (await manifests.get(s, pathId(req, 'manifest_id'))) ?? notFound();
  return { status: 200, body: await fullDto(ctx, s, m) };
}

// ---- M4 ----
export async function update(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, SUBMIT);
  const expected = ifMatch(req);
  const id = pathId(req, 'manifest_id');
  const b = body(req);
  const m = await lockManifest(s, id);
  checkVersion(m, expected);
  assertEditable(m['state'] as ManifestState);
  const sets: string[] = []; const extra: unknown[] = [];
  const set = (col: string, v: unknown, cast = ''): void => { extra.push(v); sets.push(`${col} = $${5 + extra.length}${cast}`); };
  const unset = b['unset'] === undefined ? [] : Array.isArray(b['unset']) ? b['unset'] : invalid();
  for (const u of unset as unknown[]) { // only the nullable columns
    if ((u !== 'notes' && u !== 'collected_on') || b[u] !== undefined) invalid();
    if (!sets.some((x) => x.startsWith(`${u} =`))) sets.push(`${u} = NULL`);
  }
  if (b['notes'] !== undefined) { if (typeof b['notes'] !== 'string' || b['notes'].length > 500) invalid(); set('notes', b['notes']); }
  if (b['collected_on'] !== undefined) { if (typeof b['collected_on'] !== 'string' || !ISO_DAY.test(b['collected_on']) || Number.isNaN(Date.parse(b['collected_on']))) invalid(); set('collected_on', b['collected_on'], '::date'); }
  if (sets.length === 0) invalid(); // state, partner_id, manifest_no, version, snapshot columns are never settable here (AB11)
  const row = (await manifests.change(s, id, expected, sets, extra)) ?? conflict();
  return { status: 200, body: await fullDto(ctx, s, row) };
}

// ---- line input / validation (M5, M6) ----
/** wire (snake_case) -> the camelCase shape domain/line-validation.ts reads. Only the documented fields are copied: nothing else can reach a column. */
function lineInput(raw: unknown): Record<string, unknown> {
  const b = isObj(raw) ? raw : {};
  const p = b['patient']; const c = b['consents'];
  return {
    partnerSampleRef: b['partner_sample_ref'], priority: b['priority'], orderableIds: b['orderable_ids'], referrerId: b['referrer_id'], collectedAt: b['collected_at'], clinicalNote: b['clinical_note'],
    patient: isObj(p) ? { fullName: p['full_name'], sex: p['sex'], birthOn: p['birth_on'], ageYears: p['age_years'], phoneE164: p['phone_e164'] } : p,
    consents: isObj(c) ? { sms: c['sms'], whatsapp: c['whatsapp'], email: c['email'], shareWithReferrer: c['share_with_referrer'] } : c,
  };
}

const MESSAGES: Record<string, string> = { 'common.validation_failed': 'Invalid value.', 'partners.orderable_not_offered': 'Not offered to this partner.', 'partners.manifest_invalid': 'Not allowed for this manifest.' };
/** Issues -> one LimsError. Another partner's / unknown referrer = 404 (never revealed); no submitted value is echoed. */
function raise(issues: LineIssue[]): never {
  if (issues.some((i) => i.code === 'common.not_found')) return notFound();
  const code = ['common.validation_failed', 'partners.orderable_not_offered', 'partners.manifest_invalid'].find((c) => issues.some((i) => i.code === c)) ?? 'common.validation_failed';
  const errors: FieldError[] = issues.filter((i) => i.code === code).map((i) => ({ path: i.path, code: code === 'common.validation_failed' ? 'common.field_invalid' : code, message: MESSAGES[code]! }));
  throw new LimsError(code, undefined, errors);
}

const todayIn = (now: Date, timeZone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Validates a line against the partner's own price list / referrers / this manifest; returns the column values. */
async function validated(ctx: HandlerContext, s: counters.Scope, m: Row, input: Record<string, unknown>, adding: boolean, ownLineId?: string): Promise<{ values: lines.LineValues; referrerName: string | undefined }> {
  const settings = await lines.settings(s);
  const ids = Array.isArray(input['orderableIds']) ? [...new Set((input['orderableIds'] as unknown[]).filter(isUuid))].slice(0, 30) : [];
  const offered = new Map((await lines.priceItems(s, ids)).filter((r) => r['source'] === 'partner' || settings.includeDefault).map((r) => [r['orderable_id'] as string, r]));
  const refId = input['referrerId'];
  const refRows = isUuid(refId) ? await lines.referrers(s, [refId]) : [];
  const sampleRef = input['partnerSampleRef'];
  const holders = typeof sampleRef === 'string' ? await lines.idsWithSampleRef(s, m['id'], sampleRef) : [];
  const tz = (await (ctx.core as unknown as Core).tenant(ctx)).timezone;
  const now = new Date(ctx.now());
  const lineCtx: LineContext = {
    today: todayIn(now, tz), now, offeredOrderableIds: new Set(offered.keys()),
    referrers: new Map(refRows.map((r) => [r['id'] as string, { isActive: r['is_active'] === true }])),
    otherSampleRefs: new Set(typeof sampleRef === 'string' && holders.some((h) => h !== ownLineId) ? [sampleRef] : []),
    adding, lineCountBefore: Number(m['line_count']), maxLines: settings.maxLines,
  };
  const issues = validateLine(input, lineCtx);
  if (issues.length > 0) raise(issues);
  const p = input['patient'] as Row; const c = input['consents'] as Row; const order = input['orderableIds'] as string[];
  return {
    referrerName: refRows[0]?.['display_name'],
    values: {
      ref: (sampleRef as string | undefined) ?? null, name: p['fullName'], sex: p['sex'], birthOn: p['birthOn'] ?? null, ageYears: p['ageYears'] ?? null, phone: p['phoneE164'] ?? null,
      sms: c['sms'], whatsapp: c['whatsapp'], email: c['email'], share: c['shareWithReferrer'], consentVersion: settings.consentVersion,
      orderableIds: order, snapshot: order.map((o) => { const r = offered.get(o)!; return { orderable_id: o, kind: r['kind'], code: r['code'], name: r['name'] }; }),
      priority: input['priority'] as string, referrerId: (refId as string | undefined) ?? null, collectedAt: (input['collectedAt'] as string | undefined) ?? null, clinicalNote: (input['clinicalNote'] as string | undefined) ?? null,
    },
  };
}
/** DB unique index on (manifest, partner_sample_ref) / (manifest, line_no) lost a race: 422, never a raw 23505. */
const uniqueAsInvalid = (e: unknown): never => {
  if ((e as { code?: string })?.code === '23505') throw new LimsError('partners.manifest_invalid', undefined, [{ path: '/partner_sample_ref', code: 'partners.manifest_invalid', message: MESSAGES['partners.manifest_invalid']! }]);
  throw e;
};

// ---- M5 ----
export async function addLine(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, SUBMIT);
  const expected = ifMatch(req);
  const m = await lockManifest(s, pathId(req, 'manifest_id'));
  checkVersion(m, expected);
  assertEditable(m['state'] as ManifestState);
  const { values, referrerName } = await validated(ctx, s, m, lineInput(req.body), true);
  // the version-guarded UPDATE is the atomic gate: only the writer that wins it goes on to number and insert the line
  const bumped = (await manifests.change(s, m['id'], expected, ['line_count = line_count + 1'])) ?? conflict();
  const lineNo = (await lines.maxLineNo(s, m['id'])) + 1;
  if (lineNo > MAX_LINE_NO) raise([{ path: '/lines', code: 'partners.manifest_invalid' }]); // gaps from deleted lines can push MAX past the cap
  const row = await lines.insert(s, { id: m['id'], centreId: m['receiving_centre_id'] }, uuidv7(), lineNo, values).catch(uniqueAsInvalid);
  return { status: 201, body: toLineDto(row, referrerName), headers: { ETag: `"${bumped['version']}"` } };
}

// ---- M6 ----
export async function replaceLine(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, SUBMIT);
  const expected = ifMatch(req);
  const m = await lockManifest(s, pathId(req, 'manifest_id'));
  const cur = (await lines.lock(s, m['id'], pathId(req, 'line_id'))) ?? notFound();
  checkVersion(cur, expected);
  assertEditable(m['state'] as ManifestState);
  if (cur['state'] !== 'draft') throw new LimsError('partners.manifest_not_editable');
  const { values, referrerName } = await validated(ctx, s, m, lineInput(req.body), false, cur['id']);
  const row = (await lines.replace(s, m['id'], cur['id'], expected, values).catch(uniqueAsInvalid)) ?? conflict();
  return { status: 200, body: toLineDto(row, referrerName) };
}

// ---- M7 ----
export async function deleteLine(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, SUBMIT);
  const expected = ifMatch(req);
  const m = await lockManifest(s, pathId(req, 'manifest_id'));
  const cur = (await lines.lock(s, m['id'], pathId(req, 'line_id'))) ?? notFound();
  checkVersion(cur, expected);
  assertEditable(m['state'] as ManifestState); // DELETE only while the manifest is a draft: no DELETE is issued otherwise
  if (cur['state'] !== 'draft') throw new LimsError('partners.manifest_not_editable');
  if (!(await lines.remove(s, m['id'], cur['id'], expected))) conflict();
  await manifests.change(s, m['id'], Number(m['version']), ['line_count = line_count - 1']);
  return { status: 204 };
}

// ---- M10 ----
export async function discard(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, SUBMIT);
  const expected = ifMatch(req);
  const m = await lockManifest(s, pathId(req, 'manifest_id'));
  checkVersion(m, expected);
  assertTransition(m['state'] as ManifestState, 'discarded'); // only draft -> discarded (MS4); anything else 409 partners.manifest_invalid_transition
  const row = (await manifests.change(s, m['id'], expected, ["state = 'discarded'", 'discarded_at = now()'])) ?? conflict();
  await lines.discardDrafts(s, m['id']); // ponytail: patient fields are redacted later by the retention owner function (T21), not here
  return { status: 200, body: await fullDto(ctx, s, row) };
}

// ---- P2 ----
export async function searchOrderables(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await gate(ctx, SUBMIT);
  const q = isObj(req.query) ? req.query : {};
  const text = q['q'] === undefined ? undefined : typeof q['q'] === 'string' && q['q'].length >= 1 && q['q'].length <= 64 ? q['q'] : invalid();
  const n = Number(q['limit']);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 20) : 20;
  const { includeDefault } = await lines.settings(s);
  return { status: 200, body: { data: (await lines.searchPrice(s, text, includeDefault, limit)).map(toPriceListItemDto) } };
}
