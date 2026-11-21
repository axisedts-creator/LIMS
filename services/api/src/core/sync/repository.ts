// T0B-SYNC-1 (LD-322): SQL of core.sync_device and core.number_block (migration 20261117250000). Every statement runs on the request tx
// as lims_api under RLS AND names tenant_id explicitly. Rows are never removed (no DELETE grant); audit rows come from the table triggers
// (app.tg_row_audit), so every write is audited with the actor and app.request_id of the request.
export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

const DEV = `id, user_id, device_label, platform, app_version, status, first_seen_at, last_seen_at, last_sync_at, wipe_requested_at, wipe_acked_at,
  last_clock_skew_ms, offline_retention_days, version, created_at, updated_at`;
const BLK = 'id, device_id, series, centre_id, from_value, to_value, issued_at, exhausted_at, skipped_count, version';

// ---------- devices ----------
/** New row, or nothing when the id exists (any tenant: the primary key is global). Concurrent inserts of one id wait, then answer nothing. */
export async function insertDeviceIfAbsent(tx: Tx, a: { tenantId: string; id: string; userId: string; label: string; platform: string; appVersion: string; at: string }) {
  const { rows } = await tx.query(
    `INSERT INTO core.sync_device (id, tenant_id, user_id, device_label, platform, app_version, first_seen_at, last_seen_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $3, $3) ON CONFLICT (id) DO NOTHING RETURNING ${DEV}`,
    [a.id, a.tenantId, a.userId, a.label, a.platform, a.appVersion, a.at]);
  return rows[0];
}

/** The tenant's device, row locked (FOR UPDATE) or share locked; undefined when absent or not visible (other tenant). */
export async function lockDevice(tx: Tx, tenantId: string, id: string, mode: 'update' | 'share' = 'update') {
  const { rows } = await tx.query(`SELECT ${DEV} FROM core.sync_device WHERE tenant_id = $1 AND id = $2 FOR ${mode === 'share' ? 'SHARE' : 'UPDATE'}`, [tenantId, id]);
  return rows[0];
}

export async function refreshDevice(tx: Tx, a: { tenantId: string; id: string; userId: string; label: string; platform: string; appVersion: string; at: string }) {
  const { rows } = await tx.query(
    `UPDATE core.sync_device SET device_label = $3, platform = $4, app_version = $5, last_seen_at = $6, version = version + 1, updated_at = now(), updated_by = $7
      WHERE tenant_id = $1 AND id = $2 RETURNING ${DEV}`, [a.tenantId, a.id, a.label, a.platform, a.appVersion, a.at, a.userId]);
  return rows[0];
}

/** Contact of the device (getSyncStatus): last_seen_at always, the skew only when the device reported a valid clock. */
export async function touchDevice(tx: Tx, a: { tenantId: string; id: string; userId: string; at: string; skewMs?: number }) {
  const { rows } = await tx.query(
    `UPDATE core.sync_device SET last_seen_at = $3, last_clock_skew_ms = COALESCE($4::bigint, last_clock_skew_ms), version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2 RETURNING ${DEV}`, [a.tenantId, a.id, a.at, a.skewMs ?? null, a.userId]);
  return rows[0];
}

export type DeviceChange = { status: 'revoked' } | { status: 'wipe_requested'; at: string } | { ackAt: string };
export async function changeDevice(tx: Tx, tenantId: string, id: string, actorId: string, c: DeviceChange) {
  const set = 'ackAt' in c ? 'wipe_acked_at = $4' : c.status === 'revoked' ? 'status = $4' : 'status = $4, wipe_requested_at = $5';
  const vals = 'ackAt' in c ? [c.ackAt] : c.status === 'revoked' ? [c.status] : [c.status, c.at];
  const { rows } = await tx.query(
    `UPDATE core.sync_device SET ${set}, version = version + 1, updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND id = $2 RETURNING ${DEV}`,
    [tenantId, id, actorId, ...vals]);
  return rows[0];
}

