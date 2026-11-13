// Culture reads M1 listCultures, M2 getCulture, M15 listCultureReportVersions, M16 getCultureReportVersion (02-TRD §5, §5.6, §13; PRD AC-02.1, AC-02.3, AC-02.4, AC-17.2;
// 07-SECURITY T-A1, T-F1, S-01, S-02, S-25, REQ-SEC-081). Tenant from ctx only; every statement binds it besides RLS (REQ-SEC-024). Reads write nothing.
// Permission: M1 asserts micro.culture.read first; M2/M15/M16 load the object first (not visible = 404, same as missing), then assert with the object's
// centre_id (02-CV §10.1). *_display via ctx.core.memberships.list (one batched call) / ctx.core.user (once per id); unknown = "—" (D-47).
// [CONV] default sort received_at; next_read_due_at sorts NULLS LAST; the cursor is bound to its sort; unknown status/sort value -> common.validation_failed.
// [CONV] antibiotic_display falls back to the code when the coded-set view has no row (field is required); organism_display is omitted then.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { selectPlatingProtocol } from '../domain/selection.js';
import * as dto from '../mappers/culture.dto.js';
import * as repo from '../repository/cultures.repo.js';

type Row = Record<string, any>;
type Obj = Record<string, unknown>;
export interface ChainCtx {
  readonly tenantId: string; readonly tx: unknown; readonly now?: () => Date;
  readonly audit: { access(e: object): Promise<void> };
  readonly core?: {
    user?(ctx: unknown, i: { userId: string }): Promise<{ displayName: string }>;
    memberships?: { list(ctx: unknown, i: { membershipIds: string[]; activeOnly: boolean }): Promise<{ membershipId: string; displayName: string }[]> };
  };
  readonly ports?: {
    IdentityPort?: { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown>; getActor(c: unknown): Promise<{ permissions: readonly string[] }> };
    CatalogPort?: { getTest(c: unknown, i: { testId: string }): Promise<{ code: string; name: string }> };
    LabPort?: { getOrderResults(c: unknown, i: { orderId: string; scope: 'all_visible' }): Promise<Row> };
  };
}

const READ = 'micro.culture.read';
const STATUSES = ['awaiting_setup', 'incubating', 'growth_detected', 'final_submitted', 'amending', 'cancelled'];
const SORTS: readonly repo.CultureSort[] = ['received_at', '-received_at', 'next_read_due_at', '-updated_at'];
const TOTAL_CAP = 10_000;   // 02-TRD §5 M1 [CONV], S-25
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const KEY_TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const QUERY_KEYS = ['status', 'specimen_id', 'order_id', 'centre_id', 'received_at_from', 'received_at_to', 'read_overdue', 'has_open_instrument_records',
  'updated_at_from', 'include_total', 'sort', 'cursor', 'limit'];

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path: string, message = 'Field invalid', code = 'common.field_invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
function scope(c: ChainCtx): { tx: any; tenantId: string } {
  if (typeof c?.tenantId !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  return { tx: c.tx, tenantId: c.tenantId };
}
function identity(c: ChainCtx): NonNullable<NonNullable<ChainCtx['ports']>['IdentityPort']> {
  const i = c.ports?.IdentityPort;
  if (!i) throw new LimsError('auth.forbidden');   // fail closed: no way to ask, so no
  return i;
}
const nowOf = (c: ChainCtx): Date => (typeof c.now === 'function' ? c.now() : new Date());

// ---------------------------------------------------------------- query parsing
const uuidQ = (q: Obj, k: string): string | undefined => (q[k] === undefined ? undefined : typeof q[k] === 'string' && UUID.test(q[k] as string) ? (q[k] as string).toLowerCase() : fail(`/${k}`));
/** A real calendar instant (round-trips), so a value like 2026-02-31 never reaches `::timestamptz` as a 500. */
const realInstant = (s: string): boolean => { const d = new Date(s.slice(0, 23) + 'Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 23) === s.slice(0, 23); };
const isoQ = (q: Obj, k: string): string | undefined => (q[k] === undefined ? undefined : typeof q[k] === 'string' && ISO_UTC.test(q[k] as string) && realInstant(q[k] as string) ? (q[k] as string) : fail(`/${k}`));
const boolQ = (q: Obj, k: string): boolean | undefined => {
  const v = q[k];
  return v === undefined ? undefined : v === true || v === 'true' ? true : v === false || v === 'false' ? false : fail(`/${k}`);
};
function limitOf(v: unknown): number {
  if (v === undefined) return 50;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : fail('/limit');
}
const encodeCursor = (sort: string, key: string | null, id: string): string => Buffer.from(JSON.stringify([sort, key, id]), 'utf8').toString('base64url');
function decodeCursor(raw: unknown, sort: repo.CultureSort): { key: string | null; id: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !CURSOR.test(raw)) throw new LimsError('common.invalid_cursor');
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 3 && v[0] === sort && typeof v[2] === 'string' && UUID.test(v[2])
      && ((typeof v[1] === 'string' && KEY_TS.test(v[1]) && realInstant(v[1])) || (v[1] === null && sort === 'next_read_due_at'))) return { key: v[1], id: v[2] };
  } catch { /* fall through */ }
  throw new LimsError('common.invalid_cursor');   // T-F1: nothing of the cursor is echoed
}
const SORT_COL: Record<repo.CultureSort, string> = { 'received_at': 'received_at', '-received_at': 'received_at', 'next_read_due_at': 'next_read_due_at', '-updated_at': 'updated_at' };
/** The row's sort key as microsecond UTC text: from SQL (sort_key) when present, else from the column. */
const keyOf = (row: Row, sort: repo.CultureSort): string | null => {
  if (typeof row['sort_key'] === 'string') return row['sort_key'];
  const v = row[SORT_COL[sort]];
  return v == null ? null : new Date(v).toISOString().replace('Z', '000Z');
};

