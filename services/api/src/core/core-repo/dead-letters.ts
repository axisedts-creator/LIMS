// ctx.core.deadLetters (02-TRD §6.8, §7.4; 08 A6.4, A8.4, A8.5, A9.1-A9.4, A10.1, A10.4, A23.2). Internal to core.
// job_payload / job_key never leave this file except as values bound to app.enqueue_job: not returned, logged, or put in an error.
// Tenant rows: direct SQL through the __platform policies (tenant_id IS NOT NULL). Platform rows (tenant_id IS NULL): only via the
// DEFINER functions app.dl_list_platform / app.dl_resolve.
import { LimsError } from '../errors.js';

export interface DeadLetterRow {
  readonly id: string; readonly tenantId: string | null; readonly taskIdentifier: string;
  readonly lastErrorCode: string; readonly lastErrorMessageRedacted: string; readonly attempts: number;
  readonly firstFailedAt: string; readonly deadAt: string; readonly state: 'open' | 'replayed' | 'discarded';
  readonly resolvedBy: string | null; readonly resolvedAt: string | null; readonly resolutionNote: string | null; readonly version: number;
}
interface DlResolveResult extends DeadLetterRow { readonly jobPayload: Readonly<Record<string, unknown>> | null }

/** 02-TRD §6.8: `row` is the only shape ever returned or logged; `payload` goes only to app.enqueue_job. */
export function stripPayload(r: DlResolveResult): { readonly row: DeadLetterRow; readonly payload: Readonly<Record<string, unknown>> | null } {
  const { jobPayload, ...row } = r;
  return { row, payload: jobPayload };
}

export interface DeadLetterDeps {
  /** Core-internal 4-arg form (08 A23.2): tenant claims for `systemActorId` on the request transaction. */
  readonly withTenantScope: <T>(tx: unknown, tenantId: string, systemActorId: string, fn: () => Promise<T>) => Promise<T>;
  readonly systemActorOf: (module: string) => string;
  readonly log?: { info(o: object, m?: string): void };
}
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface Ctx { readonly tx: unknown }

const COLS = `id, tenant_id, task_identifier, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state,
  resolved_by, resolved_at, resolution_note, version`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES = ['open', 'replayed', 'discarded'];
const PG_INT_MAX = 2147483647;

const invalid = (path: string) => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function toRow(r: any): DeadLetterRow {
  return {
    id: r.id, tenantId: r.tenant_id ?? null, taskIdentifier: r.task_identifier, lastErrorCode: r.last_error_code,
    lastErrorMessageRedacted: r.last_error_message_redacted, attempts: Number(r.attempts), firstFailedAt: iso(r.first_failed_at)!,
    deadAt: iso(r.dead_at)!, state: r.state, resolvedBy: r.resolved_by ?? null, resolvedAt: iso(r.resolved_at),
    resolutionNote: r.resolution_note ?? null, version: Number(r.version),
  };
}

// 02-CV §4.3: opaque base64url cursor = last row's sort key + id.
const encodeCursor = (r: DeadLetterRow) => Buffer.from(JSON.stringify({ k: r.deadAt, i: r.id })).toString('base64url');
function decodeCursor(c: unknown): { k: string; i: string } {
  try {
    if (typeof c !== 'string' || c.length > 512) throw 0;
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (typeof o?.k === 'string' && ISO.test(o.k) && typeof o?.i === 'string' && UUID.test(o.i)) return { k: o.k, i: o.i };
  } catch { /* fallthrough */ }
  throw new LimsError('common.invalid_cursor');
}

export interface ListInput {
  readonly state?: string; readonly platformRows?: boolean; readonly tenantId?: string; readonly taskIdentifier?: string;
  readonly deadAtFrom?: string; readonly deadAtTo?: string; readonly cursor?: string; readonly limit?: number;
}

/** 1–500 chars (dead_letters__resolution_note__ck counts characters, not UTF-16 units). */
const noteOk = (s: unknown): s is string => typeof s === 'string' && [...s].length >= 1 && [...s].length <= 500;

