// analytics.schedules / schedule_recipients / report_runs / report_run_recipients (05-SCHEMA §4; 02-TRD §3.1, §9.6). Every statement is parameterised and tenant-filtered.
// API side: the user transaction (RLS: schedules + recipients tenant-wide for staff; runs only for the system, the run's recipients and the schedule owner).
// Worker side (dispatcher): the system transaction. Timestamps come back as ISO-8601 UTC strings with milliseconds, `send_time_local` as 'HH:MM', run dates as 'YYYY-MM-DD';
// keyset paging therefore orders on the millisecond-truncated created_at so that cursor and rows agree.
// Row-shape and argument contracts are pinned by service/__tests__/schedulesFake.ts (the in-memory twin used by the tests).

export interface SchedulesTx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export interface ScheduleRow {
  id: string; tenant_id: string; name: string; report_codes: string[]; frequency: string; send_time_local: string; weekday: number | null; period_rule: string;
  scope_all_centres: boolean; scope_centre_ids: string[]; owner_membership_id: string; next_run_at: string | null; last_run_id: string | null;
  version: number; is_active: boolean; created_at: string; created_by: string; updated_at: string; updated_by: string;
}
export interface RecipientRow { id: string; tenant_id: string; schedule_id: string; membership_id: string; version: number; is_active: boolean; created_at: string; created_by: string; updated_at: string; updated_by: string }
export interface RunRow {
  id: string; tenant_id: string; schedule_id: string; slot_start: string; report_codes: string[]; omitted_report_codes: string[]; period_from: string; period_to: string;
  scope_all_centres: boolean; scope_centre_ids: string[]; state: string; sent_count: number; skipped_count: number; created_at: string; created_by: string; expires_at: string;
}
export interface RunRecipientRow {
  id: string; tenant_id: string; report_run_id: string; schedule_id: string; membership_id: string; outcome: string; omitted_report_codes: string[];
  delivery_id: string | null; notification_status: string | null; error_code: string | null; created_at: string; created_by: string; expires_at: string;
}