// ---------------------------------------------------------------- lookups (request-memoised)
export function testLookup(c: ChainCtx): (testId: string) => Promise<{ code: string; name: string }> {
  const memo = new Map<string, Promise<{ code: string; name: string }>>();
  return (testId) => {
    let p = memo.get(testId);
    if (!p) {
      const port = c.ports?.CatalogPort;
      if (!port) throw new LimsError('common.internal');
      p = port.getTest(c, { testId }).then((t) => ({ code: t.code, name: t.name }));
      memo.set(testId, p);
    }
    return p;
  };
}
const clip = (s: unknown): string => (typeof s === 'string' && s.length > 0 ? s.slice(0, 200) : dto.NO_NAME);
const MEMBER_BATCH = 200;   // 02-TRD.md:317: core.memberships.list takes <= 200 ids per call
/** D-47: core.memberships.list { membershipIds, activeOnly: false } in slices of <= 200 ids; an id it does not return shows "—". */
export async function memberNames(c: ChainCtx, ids: unknown[]): Promise<(id: unknown) => string> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
  const wanted = new Set(want);
  const names = new Map<string, string>();
  for (let i = 0; c.core?.memberships && i < want.length; i += MEMBER_BATCH) {
    for (const m of await c.core.memberships.list(c, { membershipIds: want.slice(i, i + MEMBER_BATCH), activeOnly: false })) if (wanted.has(m.membershipId)) names.set(m.membershipId, clip(m.displayName));
  }
  return (id) => (typeof id === 'string' ? names.get(id) ?? dto.NO_NAME : dto.NO_NAME);
}
/** D-47: ctx.core.user once per distinct user id; a rejection shows "—". */
async function userNames(c: ChainCtx, ids: unknown[]): Promise<(id: unknown) => string> {
  const names = new Map<string, string>();
  for (const id of new Set(ids.filter((x): x is string => typeof x === 'string'))) {
    names.set(id, c.core?.user ? await c.core.user(c, { userId: id }).then((u) => clip(u.displayName), () => dto.NO_NAME) : dto.NO_NAME);
  }
  return (id) => (typeof id === 'string' ? names.get(id) ?? dto.NO_NAME : dto.NO_NAME);
}

// ---------------------------------------------------------------- object first
function cultureIdOf(params: unknown): string {
  const v = isObj(params) ? params['culture_id'] : undefined;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : fail('/culture_id');
}
/** Load (RLS + tenant) -> 404 when not visible (S-01/S-02: identical to missing) -> assertRole with the object's centre (02-CV §10.1). */
async function visibleCulture(c: ChainCtx, params: unknown): Promise<{ tx: any; tenantId: string; row: Row }> {
  const { tx, tenantId } = scope(c);
  const id = cultureIdOf(params);
  const row = await repo.getCulture(tx, { tenantId, id });
  if (!row) throw new LimsError('common.not_found');
  await identity(c).assertRole(c, { permission: READ, centreId: row['centre_id'] });
  return { tx, tenantId, row };
}

