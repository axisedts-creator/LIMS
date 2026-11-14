// AN-T16 test helper (not a test file). In-memory emulator of analytics.schedules / schedule_recipients / report_runs / report_run_recipients, exposed as the
// module `repository/schedules.repo.ts` (02-TRD §3.1 lists that file; the tests vi.mock it with `schedulesRepoMock`). Used by the API handler tests and by the worker's
// `analytics.dispatch_schedules` test, so the REAL handlers, schedule.service and dispatcher run against it. Synthetic data only.
//
// SEAMS pinned here (the spec leaves repository signatures open; the writer may dispute through the reviewer). Every function is `(tx, args)`, async, tenant explicit.
// Rows are returned with the DB column names (snake_case); timestamps are ISO-8601 UTC strings (`Date#toISOString()`), `weekday` is a number|null,
// `send_time_local` is 'HH:MM'. The emulator honours the schema constraints it is told about (05-SCHEMA §4):
//   schedules__name__ck (23514), schedule_recipients__schedule_membership__uq (23505), 20-active-recipient cap (23514), report_runs__slot__uq (ON CONFLICT DO NOTHING).
//   countActiveSchedules(tx,{tenantId}) -> number
//   insertSchedule(tx,{tenantId,id,name,reportCodes,frequency,sendTimeLocal,weekday,periodRule,scopeAllCentres,scopeCentreIds,ownerMembershipId,nextRunAt,actorId}) -> ScheduleRow  (version 1, is_active true)
//   getSchedule(tx,{tenantId,id,forUpdate?}) -> ScheduleRow|null
//   listSchedules(tx,{tenantId,isActive?,after?:{createdAt,id}|null,limit}) -> ScheduleRow[]   ordered (created_at, id) ascending, strictly after `after`, at most `limit` rows (the service asks limit+1)
//   updateSchedule(tx,{tenantId,id,expectedVersion,set,actorId}) -> ScheduleRow|null           `set` = any of name, report_codes, frequency, send_time_local, weekday, period_rule,
//       scope_all_centres, scope_centre_ids, next_run_at, is_active; bumps version + updated_by; null when the stored version != expectedVersion (the service has read the row before: 404 vs 409)
//   listRecipients(tx,{tenantId,scheduleId}) -> RecipientRow[]            ALL rows, active and deactivated, ordered by created_at
//   insertRecipient(tx,{tenantId,id,scheduleId,membershipId,actorId}) -> RecipientRow    throws {code:'23505'} when (schedule, membership) exists, {code:'23514'} past 20 active
//   setRecipientActive(tx,{tenantId,id,isActive,actorId}) -> RecipientRow                bumps version
//   listRuns(tx,{tenantId,scheduleId,limit}) -> RunRow[]                  newest first (created_at desc, id desc)
//   getRun(tx,{tenantId,id}) -> RunRow|null                               RLS emulated: tx.system, or the schedule owner, or a recipient row of tx.membershipId; else null
//   getRunRecipient(tx,{tenantId,runId,membershipId}) -> RunRecipientRow|null   RLS emulated: tx.system, the row's own membership, or the schedule owner
//   listRunRecipients(tx,{tenantId,runId}) -> RunRecipientRow[]           RLS emulated like getRunRecipient (a plain recipient sees only its own row)
//   --- dispatcher (system tx) ---
//   dueSchedules(tx,{tenantId,now,limit}) -> ScheduleRow[]                is_active AND next_run_at <= now, ordered by next_run_at (FOR UPDATE SKIP LOCKED in SQL)
//   insertRun(tx,{tenantId,id,scheduleId,slotStart,reportCodes,omittedReportCodes,periodFrom,periodTo,scopeAllCentres,scopeCentreIds,state,createdBy,expiresAt}) -> {id}|null   null = slot already has a run
//   insertRunRecipient(tx,{tenantId,id,runId,scheduleId,membershipId,outcome,omittedReportCodes,deliveryId,notificationStatus,errorCode,createdBy,expiresAt}) -> void
//   finishRun(tx,{tenantId,runId,sentCount,skippedCount}) -> void
//   advanceSchedule(tx,{tenantId,id,nextRunAt,lastRunId}) -> void         (lastRunId null on the already-dispatched path)
// `tx` is whatever the ctx carries: API ctx.tx = {membershipId, tenantId}; worker ctx.tx = {system:true, tenantId}. `db.calls` records every call in order (`fn`, `args`).
import { vi } from 'vitest';
import { idFor } from '../../../../../../../packages/fakes/src/base';

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