export interface DeviceFilter { status?: string; userId?: string; platform?: string; after?: { k: string; i: string }; limit: number }
/** Newest first by (created_at, id); the cursor key is created_at as database text, so microseconds survive the round trip. */
export async function listDevices(tx: Tx, tenantId: string, f: DeviceFilter) {
  const values: unknown[] = [tenantId];
  const where: string[] = [];
  const bind = (sql: string, v: unknown) => { values.push(v); where.push(sql.replace('?', `$${values.length}`)); };
  if (f.status !== undefined) bind('status = ?', f.status);
  if (f.userId !== undefined) bind('user_id = ?', f.userId);
  if (f.platform !== undefined) bind('platform = ?', f.platform);
  if (f.after) { values.push(f.after.k, f.after.i); where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`); }
  values.push(f.limit + 1);
  const filter = where.map((w) => ` AND ${w}`).join('');
  const { rows } = await tx.query(
    `SELECT ${DEV}, created_at::text AS created_at_key FROM core.sync_device WHERE tenant_id = $1${filter} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
  return rows;
}

// ---------- number blocks ----------
/** Advances the per tenant counter of the ONLINE allocator by `size` under its row lock (INSERT .. ON CONFLICT DO UPDATE locks the row until
 *  commit), so concurrent reservations and online allocations serialise on one row and the block [last - size + 1 .. last] is never handed out
 *  again. Returns the new last_value. */
export async function advanceCounter(tx: Tx, tenantId: string, series: 'lab_code' | 'patient_id', size: number, actorId: string): Promise<number> {
  const { rows } = series === 'lab_code'
    ? await tx.query(
      `INSERT INTO lab.barcode_counters AS c (tenant_id, last_value, created_by, updated_by) VALUES ($1, $2, $3, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET last_value = c.last_value + EXCLUDED.last_value, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING last_value`, [tenantId, size, actorId])
    : await tx.query(
      `INSERT INTO frontdesk.number_counters AS c (tenant_id, counter_kind, scope_key, last_value, created_by, updated_by) VALUES ($1, $4, $5, $2, $3, $3)
       ON CONFLICT (tenant_id, counter_kind, scope_key) DO UPDATE SET last_value = c.last_value + EXCLUDED.last_value, version = c.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING last_value`, [tenantId, size, actorId, 'patient_code', '']);
  return Number(rows[0].last_value);
}

export async function centreExists(tx: Tx, tenantId: string, centreId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [tenantId, centreId]);
  return rows.length > 0;
}

export async function insertBlock(tx: Tx, a: { tenantId: string; id: string; deviceId: string; series: string; centreId?: string; from: number; to: number; at: string; actorId: string }) {
  const { rows } = await tx.query(
    `INSERT INTO core.number_block (id, tenant_id, device_id, series, centre_id, from_value, to_value, issued_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${BLK}`,
    [a.id, a.tenantId, a.deviceId, a.series, a.centreId ?? null, a.from, a.to, a.at, a.actorId]);
  return rows[0];
}

/** Unused numbers the device holds in the series: sum of the sizes of its open blocks (a closed block has exhausted_at). */
export async function remainingSize(tx: Tx, tenantId: string, deviceId: string, series: string): Promise<number> {
  const { rows } = await tx.query(
    `SELECT COALESCE(SUM(to_value - from_value + 1), 0)::bigint AS n FROM core.number_block
      WHERE tenant_id = $1 AND device_id = $2 AND series = $3 AND exhausted_at IS NULL`, [tenantId, deviceId, series]);
  return Number(rows[0].n);
}

/** The block (row locked) with the owner of its device; undefined when absent or not visible. */
export async function lockBlock(tx: Tx, tenantId: string, id: string) {
  const { rows } = await tx.query(
    `SELECT b.id, b.device_id, b.series, b.centre_id, b.from_value, b.to_value, b.issued_at, b.exhausted_at, b.skipped_count, b.version, d.user_id AS device_user_id
       FROM core.number_block b JOIN core.sync_device d ON d.tenant_id = b.tenant_id AND d.id = b.device_id
      WHERE b.tenant_id = $1 AND b.id = $2 FOR UPDATE OF b`, [tenantId, id]);
  return rows[0];
}

