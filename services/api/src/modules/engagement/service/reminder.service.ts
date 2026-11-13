// R1 listReminders, R2 createReminder, R3 cancelReminder (02-TRD §4.11, §5; 05-SCHEMA reminders; US-EN-23.1, 23.4; REQ-SEC-017/-080).
// Tenant and actor come from ctx only. Errors carry fixed text: no submitted value is echoed. Creating never sends: the dispatcher cron does.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { isUuid } from './queue.service.js';
import { listCodedSet as defaultListCodedSet } from '../repository/codedsets.repo.js';
import * as defaultRepo from '../repository/reminder.repo.js';
import { REMINDER_STATUSES, canTransition, type ReminderStatus } from '../domain/reminder.state.js';

export interface ReminderCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
  now(): string;
}
export type ReminderRepo = typeof defaultRepo;

const HOUR = 3_600_000;
const MIN_LEAD_MS = HOUR;                       // due_at >= now + 1 h (TRD §4.11)
const MAX_WINDOW_MS = 92 * 24 * HOUR;           // R1 window <= 92 d
const REASON = /^[a-z0-9_]{1,64}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CREATE_KEYS = new Set(['patient_id', 'reason_code', 'due_at', 'source_ref_id']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]);
};
const isoMs = (v: unknown): number => (typeof v === 'string' && ISO_UTC.test(v) ? Date.parse(v) : NaN);

function scope(ctx: ReminderCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}

/** If-Match arrives as the raw header '"<version>"' (02-CV §4.2): absent -> 428, malformed -> 400. */
function parseIfMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const n = m ? Number(m[1]) : 0;
  if (n < 1 || n > 2147483647) return invalid('/If-Match');
  return n;
}

const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
/** Row -> Reminder schema: only schema fields; NULL columns omitted. */
function toBody(r: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r['id'], patient_id: r['patient_id'], kind: r['kind'], source: r['source'], due_at: iso(r['due_at']), status: r['status'], version: r['version'] };
  if (r['reason_code'] != null) out['reason_code'] = r['reason_code'];
  if (r['sent_at'] != null) out['sent_at'] = iso(r['sent_at']);
  if (r['failure_code'] != null) out['failure_code'] = r['failure_code'];
  return out;
}