/** schedules__name__ck as written in 05-SCHEMA §4 (also asserted against the migration by repository/__tests__/schedules.name_ck.test.ts). */
export const nameCheckOk = (n: unknown): boolean =>
  typeof n === 'string' && [...n].length >= 1 && [...n].length <= 80 && !/:\/\//i.test(n) && !/www\./i.test(n) && !/@/.test(n) && !/[0-9]{7,}/.test(n);

const MAX_ACTIVE_RECIPIENTS = 20;
export const sqlError = (code: string, message: string) => Object.assign(new Error(message), { code });

class SchedulesDb {
  clock = { now: '2026-11-06T06:00:00.000Z' };
  schedules = new Map<string, ScheduleRow>();
  recipients = new Map<string, RecipientRow>();
  runs = new Map<string, RunRow>();
  runRecipients = new Map<string, RunRecipientRow>();
  calls: { fn: string; args: any }[] = [];
  fail: unknown;
  private seq = 0;
  reset(now = '2026-11-06T06:00:00.000Z'): void {
    this.clock.now = now; this.schedules.clear(); this.recipients.clear(); this.runs.clear(); this.runRecipients.clear(); this.calls.length = 0; this.fail = undefined; this.seq = 0;
  }
  /** Deterministic created_at that strictly increases with insertion (keyset paging needs distinct keys). */
  stamp(): string { return new Date(Date.parse(this.clock.now) + ++this.seq).toISOString(); }
  seedSchedule(over: Partial<ScheduleRow> & { id: string; tenant_id: string; owner_membership_id: string }, recipientMembershipIds: string[] = []): ScheduleRow {
    const at = this.stamp();
    const row: ScheduleRow = {
      name: 'Daily MIS', report_codes: ['income'], frequency: 'daily', send_time_local: '07:00', weekday: null, period_rule: 'previous_business_day',
      scope_all_centres: true, scope_centre_ids: [], next_run_at: null, last_run_id: null, version: 1, is_active: true,
      created_at: at, created_by: over.owner_membership_id, updated_at: at, updated_by: over.owner_membership_id, ...over,
    };
    this.schedules.set(row.id, row);
    recipientMembershipIds.forEach((m, i) => this.seedRecipient({ id: idFor(9, 0x7000 + this.seq * 100 + i), tenant_id: row.tenant_id, schedule_id: row.id, membership_id: m }));
    return row;
  }
  seedRecipient(over: Partial<RecipientRow> & { id: string; tenant_id: string; schedule_id: string; membership_id: string }): RecipientRow {
    const at = this.stamp();
    const row: RecipientRow = { version: 1, is_active: true, created_at: at, created_by: over.membership_id, updated_at: at, updated_by: over.membership_id, ...over };
    this.recipients.set(row.id, row);
    return row;
  }
  recipientsOf(scheduleId: string): RecipientRow[] { return [...this.recipients.values()].filter((r) => r.schedule_id === scheduleId); }
  activeRecipientIds(scheduleId: string): string[] { return this.recipientsOf(scheduleId).filter((r) => r.is_active).map((r) => r.membership_id); }
  runsOf(scheduleId: string): RunRow[] { return [...this.runs.values()].filter((r) => r.schedule_id === scheduleId).sort((a, b) => a.slot_start.localeCompare(b.slot_start)); }
  runRecipientsOf(runId: string): RunRecipientRow[] { return [...this.runRecipients.values()].filter((r) => r.report_run_id === runId); }
  seedRun(over: Partial<RunRow> & { id: string; tenant_id: string; schedule_id: string; slot_start: string }): RunRow {
    const at = this.stamp();
    const row: RunRow = {
      report_codes: ['income'], omitted_report_codes: [], period_from: '2026-11-05', period_to: '2026-11-06', scope_all_centres: true, scope_centre_ids: [], state: 'dispatched',
      sent_count: 0, skipped_count: 0, created_at: at, created_by: 'system', expires_at: new Date(Date.parse(at) + 400 * 86_400_000).toISOString(), ...over,
    };
    this.runs.set(row.id, row);
    return row;
  }
  seedRunRecipient(over: Partial<RunRecipientRow> & { id: string; tenant_id: string; report_run_id: string; schedule_id: string; membership_id: string }): RunRecipientRow {
    const at = this.stamp();
    const row: RunRecipientRow = { outcome: 'queued', omitted_report_codes: [], delivery_id: null, notification_status: 'queued', error_code: null, created_at: at, created_by: 'system', expires_at: new Date(Date.parse(at) + 400 * 86_400_000).toISOString(), ...over };
    this.runRecipients.set(row.id, row);
    return row;
  }
}
export const schedulesDb = new SchedulesDb();
const db = schedulesDb;