const ts = (c: string, as = c): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${as}`;
const SCHEDULE_COLS = `id, tenant_id, name, report_codes, frequency, to_char(send_time_local, 'HH24:MI') AS send_time_local, weekday::int AS weekday, period_rule,
  scope_all_centres, scope_centre_ids, owner_membership_id, ${ts('next_run_at')}, last_run_id, version, is_active, ${ts('created_at')}, created_by, ${ts('updated_at')}, updated_by`;
const RECIPIENT_COLS = `id, tenant_id, schedule_id, membership_id, version, is_active, ${ts('created_at')}, created_by, ${ts('updated_at')}, updated_by`;
const RUN_COLS = `id, tenant_id, schedule_id, ${ts('slot_start')}, report_codes, omitted_report_codes, to_char(period_from, 'YYYY-MM-DD') AS period_from,
  to_char(period_to, 'YYYY-MM-DD') AS period_to, scope_all_centres, scope_centre_ids, state, sent_count, skipped_count, ${ts('created_at')}, created_by, ${ts('expires_at')}`;
const RUN_RECIPIENT_COLS = `id, tenant_id, report_run_id, schedule_id, membership_id, outcome, omitted_report_codes, delivery_id, notification_status, error_code,
  ${ts('created_at')}, created_by, ${ts('expires_at')}`;
const MS_CREATED = `date_trunc('milliseconds', created_at)`;

// ------------------------------------------------------------------ schedules (API)
export async function countActiveSchedules(tx: SchedulesTx, a: { tenantId: string }): Promise<number> {
  const { rows } = await tx.query('SELECT count(*)::int AS n FROM analytics.schedules WHERE tenant_id = $1 AND is_active', [a.tenantId]);
  return Number(rows[0]?.n ?? 0);
}

export async function insertSchedule(tx: SchedulesTx, a: {
  tenantId: string; id: string; name: string; reportCodes: readonly string[]; frequency: string; sendTimeLocal: string; weekday: number | null; periodRule: string;
  scopeAllCentres: boolean; scopeCentreIds: readonly string[]; ownerMembershipId: string; nextRunAt: string | null; actorId: string;
}): Promise<ScheduleRow> {
  const { rows } = await tx.query(
    `INSERT INTO analytics.schedules (id, tenant_id, name, report_codes, frequency, send_time_local, weekday, period_rule, scope_all_centres, scope_centre_ids,
        owner_membership_id, next_run_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4::text[], $5, $6::time, $7, $8, $9, $10::uuid[], $11, $12::timestamptz, $13, $13) RETURNING ${SCHEDULE_COLS}`,
    [a.id, a.tenantId, a.name, [...a.reportCodes], a.frequency, a.sendTimeLocal, a.weekday, a.periodRule, a.scopeAllCentres, [...a.scopeCentreIds], a.ownerMembershipId, a.nextRunAt, a.actorId]);
  return rows[0];
}

export async function getSchedule(tx: SchedulesTx, a: { tenantId: string; id: string; forUpdate?: boolean }): Promise<ScheduleRow | null> {
  const { rows } = await tx.query(`SELECT ${SCHEDULE_COLS} FROM analytics.schedules WHERE tenant_id = $1 AND id = $2${a.forUpdate ? ' FOR UPDATE' : ''}`, [a.tenantId, a.id]);
  return rows[0] ?? null;
}

export async function listSchedules(tx: SchedulesTx, a: { tenantId: string; isActive?: boolean | undefined; after?: { createdAt: string; id: string } | null | undefined; limit: number }): Promise<ScheduleRow[]> {
  const values: unknown[] = [a.tenantId];
  let where = 'tenant_id = $1';
  if (a.isActive !== undefined) { values.push(a.isActive); where += ` AND is_active = $${values.length}`; }
  if (a.after) { values.push(a.after.createdAt, a.after.id); where += ` AND (${MS_CREATED}, id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`; }
  values.push(a.limit);
  const { rows } = await tx.query(`SELECT ${SCHEDULE_COLS} FROM analytics.schedules WHERE ${where} ORDER BY ${MS_CREATED}, id LIMIT $${values.length}`, values);
  return rows;
}

/** column -> SQL cast. Keys of `set` outside this list are refused: a key never becomes SQL text unchecked. */
const SETTABLE: Readonly<Record<string, string>> = {
  name: '', report_codes: '::text[]', frequency: '', send_time_local: '::time', weekday: '', period_rule: '', scope_all_centres: '', scope_centre_ids: '::uuid[]',
  next_run_at: '::timestamptz', is_active: '',
};

/** Version-guarded: null when the stored version differs from `expectedVersion` (the caller has read the row, so null means a lost race). */
export async function updateSchedule(tx: SchedulesTx, a: { tenantId: string; id: string; expectedVersion: number; set: Record<string, unknown>; actorId: string }): Promise<ScheduleRow | null> {
  const values: unknown[] = [a.tenantId, a.id, a.expectedVersion, a.actorId];
  const sets: string[] = [];
  for (const [k, v] of Object.entries(a.set)) {
    if (!Object.hasOwn(SETTABLE, k)) throw new TypeError(`updateSchedule: column ${k} is not settable`);
    values.push(v);
    sets.push(`${k} = $${values.length}${SETTABLE[k]}`);
  }
  const { rows } = await tx.query(
    `UPDATE analytics.schedules SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = $4'].join(', ')}
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${SCHEDULE_COLS}`, values);
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ recipients (API)
export async function listRecipients(tx: SchedulesTx, a: { tenantId: string; scheduleId: string }): Promise<RecipientRow[]> {
  const { rows } = await tx.query(`SELECT ${RECIPIENT_COLS} FROM analytics.schedule_recipients WHERE tenant_id = $1 AND schedule_id = $2 ORDER BY ${MS_CREATED}, id`, [a.tenantId, a.scheduleId]);
  return rows;
}

export async function insertRecipient(tx: SchedulesTx, a: { tenantId: string; id: string; scheduleId: string; membershipId: string; actorId: string }): Promise<RecipientRow> {
  const { rows } = await tx.query(
    `INSERT INTO analytics.schedule_recipients (id, tenant_id, schedule_id, membership_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${RECIPIENT_COLS}`,
    [a.id, a.tenantId, a.scheduleId, a.membershipId, a.actorId]);
  return rows[0];
}

/** D-45: recipients are deactivated / reactivated, never deleted. */
export async function setRecipientActive(tx: SchedulesTx, a: { tenantId: string; id: string; isActive: boolean; actorId: string }): Promise<RecipientRow> {
  const { rows } = await tx.query(
    `UPDATE analytics.schedule_recipients SET is_active = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 RETURNING ${RECIPIENT_COLS}`,
    [a.tenantId, a.id, a.isActive, a.actorId]);
  if (!rows[0]) throw Object.assign(new Error('analytics.schedule_recipients: no such row'), { code: 'P0002' });
  return rows[0];
}

// ------------------------------------------------------------------ runs (API; RLS decides visibility)
export async function listRuns(tx: SchedulesTx, a: { tenantId: string; scheduleId: string; limit: number }): Promise<RunRow[]> {
  const { rows } = await tx.query(`SELECT ${RUN_COLS} FROM analytics.report_runs WHERE tenant_id = $1 AND schedule_id = $2 ORDER BY ${MS_CREATED} DESC, id DESC LIMIT $3`, [a.tenantId, a.scheduleId, a.limit]);
  return rows;
}

export async function getRun(tx: SchedulesTx, a: { tenantId: string; id: string }): Promise<RunRow | null> {
  const { rows } = await tx.query(`SELECT ${RUN_COLS} FROM analytics.report_runs WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0] ?? null;
}

