// Schedules, report runs and the dispatcher logic (02-TRD §5 #24–#29, §9.6, §11; PRD US-18.1–18.6; 05-SCHEMA §4; 07-SECURITY S1–S4, P1, P2, P10, P11; 08 A17 D-45, A13 D-29).
// Handlers authorise first (assertRole); everything API-side runs on the caller's user transaction. `dispatchDueSchedules` runs in the worker's system transaction.
// Recipients are deactivated / reactivated, never deleted (D-45). C8 sends only {kind:'staff', membershipId, requiredPermission}: no address, no figures, no staff name.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { ROUTES } from '../../../../../../packages/shared-ts/src/routes/generated.js';
import { LimsError } from '../../../core/errors.js';
import { loadAnalyticsConfig } from '../config.js';
import { businessDateOf } from '../domain/period.js';
import { getReport } from '../domain/reportRegistry.js';
import { intersect } from '../domain/scope.js';
import {
  PERIOD_RULES, SCHEDULE_FREQUENCIES, isSlotLate, nextSlot, schedulePeriod, validateScheduleName, type PeriodRule,
} from '../domain/schedule.js';
import {
  activeRecipientIds, toReportRunDto, toRunSummary, toScheduleDetailDto, toScheduleDto,
} from '../mappers/schedules.dto.js';
import * as repo from '../repository/schedules.repo.js';
import { asApiError, resolveScope } from './context.service.js';
import { checkInt, invalidField } from './reports.service.js';

const DASH = 'analytics.dashboard.read' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HM = /^([01][0-9]|2[0-3]):(00|15|30|45)$/;
const BODY_KEYS = ['name', 'report_codes', 'frequency', 'send_time_local', 'weekday', 'period_rule', 'scope', 'recipient_membership_ids'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const notFound = (): LimsError => new LimsError('common.not_found');
const nowIso = (ctx: { now(): string }): string => new Date(Date.parse(ctx.now())).toISOString();

interface MembershipView { isActive: boolean; status: string; lockedAt?: string | undefined; displayName: string }
export interface ScheduleCtx {
  tenantId: string; now(): string; tx: repo.SchedulesTx;
  actor: { id: string; membershipId?: string | undefined };
  core: {
    membership(ctx: never, i: { membershipId: string }): Promise<MembershipView>;
    membershipPermissions(ctx: never, i: { membershipId: string }): Promise<readonly string[]>;
    memberships: { list(ctx: never, i: { membershipIds: readonly string[]; activeOnly: boolean }): Promise<readonly { membershipId: string; displayName: string }[]> };
  };
  ports: { IdentityPort: { getActor(ctx: never): Promise<{ centreScope: { all: boolean; centreIds: readonly string[] } }> } };
}

// ------------------------------------------------------------------ input
export interface ScheduleInput {
  name: string; reportCodes: string[]; frequency: string; sendTimeLocal: string; weekday: number | null; periodRule: PeriodRule;
  scope: { all: boolean; centreIds: string[] }; recipientIds: string[];
}

const uuidList = (v: unknown, path: string, min: number, max: number): string[] => {
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some((x) => typeof x !== 'string' || !UUID.test(x)) || new Set(v).size !== v.length) throw invalidField(path);
  return v as string[];
};