/** T0B-SYNC-2: a successful push (design section 5: server time drives everything after sync). */
export async function markSynced(tx: Tx, a: { tenantId: string; id: string; userId: string; at: string; skewMs?: number }) {
  await tx.query(
    `UPDATE core.sync_device SET last_sync_at = $3, last_seen_at = $3, last_clock_skew_ms = COALESCE($4::bigint, last_clock_skew_ms), version = version + 1,
       updated_at = now(), updated_by = $5 WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.at, a.skewMs ?? null, a.userId]);
}

// ---------- T0B-SYNC-2: operation ledger (core.sync_operation, migration 20261117260000) ----------
/** Non waiting lock per device for the rest of the request tx: false = another batch of the device is in flight. */
export async function tryDeviceLock(tx: Tx, tenantId: string, deviceId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [`core.sync.push:${tenantId}:${deviceId}`]);
  return rows[0]?.ok === true;
}

/** Claims the op_id for this tenant (outcome written later, once). A concurrent claim of the same op_id waits for the other request and then
 *  answers false, so an operation is executed at most once per tenant. */
export async function claimOperation(tx: Tx, a: { tenantId: string; opId: string; deviceId: string; userId: string; opType: string; baseVersion?: number | undefined;
  hash: string; payload: object; deviceCreatedAt: string; at: string }): Promise<boolean> {
  const { rows } = await tx.query(
    `INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, base_version, payload_hash, payload, device_created_at, server_received_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'accepted') ON CONFLICT (tenant_id, op_id) DO NOTHING RETURNING op_id`,
    [a.tenantId, a.opId, a.deviceId, a.userId, a.opType, a.baseVersion ?? null, a.hash, JSON.stringify(a.payload), a.deviceCreatedAt, a.at]);
  return rows.length === 1;
}

export async function storedOperation(tx: Tx, tenantId: string, opId: string): Promise<{ user_id: string; payload_hash: string; result: any } | undefined> {
  const { rows } = await tx.query('SELECT user_id, payload_hash, result FROM core.sync_operation WHERE tenant_id = $1 AND op_id = $2', [tenantId, opId]);
  return rows[0];
}

export async function writeOutcome(tx: Tx, tenantId: string, opId: string, o: { status: string; result: object; errorCode?: string | undefined; skew: boolean }) {
  await tx.query('UPDATE core.sync_operation SET status = $3, result = $4, error_code = $5, skew_flag = $6 WHERE tenant_id = $1 AND op_id = $2',
    [tenantId, opId, o.status, JSON.stringify(o.result), o.errorCode ?? null, o.skew]);
}

/** T0B-SYNC-3: true when every value lies in a block issued to this device for this series (an exhausted block still counts: its numbers
 *  were issued to the device and may have been printed before it closed). RLS and tenant_id keep other tenants' blocks out. */
export async function inDeviceBlocks(tx: Tx, a: { tenantId: string; deviceId: string; series: 'lab_code' | 'patient_id'; values: readonly number[] }): Promise<boolean> {
  if (a.values.length === 0) return true;
  const { rows } = await tx.query(
    `SELECT bool_and(EXISTS (SELECT 1 FROM core.number_block b WHERE b.tenant_id = $1 AND b.device_id = $2 AND b.series = $3 AND v BETWEEN b.from_value AND b.to_value)) AS ok
       FROM unnest($4::bigint[]) AS v`, [a.tenantId, a.deviceId, a.series, a.values]);
  return rows[0]?.ok === true;
}

// ---------- T0B-SYNC-2: conflicts (core.sync_conflict) ----------
const CF = `id, op_id, entity_type, entity_id, local_payload, server_payload, status, resolution, resolved_by, resolved_at, reason, created_at`;

export async function insertConflict(tx: Tx, a: { tenantId: string; id: string; opId: string; entityType: string; entityId: string; local: object; server: object; actorId: string }) {
  await tx.query(
    `INSERT INTO core.sync_conflict (id, tenant_id, op_id, entity_type, entity_id, local_payload, server_payload, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [a.id, a.tenantId, a.opId, a.entityType, a.entityId, JSON.stringify(a.local), JSON.stringify(a.server), a.actorId]);
}

export async function getConflict(tx: Tx, tenantId: string, id: string) {
  const { rows } = await tx.query(`SELECT ${CF} FROM core.sync_conflict WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

/** Row locked, with the op_type of its ledger row (the adapter that resolves it). Concurrent resolutions queue here. */
export async function lockConflict(tx: Tx, tenantId: string, id: string) {
  const { rows } = await tx.query(
    `SELECT c.id, c.op_id, c.entity_type, c.entity_id, c.local_payload, c.server_payload, c.status, o.op_type
       FROM core.sync_conflict c JOIN core.sync_operation o ON o.tenant_id = c.tenant_id AND o.op_id = c.op_id
      WHERE c.tenant_id = $1 AND c.id = $2 FOR UPDATE OF c`, [tenantId, id]);
  return rows[0];
}

export async function resolveConflict(tx: Tx, a: { tenantId: string; id: string; resolution: string; reason: string; actorId: string; at: string }) {
  const { rows } = await tx.query(
    `UPDATE core.sync_conflict SET status = $7, resolution = $3, reason = $4, resolved_by = $5, resolved_at = $6, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2 RETURNING ${CF}`, [a.tenantId, a.id, a.resolution, a.reason, a.actorId, a.at, 'resolved']);
  return rows[0];
}

export interface ConflictFilter { status?: string; entityType?: string; after?: { r: number; k: string; i: string }; limit: number }
/** Open first, then newest first by (created_at, id); keyset on (resolved, created_at, id). */
export async function listConflicts(tx: Tx, tenantId: string, f: ConflictFilter) {
  const values: unknown[] = [tenantId];
  const where: string[] = [];
  if (f.status !== undefined) { values.push(f.status); where.push(`status = $${values.length}`); }
  if (f.entityType !== undefined) { values.push(f.entityType); where.push(`entity_type = $${values.length}`); }
  if (f.after) {
    values.push(f.after.r, f.after.k, f.after.i);
    const [r, k, i] = [values.length - 2, values.length - 1, values.length];
    where.push(`(r > $${r} OR (r = $${r} AND (created_at, id) < ($${k}::timestamptz, $${i}::uuid)))`);
  }
  values.push(f.limit + 1);
  const filter = where.map((w) => ` AND ${w}`).join('');
  const { rows } = await tx.query(
    `SELECT * FROM (SELECT ${CF}, created_at::text AS created_at_key, (status <> 'open')::int AS r FROM core.sync_conflict WHERE tenant_id = $1) x
      WHERE true${filter} ORDER BY r, created_at DESC, id DESC LIMIT $${values.length}`, values);
  return rows;
}

export async function closeBlock(tx: Tx, a: { tenantId: string; id: string; skipped: number; at: string; actorId: string }) {
  const { rows } = await tx.query(
    `UPDATE core.number_block SET skipped_count = $3, exhausted_at = $4, version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2 RETURNING ${BLK}`, [a.tenantId, a.id, a.skipped, a.at, a.actorId]);
  return rows[0];
}
