// Shared fixtures for the T0D-08 core-repo tests (ctx.core.deadLetters, memberships, centres). Synthetic data only.
// A fake of ONE Postgres connection with transaction semantics and just enough SQL intent recognition for the dead-letter paths:
//   - core.dead_letters is visible/updatable only for tenant rows (the __platform policies, 08 A10.4); platform rows (tenant_id NULL)
//     are reachable only through app.dl_list_platform / app.dl_resolve (SECURITY DEFINER, 08 A9.4)
//   - the version guard, the state check and the CHECK constraints of 05-SCHEMA are enforced here
//   - app.enqueue_job enforces the tenant match for per_tenant tasks (job_tenant_mismatch), skipped for platform tasks
// Values are matched by CONTENT, never by position, so the tests do not pin the implementation's SQL layout.
// What this fake cannot prove (real WHERE semantics, RLS) belongs to db/tests and is listed in .orchestra/notes/T0D-08-tests.md.

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const PLATFORM_USER = '0190a000-0000-7000-8000-00000000f001';
export const BILLING_ACTOR = '0190a000-0000-7000-8000-0000000051a1';   // billing's system actor
export const CATALOG_ACTOR = '0190a000-0000-7000-8000-0000000051a2';   // catalog's system actor
export const systemActorOf = (m: string): string => {
  const a = ({ billing: BILLING_ACTOR, catalog: CATALOG_ACTOR } as Record<string, string>)[m];
  if (!a) throw new Error(`no system actor for ${m}`);
  return a;
};
export const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
/** Appears only inside job_payload values: must never leave core (return value, DeadLetterRow, log, error, metric). */
export const SECRET = 'PAYLOAD-SENTINEL-7f3a';

export const TASKS: Record<string, { module: string; scope: 'per_tenant' | 'platform' }> = {
  'billing.recompute_balance': { module: 'billing', scope: 'per_tenant' },
  'evt.billing.frontdesk.order.created.v1': { module: 'billing', scope: 'per_tenant' },
  'catalog.publish_revision': { module: 'catalog', scope: 'per_tenant' },
  'core.retention_purge': { module: 'core', scope: 'platform' },
};

export interface DlRow {
  id: string; tenant_id: string | null; task_identifier: string; job_payload: Record<string, unknown>;
  last_error_code: string; last_error_message_redacted: string; attempts: number;
  first_failed_at: Date; dead_at: Date; state: 'open' | 'replayed' | 'discarded';
  resolved_by: string | null; resolved_at: Date | null; resolution_note: string | null; job_key: string | null; version: number;
}

let seq = 0;
export const idN = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const day = (d: number, h = 0) => new Date(Date.UTC(2026, 10, d, h, 0, 0, 0));

export function dl(over: Partial<DlRow> = {}): DlRow {
  const n = ++seq;
  const tenant = over.tenant_id === undefined ? TENANT_A : over.tenant_id;
  return {
    id: idN(0x1000 + n), tenant_id: tenant,
    task_identifier: tenant === null ? 'core.retention_purge' : 'billing.recompute_balance',
    job_payload: tenant === null ? { batch: SECRET, table: 'core.event_log' } : { tenant_id: tenant, invoice_id: idN(0x2000 + n), note: SECRET },
    last_error_code: 'common.internal', last_error_message_redacted: 'handler failed', attempts: 10,
    first_failed_at: day(1), dead_at: day(2), state: 'open', resolved_by: null, resolved_at: null, resolution_note: null,
    job_key: null, version: 3, ...over,
  };
}

export interface Enqueued { identifier: string; payload: Record<string, unknown>; jobKey: string | null; scopeTenant: string | null; scopeActor: string | null; seqNo: number }
export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly scope: string | null }
export const pgError = (code: string, message: string, constraint?: string) => Object.assign(new Error(message), { code, constraint });

const UUIDRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: unknown): string | undefined => v instanceof Date ? v.toISOString() : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toISOString() : undefined;