/** ScheduleInput (closed object). The report registry decides unknown (404) / not schedulable (400) AFTER the shape is valid; the caller's report permissions are the handler's job. */
export function parseScheduleBody(body: unknown): ScheduleInput {
  if (!isObj(body) || Object.keys(body).some((k) => !BODY_KEYS.includes(k))) throw invalidField('body');
  validateScheduleName(body.name);
  const codes = body.report_codes;
  if (!Array.isArray(codes) || codes.length < 1 || codes.length > 10 || new Set(codes).size !== codes.length
    || codes.some((c) => typeof c !== 'string' || c.length < 1 || c.length > 32)) throw invalidField('report_codes');
  const frequency = body.frequency;
  if (typeof frequency !== 'string' || !(SCHEDULE_FREQUENCIES as readonly string[]).includes(frequency)) throw invalidField('frequency');
  const time = body.send_time_local;
  if (typeof time !== 'string' || !HM.test(time)) throw invalidField('send_time_local');
  let weekday: number | null = null;
  if (frequency === 'weekly') {
    const w = body.weekday;
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 7) throw invalidField('weekday');
    weekday = w;
  } else if (body.weekday !== undefined && body.weekday !== null) throw invalidField('weekday');
  const rule = body.period_rule;
  if (typeof rule !== 'string' || !(PERIOD_RULES as readonly string[]).includes(rule)) throw invalidField('period_rule');
  const sc = body.scope;
  if (!isObj(sc) || Object.keys(sc).some((k) => k !== 'all_centres' && k !== 'centre_ids') || typeof sc.all_centres !== 'boolean') throw invalidField('scope');
  const all = sc.all_centres;
  let centreIds: string[] = [];
  if (all) {
    if (sc.centre_ids !== undefined && !(Array.isArray(sc.centre_ids) && sc.centre_ids.length === 0)) throw invalidField('scope.centre_ids');
  } else centreIds = uuidList(sc.centre_ids, 'scope.centre_ids', 1, 20);
  const recipientIds = uuidList(body.recipient_membership_ids, 'recipient_membership_ids', 1, 20);
  return { name: body.name as string, reportCodes: [...(codes as string[])], frequency, sendTimeLocal: time, weekday, periodRule: rule as PeriodRule, scope: { all, centreIds }, recipientIds };
}

/** Registry lookup in body order: unknown -> 404 analytics.report_unknown; a report that cannot be scheduled (interfaces) -> 400. Returns the distinct permissions to require of the caller. */
export function schedulePermissions(codes: readonly string[]): string[] {
  const defs = codes.map((c) => getReport(c));
  if (defs.some((d) => !d.schedulable)) throw invalidField('report_codes');
  return [...new Set(defs.map((d) => d.permission))];
}

/** If-Match "<version>" (02-CV §4.2). Absent -> 428; malformed -> 400. */
export function parseIfMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2_147_483_647) throw invalidField('If-Match');
  return Number(m[1]);
}

export const scheduleIdOf = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw notFound();
  return v;
};

// ------------------------------------------------------------------ checks that read the core
/** Scope snapshot (P1): the caller's own scope bounds it. A foreign / out-of-scope centre is 404; an all-centre snapshot needs an all-centre caller. */
async function snapshotScope(ctx: ScheduleCtx, want: ScheduleInput['scope']): Promise<{ all: boolean; centreIds: string[] }> {
  const own = await resolveScope(ctx as never, {});
  if (want.all) {
    if (!own.all) throw invalidField('scope.all_centres'); // [CONV] never widen: a centre-restricted caller cannot snapshot "all centres"
    return { all: true, centreIds: [] };
  }
  const s = await resolveScope(ctx as never, { centreIds: want.centreIds });
  return { all: false, centreIds: [...s.centreIds] };
}

/** 404 common.not_found for another tenant's / unknown membership (no oracle); 422 analytics.recipient_ineligible for an inactive / locked one or one without analytics.dashboard.read. */
async function assertRecipientEligible(ctx: ScheduleCtx, membershipId: string): Promise<void> {
  const m = await ctx.core.membership(ctx as never, { membershipId }).catch(asApiError);
  if (!m.isActive || m.status !== 'active' || m.lockedAt) throw new LimsError('analytics.recipient_ineligible');
  const perms = await ctx.core.membershipPermissions(ctx as never, { membershipId }).catch(asApiError);
  if (!perms.includes(DASH)) throw new LimsError('analytics.recipient_ineligible');
}

const lastRunOf = async (ctx: ScheduleCtx, s: repo.ScheduleRow) => {
  if (!s.last_run_id) return undefined;
  const run = await repo.getRun(ctx.tx, { tenantId: ctx.tenantId, id: s.last_run_id }); // RLS: only the owner / a recipient sees it
  return run ? toRunSummary(run) : undefined;
};
const dtoOf = async (ctx: ScheduleCtx, s: repo.ScheduleRow, recipients: readonly repo.RecipientRow[]) => toScheduleDto(s, activeRecipientIds(recipients), await lastRunOf(ctx, s));

