// HC-T14: receiver side of handovers H13 listHandovers, H14 getHandover, H15 confirmHandover (02-TRD §5.1, §5.4 rules 3-4, §10 task row; 03-APP-FLOW §1.3; 01-PRD US-12-1/2/3/5; 07-SECURITY REQ-SEC-017).
// D-125 (08 A19): the receiver works at to_centre_id and is NOT a member of the home-collection centre, so these paths read and write ONLY homecollection.handovers + handover_items
// (barcode / specimen type are the copies on the item rows). H15 never writes a visit flag: with >= 1 missing tube it enqueues homecollection.flag_handover_discrepancy in the same tx
// (the worker writes the flags as system actor). Order of checks: load through RLS (404) -> assertRole on to_centre_id (403) -> If-Match present (428) -> body (400) -> state / version (409) -> item set (400 / 404).
// Messages and logs carry codes only: no barcode, no note (REQ-SEC-081).
import { LimsError } from '../../core/errors.js';
import { assertHandoverTransition, handoverConfirmOutcome, HANDOVER_STATUSES } from './domain/handover.state.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { enqueueFlagHandoverDiscrepancy, getHandoverById, listHandoverItemsByHandover, listHandoversPage, updateHandover, updateHandoverItem } from './repository/handovers.repo.js';
import { bad, dctxOf, expectedVersionOf, isObj, noExtra, type DCtx, type Obj, type Result } from './route.service.js';
import { uuidParam } from './service/visitRead.service.js';

const PERM_RECEIVE = HOMECOLLECTION_PERMISSIONS[2];   // 'homecollection.handover.receive'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const conflict = (): LimsError => new LimsError('common.version_conflict');
const wrongItems = (): LimsError => new LimsError('common.validation_failed', undefined, [{ path: '/items', code: 'common.field_invalid', message: 'Field invalid' }]);
const code = (e: unknown): string => (typeof (e as Obj)?.['code'] === 'string' ? (e as Obj)['code'] : 'unknown');
const iso = (v: unknown): string => new Date(v as string).toISOString();

// ---- names (decoration: a core failure never fails the request; savepoint per P-44) ----
async function staffNames(ctx: DCtx, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const membershipIds = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== ''))];
  for (let i = 0; i < membershipIds.length; i += 200) {                                          // core caps one call at 200 ids
    try {
      const rows = await ctx.db.tx((x) => ctx.core.memberships.list(x, { membershipIds: membershipIds.slice(i, i + 200), activeOnly: false }));
      for (const r of rows) if (typeof r.displayName === 'string' && r.displayName) out.set(r.membershipId, r.displayName);
    } catch (e) { ctx.log.warn({ code: code(e) }, 'homecollection.staff_names_unavailable'); }
  }
  return out;
}

// ---- DTOs (closed schemas; absent = key left out, never null) ----
function summaryOf(row: Obj, itemCount: number, receivedCount: number, names: Map<string, string>): Obj {
  return {
    id: row['id'], version: Number(row['version']), status: row['status'],
    from: { membership_id: row['from_membership_id'], display_name: names.get(row['from_membership_id']) ?? '—' },
    to_centre_id: row['to_centre_id'], handed_over_at: iso(row['handed_over_at']), item_count: itemCount,
    ...(row['status'] !== 'pending' ? { received_count: receivedCount } : {}),
  };
}

function detailOf(row: Obj, items: readonly Obj[], names: Map<string, string>): Obj {
  const received = items.filter((i) => i['outcome'] === 'received').length;
  const receivedBy = row['received_by_membership_id'] ? names.get(row['received_by_membership_id']) : undefined;
  return {
    ...summaryOf(row, items.length, received, names),
    items: items.map((i) => ({ specimen_id: i['specimen_id'], visit_id: i['visit_id'], barcode: i['barcode'], specimen_type_code: i['specimen_type_code'], ...(i['outcome'] ? { outcome: i['outcome'] } : {}) })),
    ...(receivedBy ? { received_by_display: receivedBy } : {}),
    ...(row['received_at'] ? { received_at: iso(row['received_at']) } : {}),
    ...(row['note'] ? { note: row['note'] } : {}),
  };
}

async function detail(ctx: DCtx, row: Obj, items: readonly Obj[]): Promise<Obj> {
  return detailOf(row, items, await staffNames(ctx, [row['from_membership_id'], row['received_by_membership_id']]));
}

// ---- H13 ----
const STATUS_CSV = /^[a-z]+(,[a-z]+)*$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const TS_KEY = /^\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const isoUtc = (v: unknown, path: string): string => { if (typeof v !== 'string' || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) throw bad(path); return v; };
const limitOf = (v: unknown): number => {
  if (v === undefined) return 50;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
  return n;
};
const encodeCursor = (key: string, id: string): string => Buffer.from(JSON.stringify({ v: 1, k: key, i: id })).toString('base64url');
function decodeCursor(raw: unknown): { key: string; id: string } {                              // carries no authority (02-CV §4.3); RLS + the filters still apply
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad('/cursor');
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad('/cursor'); }
  if (!isObj(o) || o['v'] !== 1 || typeof o['k'] !== 'string' || !TS_KEY.test(o['k']) || typeof o['i'] !== 'string' || !UUID.test(o['i'])) throw bad('/cursor');
  return { key: o['k'], id: o['i'] };
}