const encodeCursor = (r: Record<string, any>) => Buffer.from(JSON.stringify([iso(r['due_at']), r['id']])).toString('base64url');
function decodeCursor(c: unknown): { dueAt: string; id: string } | undefined {
  if (c === undefined) return undefined;
  try {
    if (typeof c !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(c)) throw new Error('shape');
    const [dueAt, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown[];
    if (!Number.isFinite(isoMs(dueAt)) || !isUuid(id)) throw new Error('shape');
    return { dueAt: dueAt as string, id };
  } catch { return invalid('/cursor'); }
}

export function createReminderService(deps: { repo?: ReminderRepo; listCodedSet?: typeof defaultListCodedSet } = {}) {
  const repo = deps.repo ?? defaultRepo;
  const listSet = deps.listCodedSet ?? defaultListCodedSet;

  return {
    /** T-B5 (TRD §4.8 create step 7, §4.11 row `booking`; US-EN-25.1): a reminder due at slot_start - H, only when slot_start - now > H (strictly). Never sends. undefined = none scheduled (or already there). */
    async scheduleBookingReminder(ctx: ReminderCtx, input: { bookingId: unknown; patientId: unknown; slotStart: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      if (!isUuid(input?.bookingId)) return invalid('/bookingId');
      if (!isUuid(input.patientId)) return invalid('/patientId');
      const slot = isoMs(input.slotStart);
      if (!Number.isFinite(slot)) return invalid('/slotStart');
      const hours = (await repo.bookingReminderHours(tx, { tenantId })) ?? 24;   // [CONV] 05-SCHEMA default; no settings row cannot happen on a booking path
      if (!(slot - Date.parse(ctx.now()) > hours * HOUR)) return undefined;
      return repo.insertBookingReminder(tx, { tenantId, userId, patientId: input.patientId, bookingId: input.bookingId, dueAt: new Date(slot - hours * HOUR).toISOString() });
    },

    /** T-B5 (TRD §4.8 cancel; US-EN-25.2): pending booking reminders of that booking -> cancelled. Returns the number cancelled. */
    async cancelBookingReminders(ctx: ReminderCtx, input: { bookingId: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      if (!isUuid(input?.bookingId)) return invalid('/bookingId');
      return repo.cancelBookingReminders(tx, { tenantId, userId, bookingId: input.bookingId });
    },

    async list(ctx: ReminderCtx, q: unknown) {
      const { tx, tenantId } = scope(ctx);
      const query = isObj(q) ? q : {};
      const from = isoMs(query['due_from']), to = isoMs(query['due_to']);
      if (!Number.isFinite(from)) invalid('/due_from', query['due_from'] === undefined ? 'common.field_required' : 'common.field_invalid');
      if (!Number.isFinite(to)) invalid('/due_to', query['due_to'] === undefined ? 'common.field_required' : 'common.field_invalid');
      if (to < from || to - from > MAX_WINDOW_MS) invalid('/due_to', 'common.field_invalid', 'Window must be 0-92 days');
      const status = query['status'];
      if (status !== undefined && !(REMINDER_STATUSES as readonly unknown[]).includes(status)) invalid('/status');
      const patientId = query['patient_id'];
      if (patientId !== undefined && !isUuid(patientId)) invalid('/patient_id');
      const rawLimit = query['limit'];
      const limit = rawLimit === undefined ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('/limit');
      const after = decodeCursor(query['cursor']);
      const rows = await repo.listReminders(tx, { tenantId, from: query['due_from'] as string, to: query['due_to'] as string, patientId: patientId as string | undefined, status: status as string | undefined, ...(after ? { after } : {}), limit: limit + 1 });
      const page = rows.slice(0, limit);
      return { data: page.map(toBody), page: { limit, ...(rows.length > limit ? { next_cursor: encodeCursor(page[page.length - 1]!) } : {}) } };
    },

    async create(ctx: ReminderCtx, input: { body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const b = input.body;
      if (!isObj(b)) return invalid('/');
      for (const k of Object.keys(b)) if (!CREATE_KEYS.has(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field'); // mass assignment (status, tenant_id, version, ...)
      for (const k of ['patient_id', 'reason_code', 'due_at']) if (b[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
      if (!isUuid(b['patient_id'])) invalid('/patient_id');
      if (typeof b['reason_code'] !== 'string' || !REASON.test(b['reason_code'])) invalid('/reason_code');
      const due = isoMs(b['due_at']);
      if (!Number.isFinite(due) || due < Date.parse(ctx.now()) + MIN_LEAD_MS) invalid('/due_at', 'common.field_invalid', 'Must be at least 1 hour ahead');
      const ref = b['source_ref_id'];
      if (ref !== undefined && !isUuid(ref)) invalid('/source_ref_id');
      const reasons = await listSet(tx, { tenantId, setName: 'reminder_reasons' });
      if (!reasons.some((r) => r['code'] === b['reason_code'] && r['is_active'] !== false)) invalid('/reason_code', 'common.field_invalid', 'Unknown reason');
      try {
        const row = await repo.insertReminder(tx, { tenantId, userId, patientId: b['patient_id'] as string, kind: ref === undefined ? 'custom' : 'follow_up', reasonCode: b['reason_code'] as string, sourceRefId: (ref as string | undefined) ?? null, dueAt: b['due_at'] as string });
        if (!row) throw new LimsError('common.internal');
        return toBody(row);
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (!(e instanceof LimsError) && code === '23505') return invalid('/source_ref_id', 'common.field_invalid', 'Reminder already exists');   // partial unique (kind, source_ref_id, seq)
        if (!(e instanceof LimsError) && code === '23503') return invalid('/patient_id');                                                                // composite FK to frontdesk.patients
        throw e;
      }
    },

    async cancel(ctx: ReminderCtx, input: { id: unknown; headers: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/reminder_id');
      const row = await repo.getReminder(tx, { tenantId, id: input.id });
      if (!row) throw new LimsError('common.not_found');                       // unknown or another tenant's: never revealed
      if (row['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
      if (!canTransition(row['status'] as ReminderStatus, 'cancelled')) throw new LimsError('engagement.reminder_invalid_transition');
      const done = await repo.cancelReminder(tx, { tenantId, id: input.id, expectedVersion, userId });
      if (!done) throw new LimsError('common.version_conflict');               // changed between read and write (e.g. the dispatcher sent it)
      return toBody(done);
    },
  };
}
export type ReminderService = ReturnType<typeof createReminderService>;