// ------------------------------------------------------------------ #25 create
export async function createSchedule(ctx: ScheduleCtx, input: ScheduleInput) {
  const owner = ctx.actor.membershipId;
  if (!owner) throw new LimsError('auth.forbidden');
  const scope = await snapshotScope(ctx, input.scope);
  for (const id of input.recipientIds) await assertRecipientEligible(ctx, id);

  // count + insert are one critical section per tenant (like the export quota, X16): two parallel creates cannot both see 19.
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`analytics.schedules:${ctx.tenantId}`]);
  if (await repo.countActiveSchedules(ctx.tx, { tenantId: ctx.tenantId }) >= loadAnalyticsConfig().maxSchedulesPerTenant) {
    throw new LimsError('common.validation_failed', 'Too many active schedules', [{ path: '', code: 'common.field_invalid', message: 'Field invalid' }]); // 08 A13 P-1
  }
  const row = await repo.insertSchedule(ctx.tx, {
    tenantId: ctx.tenantId, id: uuidv7(), name: input.name, reportCodes: input.reportCodes, frequency: input.frequency, sendTimeLocal: input.sendTimeLocal, weekday: input.weekday,
    periodRule: input.periodRule, scopeAllCentres: scope.all, scopeCentreIds: scope.centreIds, ownerMembershipId: owner,
    nextRunAt: nextSlot({ frequency: input.frequency, send_time_local: input.sendTimeLocal, weekday: input.weekday }, nowIso(ctx) as never), actorId: ctx.actor.id,
  });
  const recipients: repo.RecipientRow[] = [];
  for (const membershipId of input.recipientIds) {
    recipients.push(await repo.insertRecipient(ctx.tx, { tenantId: ctx.tenantId, id: uuidv7(), scheduleId: row.id, membershipId, actorId: ctx.actor.id }));
  }
  return { row, dto: await dtoOf(ctx, row, recipients) };
}

// ------------------------------------------------------------------ #27 update
export async function updateSchedule(ctx: ScheduleCtx, a: { id: string; expectedVersion: number; input: ScheduleInput }) {
  const cur = await repo.getSchedule(ctx.tx, { tenantId: ctx.tenantId, id: a.id, forUpdate: true });
  if (!cur) throw notFound();
  if (cur.version !== a.expectedVersion) throw new LimsError('common.version_conflict');
  // [CONV] a deactivated schedule is never silently revived (schedules__next__ck: inactive => no next_run_at): refused, 400 path ''.
  if (!cur.is_active) throw new LimsError('common.validation_failed', 'Schedule is deactivated', [{ path: '', code: 'common.field_invalid', message: 'Field invalid' }]);

  const { input } = a;
  const scope = await snapshotScope(ctx, input.scope);
  const rows = await repo.listRecipients(ctx.tx, { tenantId: ctx.tenantId, scheduleId: cur.id });
  const byMember = new Map(rows.map((r) => [r.membership_id, r]));
  const want = new Set(input.recipientIds);
  const adds = input.recipientIds.filter((m) => !byMember.get(m)?.is_active);          // new, or removed earlier and re-added (same row reactivated)
  for (const m of adds) await assertRecipientEligible(ctx, m);                           // all checks before any write

  const timingChanged = cur.frequency !== input.frequency || cur.send_time_local !== input.sendTimeLocal || (cur.weekday ?? null) !== input.weekday;
  const set: Record<string, unknown> = {
    name: input.name, report_codes: input.reportCodes, frequency: input.frequency, send_time_local: input.sendTimeLocal, weekday: input.weekday, period_rule: input.periodRule,
    scope_all_centres: scope.all, scope_centre_ids: scope.centreIds,
    ...(timingChanged ? { next_run_at: nextSlot({ frequency: input.frequency, send_time_local: input.sendTimeLocal, weekday: input.weekday }, nowIso(ctx) as never) } : {}),
  };
  const updated = await repo.updateSchedule(ctx.tx, { tenantId: ctx.tenantId, id: cur.id, expectedVersion: a.expectedVersion, set, actorId: ctx.actor.id });
  if (!updated) throw new LimsError('common.version_conflict'); // lost a race between the read and the write

  for (const r of rows) if (r.is_active && !want.has(r.membership_id)) await repo.setRecipientActive(ctx.tx, { tenantId: ctx.tenantId, id: r.id, isActive: false, actorId: ctx.actor.id });
  for (const m of adds) {
    const old = byMember.get(m);
    if (old) await repo.setRecipientActive(ctx.tx, { tenantId: ctx.tenantId, id: old.id, isActive: true, actorId: ctx.actor.id });
    else await repo.insertRecipient(ctx.tx, { tenantId: ctx.tenantId, id: uuidv7(), scheduleId: cur.id, membershipId: m, actorId: ctx.actor.id });
  }
  const after = await repo.listRecipients(ctx.tx, { tenantId: ctx.tenantId, scheduleId: cur.id });
  return { row: updated, dto: await dtoOf(ctx, updated, after) };
}