export function createDeadLetters(deps: DeadLetterDeps) {
  async function list(ctx: Ctx, input: ListInput = {}) {
    const i = input ?? {};
    if (i.state !== undefined && !STATES.includes(i.state)) throw invalid('/state');
    if (i.tenantId !== undefined && !(typeof i.tenantId === 'string' && UUID.test(i.tenantId))) throw invalid('/tenantId');
    if (i.taskIdentifier !== undefined && !(typeof i.taskIdentifier === 'string' && i.taskIdentifier.length >= 1 && i.taskIdentifier.length <= 200)) throw invalid('/taskIdentifier');
    for (const k of ['deadAtFrom', 'deadAtTo'] as const) if (i[k] !== undefined && !(typeof i[k] === 'string' && ISO.test(i[k]!))) throw invalid(`/${k}`);
    const limit = i.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('/limit');
    const after = i.cursor === undefined ? undefined : decodeCursor(i.cursor);
    const tx = ctx.tx as Tx;

    let rows: any[];
    if (i.platformRows === true) {
      if (i.tenantId !== undefined) return { items: [] }; // platform rows have tenant_id IS NULL: combined filter matches nothing
      ({ rows } = await tx.query(`SELECT ${COLS} FROM app.dl_list_platform($1, $2, $3, $4, $5, $6, $7)`, [
        i.state ?? null, i.taskIdentifier ?? null, i.deadAtFrom ?? null, i.deadAtTo ?? null, after?.k ?? null, after?.i ?? null, limit + 1,
      ]));
    } else {
      const where = ['tenant_id IS NOT NULL'];
      const values: unknown[] = [];
      const bind = (sql: string, v: unknown) => { values.push(v); where.push(sql.replace('?', `$${values.length}`)); };
      if (i.state !== undefined) bind('state = ?', i.state);
      if (i.tenantId !== undefined) bind('tenant_id = ?', i.tenantId);
      if (i.taskIdentifier !== undefined) bind('task_identifier = ?', i.taskIdentifier);
      if (i.deadAtFrom !== undefined) bind('dead_at >= ?', i.deadAtFrom);      // inclusive (02-CV §4.4)
      if (i.deadAtTo !== undefined) bind('dead_at < ?', i.deadAtTo);           // exclusive
      if (after) { values.push(after.k, after.i); where.push(`(dead_at, id) < ($${values.length - 1}, $${values.length})`); }
      values.push(limit + 1);
      ({ rows } = await tx.query(
        `SELECT ${COLS} FROM core.dead_letters WHERE ${where.join(' AND ')} ORDER BY dead_at DESC, id DESC LIMIT $${values.length}`, values));
    }
    const items = rows.slice(0, limit).map(toRow);
    return rows.length > limit ? { items, nextCursor: encodeCursor(items[items.length - 1]!) } : { items };
  }

  async function get(ctx: Ctx, input: { deadLetterId: string }): Promise<DeadLetterRow> {
    const id = input?.deadLetterId;
    if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
    const tx = ctx.tx as Tx;
    let { rows } = await tx.query(`SELECT ${COLS} FROM core.dead_letters WHERE id = $1 AND tenant_id IS NOT NULL`, [id]);
    if (rows.length === 0) ({ rows } = await tx.query(`SELECT ${COLS} FROM app.dl_list_platform(p_dead_letter_id => $1)`, [id]));
    if (rows.length === 0) throw new LimsError('common.not_found');
    return toRow(rows[0]);
  }

  /** Version-guarded state change: tenant row via the __platform policies, else platform row via app.dl_resolve. 0 rows → 409. */
  async function resolve(tx: Tx, id: string, expectedVersion: number, state: 'replayed' | 'discarded', note: string | null) {
    let { rows } = await tx.query(
      `UPDATE core.dead_letters
          SET state = $3, resolved_by = app.current_actor_id(), resolved_at = now(), resolution_note = $4, version = version + 1
        WHERE id = $1 AND tenant_id IS NOT NULL AND state = 'open' AND version = $2
        RETURNING ${COLS}, job_payload, job_key`, [id, expectedVersion, state, note]);
    if (rows.length === 0) {
      ({ rows } = await tx.query(`SELECT ${COLS}, job_payload, job_key FROM app.dl_resolve($1, $2, $3, $4)`, [id, expectedVersion, state, note]));
    }
    if (rows.length === 0) throw new LimsError('common.version_conflict');
    const r = rows[0];
    return { ...stripPayload({ ...toRow(r), jobPayload: r.job_payload ?? null }), jobKey: (r.job_key ?? null) as string | null };
  }

  function checkCommon(input: { deadLetterId?: unknown; expectedVersion?: unknown }): { id: string; v: number } {
    const id = input?.deadLetterId;
    const v = input?.expectedVersion;
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid('/expectedVersion');
    if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
    if (v < 1 || v > PG_INT_MAX) throw new LimsError('common.version_conflict');   // no row can have this version
    return { id, v };
  }

  async function replay(ctx: Ctx, input: { deadLetterId: string; expectedVersion: number; reasonText?: string }): Promise<void> {
    const { id, v } = checkCommon(input);
    if (input.reasonText !== undefined && !noteOk(input.reasonText)) throw invalid('/reasonText');
    const tx = ctx.tx as Tx;
    const { row, payload, jobKey } = await resolve(tx, id, v, 'replayed', input.reasonText ?? null);
    if (payload === null) throw new LimsError('common.internal');
    // 08 A23.2: every replay key is distinct (version after the bump), a second replay is impossible (only open rows).
    const key = `${jobKey ?? `${row.taskIdentifier}:${row.id}`}:replay:${row.version}`;
    const enqueue = () => tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [row.taskIdentifier, JSON.stringify(payload), key]);
    if (row.tenantId === null) {
      await enqueue();   // platform task: app.enqueue_job skips the tenant-match check
    } else {
      const reg = await tx.query('SELECT module FROM core.g_task_registry WHERE identifier = $1', [row.taskIdentifier]);
      const module = reg.rows[0]?.module;
      if (typeof module !== 'string') throw new LimsError('common.internal');
      await deps.withTenantScope(tx, row.tenantId, deps.systemActorOf(module), enqueue);
    }
    deps.log?.info({ event: 'dead_letter_replayed', dead_letter_id: row.id, task_identifier: row.taskIdentifier, version: row.version });
  }

  async function discard(ctx: Ctx, input: { deadLetterId: string; expectedVersion: number; reasonText: string }): Promise<void> {
    const { id, v } = checkCommon(input);
    if (!noteOk(input.reasonText)) throw invalid('/reasonText');
    const { row } = await resolve(ctx.tx as Tx, id, v, 'discarded', input.reasonText);
    deps.log?.info({ event: 'dead_letter_discarded', dead_letter_id: row.id, task_identifier: row.taskIdentifier, version: row.version });
  }

  return { list, get, replay, discard };
}