export async function listHandovers(hctx: unknown, query: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const q: Obj = isObj(query) ? query : {};
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_RECEIVE });                    // the centre scope is RLS on to_centre_id (REQ-SEC-017): another centre's rows are simply not there
  let statuses: string[] | undefined;
  if (q['status'] !== undefined) {
    if (typeof q['status'] !== 'string' || q['status'].length > 40 || !STATUS_CSV.test(q['status'])) throw bad('/status');
    statuses = [...new Set(q['status'].split(','))];
    if (!statuses.every((s) => (HANDOVER_STATUSES as readonly string[]).includes(s))) throw bad('/status');
  }
  const toCentreId = q['to_centre_id'] === undefined ? undefined : uuidParam(q['to_centre_id'], '/to_centre_id');
  const handedOverFrom = q['handed_over_from'] === undefined ? undefined : isoUtc(q['handed_over_from'], '/handed_over_from');
  const handedOverTo = q['handed_over_to'] === undefined ? undefined : isoUtc(q['handed_over_to'], '/handed_over_to');
  const limit = limitOf(q['limit']);
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor']);

  const { rows, hasMore } = await listHandoversPage(ctx.tx, ctx.tenantId, {
    limit, ...(statuses ? { statuses } : {}), ...(toCentreId ? { toCentreId } : {}), ...(handedOverFrom ? { handedOverFrom } : {}), ...(handedOverTo ? { handedOverTo } : {}), ...(after ? { after } : {}),
  });
  const names = await staffNames(ctx, rows.map((r) => r['from_membership_id']));
  const last = rows[rows.length - 1];
  return { status: 200, body: {
    data: rows.map((r) => summaryOf(r, Number(r['item_count']), Number(r['received_count']), names)),
    page: { limit, ...(hasMore && last ? { next_cursor: encodeCursor(last['cursor_key'], last['id']) } : {}) },
  } };
}

// ---- H14 + H15 shared: §5.4 rule 1 (load through RLS -> 404 -> assertRole on the handover's receiving centre) ----
async function load(ctx: DCtx, params: unknown): Promise<Obj> {
  const row = await getHandoverById(ctx.tx, ctx.tenantId, uuidParam(isObj(params) ? params['handover_id'] : undefined, '/handover_id'));
  if (!row) throw new LimsError('common.not_found');                                            // unknown, other tenant and other centre look the same
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_RECEIVE, centreId: row['to_centre_id'] });
  return row;
}

export async function getHandover(hctx: unknown, params: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const row = await load(ctx, params);
  return { status: 200, body: await detail(ctx, row, await listHandoverItemsByHandover(ctx.tx, ctx.tenantId, row['id'])) };
}

// ---- H15 ----
interface Decision { readonly specimenId: string; readonly received: boolean }
function parseConfirm(body: unknown): { decisions: Decision[]; note: string | undefined } {
  if (!isObj(body)) throw bad('');
  noExtra(body, ['items', 'note']);
  const items = body['items'];
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw bad('/items');
  const decisions = items.map((x, i): Decision => {
    if (!isObj(x)) throw bad(`/items/${i}`);
    noExtra(x, ['specimen_id', 'received'], `/items/${i}`);
    if (typeof x['received'] !== 'boolean') throw bad(`/items/${i}/received`);
    return { specimenId: uuidParam(x['specimen_id'], `/items/${i}/specimen_id`), received: x['received'] };
  });
  const note = body['note'];
  if (note !== undefined && (typeof note !== 'string' || note.includes('\u0000') || [...note].length < 1 || [...note].length > 500)) throw bad('/note');
  return { decisions, note: note as string | undefined };
}

export async function confirmHandover(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const ctx = dctxOf(hctx);
  const row = await load(ctx, params);
  const expected = expectedVersionOf(headers);
  const b = parseConfirm(body);
  const outcome = handoverConfirmOutcome(b.decisions.map((d) => d.received));
  assertHandoverTransition(row['status'], outcome);                                              // confirmed / discrepancy are final: 409 common.version_conflict
  if (Number(row['version']) !== expected) throw conflict();

  const items = await listHandoverItemsByHandover(ctx.tx, ctx.tenantId, row['id']);              // the request must decide EXACTLY this handover's items (TRD §5.4 rule 4)
  const byId = new Map(items.map((i) => [i['specimen_id'] as string, i]));
  if (new Set(b.decisions.map((d) => d.specimenId)).size !== b.decisions.length) throw wrongItems();
  if (b.decisions.some((d) => !byId.has(d.specimenId))) throw new LimsError('common.not_found');
  if (b.decisions.length !== items.length) throw wrongItems();
  const membershipId = ctx.actor.membershipId;
  if (!membershipId) throw new LimsError('auth.forbidden');                                      // received_by_membership_id needs a staff membership

  const updated = await updateHandover(ctx.tx, ctx.tenantId, row['id'], expected, {
    status: outcome, received_by_membership_id: membershipId, received_at: new Date(ctx.now()), note: b.note,
  });
  if (!updated) throw conflict();                                                                // two receivers at once: the loser's tx rolls back
  const decided: Obj[] = [];
  for (const d of b.decisions) {
    const item = byId.get(d.specimenId)!;
    const next = await updateHandoverItem(ctx.tx, ctx.tenantId, item['id'], Number(item['version']), { outcome: d.received ? 'received' : 'missing' });
    if (!next) throw conflict();
    decided.push(next);
  }
  if (outcome === 'discrepancy') await enqueueFlagHandoverDiscrepancy(ctx.tx, ctx.tenantId, row['id']);   // D-125: same tx; the worker writes the flags
  const order = new Map(items.map((i, n) => [i['id'] as string, n]));
  decided.sort((x, y) => order.get(x['id'])! - order.get(y['id'])!);
  return { status: 200, body: await detail(ctx, updated, decided) };
}