// ------------------------------------------------------------------ #28 deactivate
export async function deactivateSchedule(ctx: ScheduleCtx, a: { id: string; expectedVersion: number }) {
  const cur = await repo.getSchedule(ctx.tx, { tenantId: ctx.tenantId, id: a.id, forUpdate: true });
  if (!cur) throw notFound();
  if (cur.version !== a.expectedVersion) throw new LimsError('common.version_conflict');
  const row = cur.is_active
    ? await repo.updateSchedule(ctx.tx, { tenantId: ctx.tenantId, id: cur.id, expectedVersion: a.expectedVersion, set: { is_active: false, next_run_at: null }, actorId: ctx.actor.id })
    : cur;                                                                                // already inactive: nothing to write
  if (!row) throw new LimsError('common.version_conflict');
  return { row, dto: await dtoOf(ctx, row, await repo.listRecipients(ctx.tx, { tenantId: ctx.tenantId, scheduleId: cur.id })) };
}

// ------------------------------------------------------------------ #26 get, #24 list
export async function getSchedule(ctx: ScheduleCtx, id: string) {
  const row = await repo.getSchedule(ctx.tx, { tenantId: ctx.tenantId, id });
  if (!row) throw notFound(); // another tenant's / unknown: one shape (P1)
  const recipients = await repo.listRecipients(ctx.tx, { tenantId: ctx.tenantId, scheduleId: id });
  const runs = await repo.listRuns(ctx.tx, { tenantId: ctx.tenantId, scheduleId: id, limit: 20 });
  return { row, dto: toScheduleDetailDto(row, activeRecipientIds(recipients), runs) };
}