export function makeDeadLetterDb(initial: DlRow[] = []) {
  let committed = { rows: initial.map((r) => ({ ...r })), jobs: [] as Enqueued[] };
  let work = committed;
  const stmts: Stmt[] = [];
  const events: Array<{ type: 'scope-enter' | 'scope-exit' | 'enqueue'; tenantId?: string | null; actorId?: string | null; seqNo: number }> = [];
  const state = { scopeTenant: null as string | null, scopeActor: null as string | null, tick: 0 };
  const failures: Array<{ match: RegExp; error: () => Error }> = [];

  const wants = (text: string, col: string) => text.includes(col) || /select\s+(?:distinct\s+)?(?:\w+\.)?\*/i.test(text) || /returning\s+(?:\w+\.)?\*/i.test(text);
  const out = (r: DlRow, text: string, extra: Record<string, unknown> = {}) => {
    const o: Record<string, unknown> = {
      id: r.id, tenant_id: r.tenant_id, task_identifier: r.task_identifier, last_error_code: r.last_error_code,
      last_error_message_redacted: r.last_error_message_redacted, attempts: r.attempts, first_failed_at: r.first_failed_at,
      dead_at: r.dead_at, state: r.state, resolved_by: r.resolved_by, resolved_at: r.resolved_at, resolution_note: r.resolution_note, version: r.version,
    };
    if (wants(text, 'job_payload')) o['job_payload'] = r.job_payload;
    if (wants(text, 'job_key')) o['job_key'] = r.job_key;
    if (/g_task_registry/i.test(text)) { o['module'] = TASKS[r.task_identifier]?.module; o['tenant_scope'] = TASKS[r.task_identifier]?.scope; }
    return { ...o, ...extra };
  };

  const checks = (r: DlRow) => {
    if (r.resolution_note !== null && (r.resolution_note.length < 1 || r.resolution_note.length > 500)) {
      throw pgError('23514', 'new row violates check constraint "dead_letters__resolution_note__ck"', 'dead_letters__resolution_note__ck');
    }
    if (!((r.state === 'open') === (r.resolved_at === null) && (r.resolved_at === null) === (r.resolved_by === null))) {
      throw pgError('23514', 'new row violates check constraint "dead_letters__resolved__ck"', 'dead_letters__resolved__ck');
    }
  };

  /** keyset page over `pool` (already sorted dead_at DESC, id DESC): limit = the one numeric bound, cursor = (dead_at, id) bound together. */
  function page(pool: DlRow[], values: readonly unknown[], text: string) {
    const sorted = [...pool].sort((a, b) => b.dead_at.getTime() - a.dead_at.getTime() || (a.id < b.id ? 1 : -1));
    const nums = values.filter((v): v is number => typeof v === 'number');
    const limit = nums.length ? nums[nums.length - 1]! : sorted.length;
    const isos = values.map(iso).filter((x): x is string => !!x);
    const afterId = values.find((v) => typeof v === 'string' && sorted.some((r) => r.id === v));
    const after = afterId ? sorted.find((r) => r.id === afterId) : undefined;
    let rows = sorted;
    if (after && isos.includes(after.dead_at.toISOString())) rows = sorted.filter((r) => r.dead_at < after.dead_at || (r.dead_at.getTime() === after.dead_at.getTime() && r.id < after.id));
    return rows.slice(0, limit).map((r) => out(r, text));
  }

  const tx = {
    startedAt: day(7, 12),
    operation: { module: 'identity', operationId: 'replayDeadLetter', context: 'platform' },
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values, scope: state.scopeTenant });
      const f = failures.find((x) => x.match.test(text));
      if (f) throw f.error();
      const rows = work.rows;

      if (/app\.dl_resolve\s*\(/i.test(text)) {
        const id = values.find((v) => typeof v === 'string' && rows.some((r) => r.id === v));
        const target = rows.find((r) => r.id === id && r.tenant_id === null);
        const newState = (['replayed', 'discarded'] as const).find((s) => values.includes(s) || text.includes(`'${s}'`));
        const note = values.find((v): v is string => typeof v === 'string' && v !== id && v !== newState && !UUIDRE.test(v)) ?? null;
        const version = values.find((v): v is number => typeof v === 'number');
        if (!newState || (newState === 'discarded' && note === null)) throw pgError('P0001', 'dl_resolve_invalid_input');
        if (!target || target.state !== 'open' || target.version !== version) return { rows: [] };
        const next: DlRow = { ...target, state: newState, resolved_by: PLATFORM_USER, resolved_at: day(7, 12), resolution_note: note, version: target.version + 1 };
        checks(next);
        Object.assign(target, next);
        return { rows: [out(target, 'job_payload job_key', { job_payload: newState === 'replayed' ? target.job_payload : null })] };
      }

      if (/app\.dl_list_platform\s*\(/i.test(text)) {
        const platform = rows.filter((r) => r.tenant_id === null);
        const id = values.find((v) => typeof v === 'string' && platform.some((r) => r.id === v));
        const hasCursorTs = values.some((v) => platform.some((r) => iso(v) === r.dead_at.toISOString()));
        if (id && !hasCursorTs) return { rows: platform.filter((r) => r.id === id).map((r) => out(r, 'dl_list_platform')) };
        // p_dead_letter_id of an unknown row (a get): no uuid bound and no cursor timestamp otherwise
        if (!id && !hasCursorTs && values.some((v) => typeof v === 'string' && UUIDRE.test(v))) return { rows: [] };
        return { rows: page(platform, values, 'dl_list_platform') };
      }

      if (/UPDATE\s+core\.dead_letters/i.test(text)) {
        const id = values.find((v) => typeof v === 'string' && rows.some((r) => r.id === v));
        const target = rows.find((r) => r.id === id && r.tenant_id !== null);
        const newState = (['replayed', 'discarded'] as const).find((s) => values.includes(s) || text.includes(`'${s}'`));
        const note = values.find((v): v is string => typeof v === 'string' && v !== id && v !== newState && !UUIDRE.test(v)) ?? null;
        const version = values.find((v): v is number => typeof v === 'number');
        if (!target || !newState || target.state !== 'open' || target.version !== version || !/version\s*=\s*(?:\w+\.)?version\s*\+\s*1/i.test(text)) {
          if (target && newState && target.state === 'open' && target.version === version) throw new Error('fake: UPDATE must bump version = version + 1');
          return { rows: [] };
        }
        const next: DlRow = {
          ...target, state: newState,
          resolved_by: /resolved_by/.test(text) ? PLATFORM_USER : null, resolved_at: /resolved_at/.test(text) ? day(7, 12) : null,
          resolution_note: /resolution_note/.test(text) ? note : null, version: target.version + 1,
        };
        checks(next);
        Object.assign(target, next);
        return { rows: /RETURNING/i.test(text) ? [out(target, text)] : [] };
      }

      if (/FROM\s+core\.g_task_registry/i.test(text) && !/core\.dead_letters/i.test(text)) {
        const ids = Object.keys(TASKS).filter((k) => values.includes(k) || text.includes(`'${k}'`));
        return { rows: ids.map((k) => ({ identifier: k, module: TASKS[k]!.module, tenant_scope: TASKS[k]!.scope })) };
      }

      if (/FROM\s+core\.dead_letters/i.test(text)) {
        const tenantRows = rows.filter((r) => r.tenant_id !== null);       // platform rows invisible (08 A10.4)
        const id = values.find((v) => typeof v === 'string' && tenantRows.some((r) => r.id === v));
        const hasCursorTs = values.some((v) => tenantRows.some((r) => iso(v) === r.dead_at.toISOString()));
        if (id && !hasCursorTs) return { rows: tenantRows.filter((r) => r.id === id).map((r) => out(r, text)) };
        if (!id && values.some((v) => typeof v === 'string' && UUIDRE.test(v)) && !values.some((v) => typeof v === 'number')) return { rows: [] };
        return { rows: page(tenantRows, values, text) };
      }

      if (/app\.enqueue_job/i.test(text)) {
        const identifier = Object.keys(TASKS).find((k) => values.includes(k) || text.includes(`'${k}'`));
        if (!identifier) throw new Error(`fake: enqueue_job for an unknown task (${text.slice(0, 60)})`);
        const raw = values.find((v) => v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v))
          ?? values.find((v) => typeof v === 'string' && v.startsWith('{') && (() => { try { JSON.parse(v); return true; } catch { return false; } })());
        const payload = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown> | undefined);
        if (!payload) throw new Error('fake: enqueue_job without a payload value');
        if (TASKS[identifier]!.scope === 'per_tenant' && (payload['tenant_id'] ?? null) !== state.scopeTenant) throw pgError('P0001', 'job_tenant_mismatch');
        const jobKey = (values.find((v) => typeof v === 'string' && v.includes(':replay:')) as string | undefined) ?? null;
        const e = ++state.tick;
        work.jobs.push({ identifier, payload, jobKey, scopeTenant: state.scopeTenant, scopeActor: state.scopeActor, seqNo: e });
        events.push({ type: 'enqueue', seqNo: e });
        return { rows: [{ enqueue_job: null }] };
      }
      return { rows: [] };
    },
    savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };

  /** Core-internal helper injected into createCoreRepo: 02-TRD §7.4 / 08 A23.2 (tenant claims + the owning module's system actor). */
  const withTenantScope = async <T>(t: unknown, tenantId: string, actorId: string, fn: () => Promise<T>): Promise<T> => {
    if (t !== tx) throw new Error('fake: withTenantScope must be given the request transaction');
    events.push({ type: 'scope-enter', tenantId, actorId, seqNo: ++state.tick });
    state.scopeTenant = tenantId; state.scopeActor = actorId;
    try { return await fn(); } finally { state.scopeTenant = null; state.scopeActor = null; events.push({ type: 'scope-exit', seqNo: ++state.tick }); }
  };

  async function transaction<T>(fn: () => Promise<T>, opts: { rollbackOnError?: boolean } = {}): Promise<T> {
    const snapshot = { rows: committed.rows.map((r) => ({ ...r })), jobs: [...committed.jobs] };
    work = { rows: committed.rows.map((r) => ({ ...r })), jobs: [...committed.jobs] };
    try {
      const r = await fn();
      committed = work;
      return r;
    } catch (e) {
      // default = ROLLBACK (the real request transaction); rollbackOnError:false keeps partial writes visible so a test can
      // prove the UPDATE itself was guarded rather than relying on the rollback.
      if (opts.rollbackOnError === false) committed = work; else { committed = snapshot; work = snapshot; }
      throw e;
    }
  }

  return {
    tx, stmts, events, transaction, withTenantScope,
    get rows() { return committed.rows; },
    get jobs() { return committed.jobs; },
    row: (id: string) => committed.rows.find((r) => r.id === id)!,
    fail(match: RegExp, error: () => Error = () => new Error('injected')) { failures.push({ match, error }); },
    texts: () => stmts.map((s) => s.text),
  };
}
export type DlDb = ReturnType<typeof makeDeadLetterDb>;