const tick = <T>(fn: string, args: any, run: () => T): T => { db.calls.push({ fn, args }); if (db.fail) throw db.fail; return run(); };
const clone = <T>(x: T): T => structuredClone(x);
const cmp = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

const ownerOf = (scheduleId: string): string | undefined => db.schedules.get(scheduleId)?.owner_membership_id;
const runVisible = (tx: any, run: RunRow): boolean => !!tx?.system || tx?.membershipId === ownerOf(run.schedule_id)
  || [...db.runRecipients.values()].some((r) => r.report_run_id === run.id && r.membership_id === tx?.membershipId);
const rrVisible = (tx: any, row: RunRecipientRow): boolean => !!tx?.system || row.membership_id === tx?.membershipId || tx?.membershipId === ownerOf(row.schedule_id);

export const schedulesRepoMock = {
  countActiveSchedules: vi.fn(async (tx: any, a: { tenantId: string }) => tick('countActiveSchedules', a, () => [...db.schedules.values()].filter((s) => s.tenant_id === a.tenantId && s.is_active).length)),
  insertSchedule: vi.fn(async (tx: any, a: any) => tick('insertSchedule', a, () => {
    if (!nameCheckOk(a.name)) throw sqlError('23514', 'new row for relation "schedules" violates check constraint "schedules__name__ck"');
    const at = db.stamp();
    const row: ScheduleRow = {
      id: a.id, tenant_id: a.tenantId, name: a.name, report_codes: [...a.reportCodes], frequency: a.frequency, send_time_local: a.sendTimeLocal, weekday: a.weekday ?? null,
      period_rule: a.periodRule, scope_all_centres: a.scopeAllCentres, scope_centre_ids: [...(a.scopeCentreIds ?? [])], owner_membership_id: a.ownerMembershipId,
      next_run_at: a.nextRunAt ?? null, last_run_id: null, version: 1, is_active: true, created_at: at, created_by: a.actorId, updated_at: at, updated_by: a.actorId,
    };
    db.schedules.set(row.id, row);
    return clone(row);
  })),
  getSchedule: vi.fn(async (_tx: any, a: { tenantId: string; id: string; forUpdate?: boolean }) => tick('getSchedule', a, () => {
    const s = db.schedules.get(a.id);
    return s && s.tenant_id === a.tenantId ? clone(s) : null;
  })),
  listSchedules: vi.fn(async (_tx: any, a: { tenantId: string; isActive?: boolean; after?: { createdAt: string; id: string } | null; limit: number }) => tick('listSchedules', a, () =>
    [...db.schedules.values()].filter((s) => s.tenant_id === a.tenantId && (a.isActive === undefined || s.is_active === a.isActive)).sort(cmp)
      .filter((s) => !a.after || cmp(s, { created_at: a.after.createdAt, id: a.after.id }) > 0).slice(0, a.limit).map(clone))),
  updateSchedule: vi.fn(async (_tx: any, a: { tenantId: string; id: string; expectedVersion: number; set: Partial<ScheduleRow>; actorId: string }) => tick('updateSchedule', a, () => {
    const s = db.schedules.get(a.id);
    if (!s || s.tenant_id !== a.tenantId || s.version !== a.expectedVersion) return null;
    const next = { ...s, ...clone(a.set), version: s.version + 1, updated_by: a.actorId, updated_at: db.stamp() };
    if (!nameCheckOk(next.name)) throw sqlError('23514', 'schedules__name__ck');
    if (!next.is_active && next.next_run_at !== null) throw sqlError('23514', 'schedules__next__ck');
    db.schedules.set(s.id, next);
    return clone(next);
  })),
  listRecipients: vi.fn(async (_tx: any, a: { tenantId: string; scheduleId: string }) => tick('listRecipients', a, () =>
    db.recipientsOf(a.scheduleId).filter((r) => r.tenant_id === a.tenantId).sort(cmp).map(clone))),
  insertRecipient: vi.fn(async (_tx: any, a: { tenantId: string; id: string; scheduleId: string; membershipId: string; actorId: string }) => tick('insertRecipient', a, () => {
    const mine = db.recipientsOf(a.scheduleId);
    if (mine.some((r) => r.membership_id === a.membershipId)) throw sqlError('23505', 'duplicate key value violates unique constraint "schedule_recipients__schedule_membership__uq"');
    if (mine.filter((r) => r.is_active).length >= MAX_ACTIVE_RECIPIENTS) throw sqlError('23514', 'analytics.schedule_recipients_cap');
    const at = db.stamp();
    const row: RecipientRow = { id: a.id, tenant_id: a.tenantId, schedule_id: a.scheduleId, membership_id: a.membershipId, version: 1, is_active: true, created_at: at, created_by: a.actorId, updated_at: at, updated_by: a.actorId };
    db.recipients.set(row.id, row);
    return clone(row);
  })),
  setRecipientActive: vi.fn(async (_tx: any, a: { tenantId: string; id: string; isActive: boolean; actorId: string }) => tick('setRecipientActive', a, () => {
    const r = db.recipients.get(a.id);
    if (!r || r.tenant_id !== a.tenantId) throw sqlError('P0002', 'no such recipient row');
    if (a.isActive && !r.is_active && db.recipientsOf(r.schedule_id).filter((x) => x.is_active).length >= MAX_ACTIVE_RECIPIENTS) throw sqlError('23514', 'analytics.schedule_recipients_cap');
    const next = { ...r, is_active: a.isActive, version: r.version + 1, updated_by: a.actorId, updated_at: db.stamp() };
    db.recipients.set(r.id, next);
    return clone(next);
  })),
  listRuns: vi.fn(async (_tx: any, a: { tenantId: string; scheduleId: string; limit: number }) => tick('listRuns', a, () =>
    db.runsOf(a.scheduleId).filter((r) => r.tenant_id === a.tenantId).sort((x, y) => cmp(y, x)).slice(0, a.limit).map(clone))),
  getRun: vi.fn(async (tx: any, a: { tenantId: string; id: string }) => tick('getRun', a, () => {
    const r = db.runs.get(a.id);
    return r && r.tenant_id === a.tenantId && runVisible(tx, r) ? clone(r) : null;
  })),
  getRunRecipient: vi.fn(async (tx: any, a: { tenantId: string; runId: string; membershipId: string }) => tick('getRunRecipient', a, () => {
    const r = [...db.runRecipients.values()].find((x) => x.tenant_id === a.tenantId && x.report_run_id === a.runId && x.membership_id === a.membershipId);
    return r && rrVisible(tx, r) ? clone(r) : null;
  })),
  listRunRecipients: vi.fn(async (tx: any, a: { tenantId: string; runId: string }) => tick('listRunRecipients', a, () =>
    db.runRecipientsOf(a.runId).filter((r) => r.tenant_id === a.tenantId && rrVisible(tx, r)).sort(cmp).map(clone))),

  // ---------------------------------------------------------------- dispatcher
  dueSchedules: vi.fn(async (_tx: any, a: { tenantId: string; now: string; limit: number }) => tick('dueSchedules', a, () =>
    [...db.schedules.values()].filter((s) => s.tenant_id === a.tenantId && s.is_active && s.next_run_at !== null && Date.parse(s.next_run_at) <= Date.parse(a.now))
      .sort((x, y) => x.next_run_at!.localeCompare(y.next_run_at!)).slice(0, a.limit).map(clone))),
  insertRun: vi.fn(async (_tx: any, a: any) => tick('insertRun', a, () => {
    const slotMs = Date.parse(a.slotStart);
    if ([...db.runs.values()].some((r) => r.tenant_id === a.tenantId && r.schedule_id === a.scheduleId && Date.parse(r.slot_start) === slotMs)) return null;   // ON CONFLICT DO NOTHING
    if (!['dispatched', 'skipped_flag_off', 'skipped_late'].includes(a.state)) throw sqlError('23514', 'report_runs__state__ck');
    const row: RunRow = {
      id: a.id, tenant_id: a.tenantId, schedule_id: a.scheduleId, slot_start: new Date(slotMs).toISOString(), report_codes: [...a.reportCodes], omitted_report_codes: [...a.omittedReportCodes],
      period_from: a.periodFrom, period_to: a.periodTo, scope_all_centres: a.scopeAllCentres, scope_centre_ids: [...a.scopeCentreIds], state: a.state, sent_count: 0, skipped_count: 0,
      created_at: db.stamp(), created_by: a.createdBy, expires_at: a.expiresAt,
    };
    db.runs.set(row.id, row);
    return { id: row.id };
  })),
  insertRunRecipient: vi.fn(async (_tx: any, a: any) => tick('insertRunRecipient', a, () => {
    const run = db.runs.get(a.runId);
    if (!run || run.schedule_id !== a.scheduleId) throw sqlError('23503', 'report_run_recipients__run__fk');
    if (db.runRecipientsOf(a.runId).some((r) => r.membership_id === a.membershipId)) throw sqlError('23505', 'report_run_recipients__run_membership__uq');
    if (!['queued', 'suppressed', 'skipped_ineligible', 'failed'].includes(a.outcome)) throw sqlError('23514', 'report_run_recipients__outcome__ck');
    db.runRecipients.set(a.id, {
      id: a.id, tenant_id: a.tenantId, report_run_id: a.runId, schedule_id: a.scheduleId, membership_id: a.membershipId, outcome: a.outcome,
      omitted_report_codes: [...(a.omittedReportCodes ?? [])], delivery_id: a.deliveryId ?? null, notification_status: a.notificationStatus ?? null, error_code: a.errorCode ?? null,
      created_at: db.stamp(), created_by: a.createdBy, expires_at: a.expiresAt,
    });
  })),
  finishRun: vi.fn(async (_tx: any, a: { tenantId: string; runId: string; sentCount: number; skippedCount: number }) => tick('finishRun', a, () => {
    const r = db.runs.get(a.runId);
    if (r) { r.sent_count = a.sentCount; r.skipped_count = a.skippedCount; }
  })),
  advanceSchedule: vi.fn(async (_tx: any, a: { tenantId: string; id: string; nextRunAt: string | null; lastRunId: string | null }) => tick('advanceSchedule', a, () => {
    const s = db.schedules.get(a.id);
    if (!s || s.tenant_id !== a.tenantId) return;
    s.next_run_at = a.nextRunAt;
    if (a.lastRunId) s.last_run_id = a.lastRunId;
  })),
};