export async function listSchedules(ctx: ScheduleCtx, q: Record<string, any>) {
  const limit = checkInt(q.limit, 'limit', 1, 50, 20);
  let isActive: boolean | undefined;
  if (q.is_active !== undefined) {
    if (q.is_active === true || q.is_active === 'true') isActive = true;
    else if (q.is_active === false || q.is_active === 'false') isActive = false;
    else throw invalidField('is_active');
  }
  let after: { createdAt: string; id: string } | undefined;
  if (q.cursor !== undefined) {
    try {
      const c = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8'));
      if (typeof c?.t !== 'string' || Number.isNaN(Date.parse(c.t)) || typeof c?.id !== 'string' || !UUID.test(c.id)) throw new Error('bad');
      after = { createdAt: c.t, id: c.id };
    } catch { throw new LimsError('common.invalid_cursor'); }
  }
  const rows = await repo.listSchedules(ctx.tx, { tenantId: ctx.tenantId, isActive, after, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const data = [];
  for (const s of page) data.push(await dtoOf(ctx, s, await repo.listRecipients(ctx.tx, { tenantId: ctx.tenantId, scheduleId: s.id })));
  const last = page.at(-1);
  const next = rows.length > limit && last ? Buffer.from(JSON.stringify({ t: last.created_at, id: last.id })).toString('base64url') : undefined;
  return { data, page: { limit, ...(next ? { next_cursor: next } : {}) } };
}

// ------------------------------------------------------------------ #29 report run
/** P10: a same-tenant user who is neither a recipient of the run nor the schedule owner gets 404 (RLS says so too; the check here is defence in depth). */
export async function getReportRun(ctx: ScheduleCtx, runIdIn: unknown) {
  const membershipId = ctx.actor.membershipId;
  if (!membershipId) throw new LimsError('auth.forbidden');
  const id = scheduleIdOf(runIdIn);
  const run = await repo.getRun(ctx.tx, { tenantId: ctx.tenantId, id });
  if (!run) throw notFound();
  const mine = await repo.getRunRecipient(ctx.tx, { tenantId: ctx.tenantId, runId: run.id, membershipId });
  const schedule = await repo.getSchedule(ctx.tx, { tenantId: ctx.tenantId, id: run.schedule_id });
  if (!schedule) throw notFound();
  const isOwner = schedule.owner_membership_id === membershipId;
  if (!mine && !isOwner) throw notFound();

  const viewer = (await ctx.ports.IdentityPort.getActor(ctx as never).catch(asApiError)).centreScope;
  const eff = intersect({ all: viewer.all, centreIds: viewer.centreIds }, { all: run.scope_all_centres, centreIds: run.scope_centre_ids });

  let recipients;
  if (isOwner) {
    const rows = await repo.listRunRecipients(ctx.tx, { tenantId: ctx.tenantId, runId: run.id });
    const names = new Map<string, string>();
    if (rows.length) {
      for (const m of await ctx.core.memberships.list(ctx as never, { membershipIds: rows.map((r) => r.membership_id), activeOnly: false }).catch(asApiError)) names.set(m.membershipId, m.displayName);
    }
    recipients = rows.map((r) => ({ membership_id: r.membership_id, display_name: names.get(r.membership_id) ?? '', outcome: r.outcome }));
  }
  return toReportRunDto(run, schedule.name, { omitted: mine ? mine.omitted_report_codes : run.omitted_report_codes, effectiveScope: eff, recipients });
}

// ================================================================== dispatcher (02-TRD §9.6; worker, system transaction)
const RUN_TTL_MS = 400 * 86_400_000; // 08 A17 D-45
const MAX_DUE = 50;

export interface DispatchCtx extends ScheduleCtx {
  log: { info(o: object, msg?: string): void };
  metrics: { inc(name: string, labels?: Record<string, string>): void };
  core: ScheduleCtx['core'] & { tenant(ctx: never): Promise<{ displayName: string }> };
  ports: ScheduleCtx['ports'] & {
    IdentityPort: { getTenantSettings(ctx: never, i: { keys: string[] }): Promise<Record<string, unknown>> };
    NotificationPort: { sendEmailLink(ctx: never, i: object): Promise<{ deliveryId: string; status: string; replayed: boolean }> };
  };
}

function staffLink(runId: string): string {
  const origin = process.env.LIMS_ORIGIN_STAFF_WEB;
  if (!origin) throw new Error('LIMS_ORIGIN_STAFF_WEB is not set'); // D-29: absolute URL; never a relative path, never hard-coded
  return new URL(ROUTES['staff.analytics.report_run'].path.replace('{report_run_id}', runId), origin).href;
}

const isLimsCode = (c: unknown): c is string => typeof c === 'string' && /^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/.test(c);

/** One slot per due schedule per tick (the cron retries every 15 min): steps 1–7 of §9.6. Re-running the same slot creates no second run and sends nothing (US-18.5). */
export async function dispatchDueSchedules(ctx: DispatchCtx): Promise<void> {
  const tenantId = ctx.tenantId;
  const now = nowIso(ctx);
  const due = await repo.dueSchedules(ctx.tx, { tenantId, now, limit: MAX_DUE });
  if (due.length === 0) return;
  const labName = (await ctx.core.tenant(ctx as never)).displayName;
  const flagOn = (await ctx.ports.IdentityPort.getTenantSettings(ctx as never, { keys: ['referralIncentiveReportEnabled'] })).referralIncentiveReportEnabled === true; // read per tick, never cached
  const expiresAt = new Date(Date.parse(now) + RUN_TTL_MS).toISOString();

  for (const s of due) {
    const slotStart = new Date(s.next_run_at as string).toISOString();
    const period = schedulePeriod(s.period_rule as PeriodRule, businessDateOf(slotStart as never));
    const next = nextSlot(s, slotStart as never);
    const omittedRun = !flagOn && s.report_codes.includes('referral_incentive') ? ['referral_incentive'] : [];
    const remaining = s.report_codes.filter((c) => !omittedRun.includes(c));
    const state = isSlotLate(slotStart as never, now as never) ? 'skipped_late' : remaining.length === 0 ? 'skipped_flag_off' : 'dispatched';
    const runId = uuidv7();

    const inserted = await repo.insertRun(ctx.tx, {
      tenantId, id: runId, scheduleId: s.id, slotStart, reportCodes: s.report_codes, omittedReportCodes: state === 'skipped_late' ? [] : omittedRun, periodFrom: period.from, periodTo: period.to,
      scopeAllCentres: s.scope_all_centres, scopeCentreIds: s.scope_centre_ids, state, createdBy: ctx.actor.id, expiresAt,
    });
    if (!inserted) { await repo.advanceSchedule(ctx.tx, { tenantId, id: s.id, nextRunAt: next, lastRunId: null }); continue; } // already dispatched (cron twice / row restored)

    let sent = 0, skipped = 0;
    if (state === 'dispatched') {
      const recipients = (await repo.listRecipients(ctx.tx, { tenantId, scheduleId: s.id })).filter((r) => r.is_active); // D-45
      for (const r of recipients) {
        const row = await dispatchOne(ctx, { schedule: s, runId, slotStart, labName, remaining, memberId: r.membership_id });
        await repo.insertRunRecipient(ctx.tx, { tenantId, id: uuidv7(), runId, scheduleId: s.id, membershipId: r.membership_id, createdBy: ctx.actor.id, expiresAt, ...row });
        ctx.metrics.inc('lims_analytics_schedule_sends_total', { outcome: row.outcome });
        if (row.outcome === 'queued' || row.outcome === 'suppressed') sent++; else skipped++;
      }
      await repo.finishRun(ctx.tx, { tenantId, runId, sentCount: sent, skippedCount: skipped });
    }
    await repo.advanceSchedule(ctx.tx, { tenantId, id: s.id, nextRunAt: next, lastRunId: runId });
    ctx.log.info({ event: 'analytics_schedule_dispatched', tenant_id: tenantId, schedule_id: s.id, run_id: runId, state, recipients_sent: sent, recipients_skipped: skipped }, 'analytics_schedule_dispatched'); // ids and counts only
  }
}

/** Steps 5–6 for one recipient: eligibility -> omissions -> sendEmailLink. A rejected send fails only this recipient. */
async function dispatchOne(ctx: DispatchCtx, a: { schedule: repo.ScheduleRow; runId: string; slotStart: string; labName: string; remaining: readonly string[]; memberId: string }) {
  const none = { omittedReportCodes: [] as string[], deliveryId: null, notificationStatus: null, errorCode: null };
  const skip = { outcome: 'skipped_ineligible', ...none };
  let perms: readonly string[];
  try {
    const m = await ctx.core.membership(ctx as never, { membershipId: a.memberId });
    if (!m.isActive || m.status !== 'active' || m.lockedAt) return skip;
    perms = await ctx.core.membershipPermissions(ctx as never, { membershipId: a.memberId });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'common.not_found') return skip; // unknown membership = ineligible
    throw e;
  }
  if (!perms.includes(DASH)) return skip;
  const omitted = a.remaining.filter((c) => !perms.includes(getReport(c).permission)); // report-specific permission of the pack: omitted for THIS recipient
  if (omitted.length === a.remaining.length) return skip;                                // nothing left to open [CONV]
  try {
    const res = await ctx.ports.NotificationPort.sendEmailLink(ctx as never, {
      recipient: { kind: 'staff', membershipId: a.memberId, requiredPermission: DASH },
      templateCode: 'analytics.report_ready', purpose: 'scheduled_report_ready',
      params: { lab_name: a.labName, schedule_name: a.schedule.name },
      idempotencyKey: `${a.schedule.id}:${a.slotStart}:${a.memberId}`,
      related: { entityType: 'report_run', entityId: a.runId },
      linkUrl: staffLink(a.runId),
    });
    if (res.status === 'queued') return { outcome: 'queued', omittedReportCodes: omitted, deliveryId: res.deliveryId, notificationStatus: 'queued', errorCode: null };
    if (typeof res.status === 'string' && res.status.startsWith('suppressed_')) return { outcome: 'suppressed', omittedReportCodes: omitted, deliveryId: res.deliveryId, notificationStatus: res.status, errorCode: null };
    return { outcome: 'failed', ...none, omittedReportCodes: omitted, errorCode: 'common.internal' };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (isLimsCode(code)) return { outcome: 'failed', ...none, omittedReportCodes: omitted, errorCode: code };
    throw e; // infrastructure failure: the job transaction rolls back and the cron retries (the send is idempotent by key)
  }
}