// ================================================================ M1
export async function listCultures(c: ChainCtx, input: { query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scope(c);
  await identity(c).assertRole(c, { permission: READ });   // permission first: no SQL on denial
  const q = input.query === undefined || input.query === null ? {} : isObj(input.query) ? input.query : fail('/');
  for (const k of Object.keys(q)) if (!QUERY_KEYS.includes(k)) fail(`/${k.slice(0, 64)}`, 'Unknown field', 'common.unknown_field');
  let statuses: string[] | undefined;
  if (q['status'] !== undefined) {
    const parts = typeof q['status'] === 'string' && q['status'].length <= 200 ? q['status'].split(',') : fail('/status');
    statuses = parts.every((s) => STATUSES.includes(s)) ? [...new Set(parts)] : fail('/status');
  }
  const sort = q['sort'] === undefined ? 'received_at' : (SORTS as readonly unknown[]).includes(q['sort']) ? (q['sort'] as repo.CultureSort) : fail('/sort');
  const limit = limitOf(q['limit']);
  const now = nowOf(c);
  const filter: repo.CultureFilter = { tenantId, now: now.toISOString() };
  const opt = <K extends keyof repo.CultureFilter>(k: K, v: repo.CultureFilter[K] | undefined): void => { if (v !== undefined) filter[k] = v; };
  opt('statuses', statuses); opt('specimenId', uuidQ(q, 'specimen_id')); opt('orderId', uuidQ(q, 'order_id')); opt('centreId', uuidQ(q, 'centre_id'));
  opt('receivedFrom', isoQ(q, 'received_at_from')); opt('receivedTo', isoQ(q, 'received_at_to')); opt('updatedFrom', isoQ(q, 'updated_at_from'));
  opt('readOverdue', boolQ(q, 'read_overdue')); opt('hasOpenRecords', boolQ(q, 'has_open_instrument_records'));
  const includeTotal = boolQ(q, 'include_total') === true;
  const cursor = decodeCursor(q['cursor'], sort);

  const rows = await repo.listCultures(tx, filter, sort, cursor, limit);
  const page = rows.slice(0, limit);
  const test = testLookup(c);
  const data: Obj[] = [];
  for (const r of page) data.push(dto.cultureSummaryDto(r, await test(r['test_id']), now));
  const info: Obj = { limit };
  const last = page[page.length - 1];
  if (rows.length > limit && last) info['next_cursor'] = encodeCursor(sort, keyOf(last, sort), last['id']);
  if (includeTotal) info['total'] = Math.min(await repo.countCultures(tx, filter, TOTAL_CAP), TOTAL_CAP);
  return { data, page: info };
}

// ================================================================ M2
/** The C5 line of this culture's order item; prefers the line whose moduleRef points at this culture. */
function labLine(order: Row | undefined, culture: Row): Row | undefined {
  const item = (order?.['items'] ?? []).find((i: Row) => i?.['orderItemId'] === culture['order_item_id']);
  const lines: Row[] = Array.isArray(item?.['results']) ? item['results'] : [];
  return lines.find((l) => l?.['moduleRef']?.['module'] === 'micro' && l['moduleRef']['entityId'] === culture['id']) ?? lines[0];
}

const byNum = (k: string) => (a: Row, b: Row): number => Number(a[k]) - Number(b[k]) || String(a['id']).localeCompare(String(b['id']));
const byTime = (k: string) => (a: Row, b: Row): number => new Date(a[k]).getTime() - new Date(b[k]).getTime() || String(a['id']).localeCompare(String(b['id']));

export async function getCulture(c: ChainCtx, input: { params: unknown }): Promise<Obj> {
  const { tx, tenantId, row } = await visibleCulture(c, input.params);
  const out = await cultureDetail(c, tx, tenantId, row);
  await c.audit.access({ action: 'culture.view', entityType: 'micro_culture', entityId: row['id'], outcome: 'allowed' });   // 02-TRD §13: M2 only
  return out;
}

/** CultureDetailDto of a loaded culture row (CULTURE_COLS). No permission check and no access log: M2 does both around it; M3 answers with it after its own checks. */
export async function cultureDetail(c: ChainCtx, tx: any, tenantId: string, row: Row): Promise<Obj> {
  const k = { tenantId, cultureId: row['id'] as string };
  const plates = (await repo.listPlates(tx, k)).sort(byNum('plate_no'));
  const observations = (await repo.listObservations(tx, k)).sort(byTime('observed_at'));
  const isolates = (await repo.listIsolates(tx, k)).sort(byNum('isolate_seq'));
  const ast = await repo.listAst(tx, k);
  const transitions = (await repo.listTransitions(tx, k)).sort(byTime('occurred_at'));
  const versions = (await repo.listReportVersions(tx, k)).sort((a, b) => Number(a['version_no']) - Number(b['version_no']));
  const organisms = await repo.organismDisplays(tx, tenantId, [...new Set(isolates.map((i) => i['organism_code']).filter((x): x is string => typeof x === 'string'))]);
  const antibiotics = await repo.antibioticDisplays(tx, tenantId, [...new Set(ast.map((a) => a['antibiotic_code']).filter((x): x is string => typeof x === 'string'))]);
  const panels = new Map((await repo.astPanels(tx, tenantId, [...new Set(isolates.map((i) => i['ast_panel_id']).filter((x): x is string => typeof x === 'string'))])).map((p) => [p['id'], p]));
  const protocol = row['plating_protocol_id'] ? await repo.getProtocol(tx, { tenantId, id: row['plating_protocol_id'] }) : undefined;

  const member = await memberNames(c, [...observations.map((o) => o['recorded_by_membership_id']), ...versions.map((v) => v['signed_by_membership_id'])]);
  const user = await userNames(c, transitions.map((t) => t['created_by']));
  const test = await testLookup(c)(row['test_id']);
  const actor = await identity(c).getActor(c);
  const perms: readonly string[] = Array.isArray(actor?.permissions) ? actor.permissions : [];

  const corrected = new Set(observations.map((o) => o['corrects_observation_id']).filter((x) => x != null));
  const out: Obj = dto.cultureSummaryDto(row, test, nowOf(c));
  if (row['status'] === 'awaiting_setup') {   // 02-TRD.md:306: suggested_protocol only in awaiting_setup; selection per §4.2; omitted when none matches
    const code = selectPlatingProtocol((await repo.activeProtocolKeys(tx, tenantId)).map((k) => ({
      protocol_code: k['protocol_code'], test_id: k['test_id'] ?? null, specimen_type_code: k['specimen_type_code'] ?? null, is_active: k['is_active'] !== false })),
    { test_id: row['test_id'], specimen_type_code: row['specimen_type_code'] });
    const p = code === null ? undefined : await repo.currentProtocolByCode(tx, { tenantId, code });
    if (p) out['suggested_protocol'] = { id: p['id'], code: p['code'], version_no: p['version_no'], display: p['display'] };
  }
  if (protocol) out['protocol'] = dto.protocolBlock(protocol);
  out['plates'] = plates.map(dto.plateDto);
  out['observations'] = observations.map((o) => dto.observationDto(o, member(o['recorded_by_membership_id']), corrected.has(o['id'])));
  out['isolates'] = isolates.map((i) => dto.isolateDto(i, i['organism_code'] == null ? undefined : organisms.get(i['organism_code']), panels.get(i['ast_panel_id']),
    ast.filter((a) => a['isolate_id'] === i['id']).map((a) => dto.astDto(a, antibiotics.get(a['antibiotic_code']) ?? a['antibiotic_code']))));
  out['transitions'] = transitions.map((t) => dto.transitionDto(t, user(t['created_by'])));
  out['report_versions'] = versions.map((v) => dto.versionSummaryDto(v, member(v['signed_by_membership_id'])));
  for (const f of ['amendment_reason_code', 'amendment_reason_text', 'cancel_reason_code']) if (row[f] != null) out[f] = row[f];
  if (perms.includes('lab.result.read')) {   // AC-17.2 / REQ-SEC-081: never asked, never returned without the grant
    const lab = c.ports?.LabPort;
    if (!lab) throw new LimsError('common.internal');
    const line = labLine(await lab.getOrderResults(c, { orderId: row['order_id'], scope: 'all_visible' }), row);
    if (line) out['lab_result'] = dto.labResultDto(line);
  }
  out['permissions_hint'] = { can_amend_approved: perms.includes('lab.result.amend') };
  return out;
}

// ================================================================ M15 / M16
export async function listReportVersions(c: ChainCtx, input: { params: unknown }): Promise<Obj> {
  const { tx, tenantId, row } = await visibleCulture(c, input.params);
  const versions = (await repo.listReportVersions(tx, { tenantId, cultureId: row['id'] })).sort((a, b) => Number(a['version_no']) - Number(b['version_no']));
  const member = await memberNames(c, versions.map((v) => v['signed_by_membership_id']));
  return { data: versions.map((v) => dto.versionSummaryDto(v, member(v['signed_by_membership_id']))) };
}

export async function getReportVersion(c: ChainCtx, input: { params: unknown }): Promise<Obj> {
  const raw = isObj(input.params) ? input.params['version_no'] : undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,10}$/.test(raw) ? Number(raw) : NaN;
  const versionNo = Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : fail('/version_no');
  const { tx, tenantId, row } = await visibleCulture(c, input.params);
  const v = await repo.getReportVersion(tx, { tenantId, cultureId: row['id'], versionNo });
  if (!v) throw new LimsError('common.not_found');
  const member = await memberNames(c, [v['signed_by_membership_id']]);
  return dto.versionDto(v, member(v['signed_by_membership_id']));
}