/** Platform-context RequestContext (no tenant): C2's console handlers call ctx.core.deadLetters after assertPlatform. */
export const platformCtx = (db: { tx: unknown }, over: Record<string, unknown> = {}) => ({
  tenantId: undefined, actor: { type: 'user', id: PLATFORM_USER }, requestId: REQ_ID, tx: db.tx, now: () => '2026-11-07T12:00:00.000Z', ports: {}, ...over,
});

export function recorder() {
  const logs: Array<{ level: string; obj: any; msg?: string }> = [];
  const mk = (level: string) => (obj: any, msg?: string) => { logs.push({ level, obj, msg }); };
  const incs: Array<{ name: string; labels?: Record<string, string | number>; by: number }> = [];
  return {
    logs, incs,
    log: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') },
    metrics: { inc: (name: string, labels?: Record<string, string | number>, by = 1) => { incs.push({ name, labels, by }); }, set: () => undefined, observe: () => undefined },
  };
}

export async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected rejection, but it resolved');
}

/** The exact DeadLetterRow key set (02-TRD §6.8): any other key (job_payload, jobKey, module...) is a leak. */
export const DEAD_LETTER_ROW_KEYS = [
  'attempts', 'deadAt', 'firstFailedAt', 'id', 'lastErrorCode', 'lastErrorMessageRedacted', 'resolutionNote', 'resolvedAt',
  'resolvedBy', 'state', 'taskIdentifier', 'tenantId', 'version',
];