export async function getRunRecipient(tx: SchedulesTx, a: { tenantId: string; runId: string; membershipId: string }): Promise<RunRecipientRow | null> {
  const { rows } = await tx.query(
    `SELECT ${RUN_RECIPIENT_COLS} FROM analytics.report_run_recipients WHERE tenant_id = $1 AND report_run_id = $2 AND membership_id = $3`, [a.tenantId, a.runId, a.membershipId]);
  return rows[0] ?? null;
}

export async function listRunRecipients(tx: SchedulesTx, a: { tenantId: string; runId: string }): Promise<RunRecipientRow[]> {
  const { rows } = await tx.query(`SELECT ${RUN_RECIPIENT_COLS} FROM analytics.report_run_recipients WHERE tenant_id = $1 AND report_run_id = $2 ORDER BY ${MS_CREATED}, id`, [a.tenantId, a.runId]);
  return rows;
}

// ------------------------------------------------------------------ dispatcher (system transaction)
export async function dueSchedules(tx: SchedulesTx, a: { tenantId: string; now: string; limit: number }): Promise<ScheduleRow[]> {
  const { rows } = await tx.query(
    `SELECT ${SCHEDULE_COLS} FROM analytics.schedules WHERE tenant_id = $1 AND is_active AND next_run_at <= $2::timestamptz ORDER BY next_run_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
    [a.tenantId, a.now, a.limit]);
  return rows;
}

/** null = the slot already has a run (ON CONFLICT DO NOTHING, report_runs__slot__uq). */
export async function insertRun(tx: SchedulesTx, a: {
  tenantId: string; id: string; scheduleId: string; slotStart: string; reportCodes: readonly string[]; omittedReportCodes: readonly string[]; periodFrom: string; periodTo: string;
  scopeAllCentres: boolean; scopeCentreIds: readonly string[]; state: string; createdBy: string; expiresAt: string;
}): Promise<{ id: string } | null> {
  const { rows } = await tx.query(
    `INSERT INTO analytics.report_runs (id, tenant_id, schedule_id, slot_start, report_codes, omitted_report_codes, period_from, period_to, scope_all_centres, scope_centre_ids, state, created_by, expires_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5::text[], $6::text[], $7::date, $8::date, $9, $10::uuid[], $11, $12, $13::timestamptz)
     ON CONFLICT (tenant_id, schedule_id, slot_start) DO NOTHING RETURNING id`,
    [a.id, a.tenantId, a.scheduleId, a.slotStart, [...a.reportCodes], [...a.omittedReportCodes], a.periodFrom, a.periodTo, a.scopeAllCentres, [...a.scopeCentreIds], a.state, a.createdBy, a.expiresAt]);
  return rows[0] ? { id: rows[0].id } : null;
}

export async function insertRunRecipient(tx: SchedulesTx, a: {
  tenantId: string; id: string; runId: string; scheduleId: string; membershipId: string; outcome: string; omittedReportCodes: readonly string[];
  deliveryId: string | null; notificationStatus: string | null; errorCode: string | null; createdBy: string; expiresAt: string;
}): Promise<void> {
  await tx.query(
    `INSERT INTO analytics.report_run_recipients (id, tenant_id, report_run_id, schedule_id, membership_id, outcome, omitted_report_codes, delivery_id, notification_status, error_code, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12::timestamptz)`,
    [a.id, a.tenantId, a.runId, a.scheduleId, a.membershipId, a.outcome, [...a.omittedReportCodes], a.deliveryId, a.notificationStatus, a.errorCode, a.createdBy, a.expiresAt]);
}

export async function finishRun(tx: SchedulesTx, a: { tenantId: string; runId: string; sentCount: number; skippedCount: number }): Promise<void> {
  await tx.query('UPDATE analytics.report_runs SET sent_count = $3, skipped_count = $4 WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.runId, a.sentCount, a.skippedCount]);
}

/** lastRunId null (slot already dispatched elsewhere) keeps the stored last_run_id. version is not bumped: a user's If-Match must survive a dispatch. */
export async function advanceSchedule(tx: SchedulesTx, a: { tenantId: string; id: string; nextRunAt: string | null; lastRunId: string | null }): Promise<void> {
  await tx.query(
    'UPDATE analytics.schedules SET next_run_at = $3::timestamptz, last_run_id = COALESCE($4::uuid, last_run_id) WHERE tenant_id = $1 AND id = $2 AND is_active',
    [a.tenantId, a.id, a.nextRunAt, a.lastRunId]);
}
