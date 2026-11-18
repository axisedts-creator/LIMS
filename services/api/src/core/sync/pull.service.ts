// T0B-SYNC-2 (LD-322, done_when 4): pullChanges. The whitelist is core.yaml SyncEntityType and nothing else; each type maps to ONE table
// and the x-permission of that type's own read operation (verbatim from the contracts). Keyset pages on (updated_at, id); a deactivated row
// (rows are never deleted) is a tombstone { id, removed_at } with no row data; cursors are opaque (base64url) and bound to their type.
// Tenant: explicit tenant_id filter next to RLS. Centre: patients follow IdentityPort.getActor().centreScope.
// [CONV] parameter = catalog.analytes (the parameters of a test, read with catalog.test.read like getAnalyte).
// worklist_item and permission have no table with a uuid id in the contracts yet: they fail closed (auth.forbidden) until the lead maps
// them (.orchestra/cr/T0B-SYNC-2.md).
import { LimsError } from '../errors.js';
import { CURSOR_KEY, assertUsable, guard, ownDevice, type SyncCtx } from './devices.service.js';
import { UUID, invalid, objectWith, uuidOf } from './mappers.js';

interface Source { table: string; permission: string; gone: string; centre?: string }
const SOURCES: Readonly<Record<string, Source | undefined>> = {
  test: { table: 'catalog.tests', permission: 'catalog.test.read', gone: 'NOT x.is_active' },
  parameter: { table: 'catalog.analytes', permission: 'catalog.test.read', gone: 'NOT x.is_active' },
  doctor: { table: 'catalog.doctors', permission: 'catalog.referrer.read', gone: 'NOT x.is_active' },
  centre: { table: 'core.collection_centres', permission: 'identity.centre.read', gone: 'NOT x.is_active' },
  price_list_version: { table: 'catalog.price_list_versions', permission: 'catalog.price_list.read', gone: 'NOT x.is_active' },
  verification_policy: { table: 'lab.verification_policy', permission: 'lab.verification_policy.read', gone: 'NOT x.active' },
  print_profile: { table: 'reporting.print_profile', permission: 'reporting.settings.manage', gone: 'NOT x.is_active' },
  patient: { table: 'frontdesk.patients', permission: 'frontdesk.patient.read', gone: '(NOT x.is_active OR x.anonymised_at IS NOT NULL)', centre: 'registered_centre_id' },
  worklist_item: undefined,
  permission: undefined,
};
const HIDDEN = ['tenant_id', 'created_by', 'updated_by'];
const DEFAULT_LIMIT = 200;

type Key = { k: string; i: string } | undefined;
const encode = (t: string, key: Key): string => Buffer.from(JSON.stringify(key ? { t, ...key } : { t })).toString('base64url');
function decode(t: string, c: unknown): Key {
  try {
    if (typeof c !== 'string' || c.length < 1 || c.length > 512 || !/^[A-Za-z0-9_-]+$/.test(c)) throw 0;
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (o?.t === t && o.k === undefined && o.i === undefined) return undefined;
    if (o?.t === t && typeof o.k === 'string' && CURSOR_KEY.test(o.k) && typeof o.i === 'string' && UUID.test(o.i)) return { k: o.k, i: o.i };
  } catch { /* fallthrough */ }
  throw new LimsError('common.invalid_cursor');
}

type PullCtx = SyncCtx & { ports: { IdentityPort: { getActor?(ctx: unknown): Promise<{ centreScope?: { all?: boolean; centreIds?: readonly string[] } }> } } };

export async function pullChanges(ctx: PullCtx, body: unknown) {
  const w = await guard(ctx, 'sync.use');
  const b = objectWith(body, ['device_id', 'entities', 'limit']);
  const deviceId = uuidOf(b.device_id, '/device_id');
  const list = b.entities;
  if (!Array.isArray(list) || list.length < 1 || list.length > 20) throw invalid('/entities');
  const limit = b.limit === undefined ? DEFAULT_LIMIT : b.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid('/limit');
  const asks = list.map((v, n) => {
    const e = objectWith(v, ['entity_type', 'cursor'], `/entities/${n}`);
    if (typeof e.entity_type !== 'string' || !Object.hasOwn(SOURCES, e.entity_type)) throw invalid(`/entities/${n}/entity_type`);
    if (e.cursor !== undefined && (typeof e.cursor !== 'string' || e.cursor.length < 1 || e.cursor.length > 512)) throw new LimsError('common.invalid_cursor');
    return { type: e.entity_type, cursor: e.cursor as string | undefined };
  });
  assertUsable(await ownDevice(w, deviceId, 'share'));
  // every type is authorised before any row is read; a type without a mapped source fails closed
  for (const type of new Set(asks.map((a) => a.type))) {
    const src = SOURCES[type];
    if (!src) throw new LimsError('auth.forbidden');
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: src.permission });
  }
  const keys = asks.map((a) => ({ ...a, after: a.cursor === undefined ? undefined : decode(a.type, a.cursor) }));
  let centres: readonly string[] | undefined;   // undefined = all centres
  if (keys.some((a) => SOURCES[a.type]!.centre)) {
    const scope = (await ctx.ports.IdentityPort.getActor?.(ctx))?.centreScope;
    centres = scope?.all === true ? undefined : (scope?.centreIds ?? []).filter((c) => UUID.test(c));
  }
  const changes = [];
  for (const a of keys) {
    const src = SOURCES[a.type]!;
    const values: unknown[] = [w.tenantId];
    let where = '';
    if (a.after) { values.push(a.after.k, a.after.i); where += ` AND (x.updated_at, x.id) > ($2::timestamptz, $3::uuid)`; }
    if (src.centre && centres !== undefined) { values.push(centres); where += ` AND x.${src.centre} = ANY($${values.length}::uuid[])`; }
    values.push(limit + 1);
    const { rows } = await w.tx.query(
      `SELECT x.id, (${src.gone}) AS gone, x.updated_at::text AS k, to_char(x.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS u, to_jsonb(x) AS doc
         FROM ${src.table} x
        WHERE x.tenant_id = $1${where} ORDER BY x.updated_at, x.id LIMIT $${values.length}`, values);
    const page = rows.slice(0, limit);
    const upserts = [];
    const tombstones = [];
    for (const r of page) {
      if (r.gone) { tombstones.push({ id: r.id, removed_at: r.u }); continue; }
      const doc = { ...r.doc };
      for (const h of HIDDEN) delete doc[h];
      upserts.push({ id: r.id, ...(Number.isInteger(r.doc.version) && r.doc.version >= 1 ? { version: r.doc.version } : {}), updated_at: r.u, document: doc });
    }
    const last = page[page.length - 1];
    changes.push({ entity_type: a.type, upserts, tombstones, next_cursor: encode(a.type, last ? { k: last.k, i: last.id } : a.after), has_more: rows.length > limit });
  }
  return { changes, server_time: ctx.now() };
}
