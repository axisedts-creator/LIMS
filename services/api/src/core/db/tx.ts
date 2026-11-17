// Request transactions (02-TRD §6.4): one BEGIN, one transaction-local context statement, the handler, COMMIT.
// Everything is transaction-local, so nothing survives COMMIT/ROLLBACK on a PgBouncer-shared server connection (AC-0D-2.3).
// The pool is module-private (CV §5.10): modules only ever see the `tx` facade below.
import { AuthError } from '../auth/errors.js';
import type { DbClaims } from '../auth/claims.js';
import { IDENTITY_AUTH_OPS, WITH_TENANT_SCOPE_OPS } from './allowlists.js';
import { mapDbError, type DbErrorDeps } from './sqlstate.js';
import { currentRequestStats } from '../observability/request-stats.js';

export interface PoolClient { query(text: string, values?: unknown[]): Promise<{ rows: any[] }>; release(err?: unknown): void }
export interface Pool { connect(): Promise<PoolClient> }

export interface TxOperation { readonly module: string; readonly operationId: string; readonly context?: string | undefined }
export interface TxInput {
  readonly requestId: string; readonly clientIp: string; readonly userAgent?: string | undefined;
  readonly operation: TxOperation; readonly statementTimeoutMs?: number; readonly lockTimeoutMs?: number;
  /** T0B-PERF-1 (LD-310): GET/HEAD = true (read statement timeout), other methods false (write timeout). Unset = legacy (write if configured, else read). */
  readonly readOnly?: boolean;
}
export interface RequestTxInput extends TxInput { readonly claims: DbClaims }

export interface Tx {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  readonly startedAt: Date;
  readonly operation: TxOperation;
  savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** identityAuthTx only (D-212): once per transaction attempt. */
  readonly bindTenant?: (tenantId: string) => Promise<void>;
}
export interface TxControl { noRetry(): void }
export type TxFn<T> = (tx: Tx, ctl: TxControl) => Promise<T>;

export interface DbOptions extends DbErrorDeps {
  readonly pool: Pool;
  readonly retryMax?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly statementTimeoutMs?: number;
  /** T0B-PERF-1 (LD-310): statement timeout of write transactions (config 15000). */
  readonly writeStatementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly identitySystemActorId?: string;
  /** PLATFORM-WIRE-1 (LD-267): lazy identity system actor for withTenantScope ONLY (read after every other check passed); never used by identityAuthTx. */
  readonly scopeActorId?: () => Promise<string>;
  readonly identityAuthOps?: Iterable<string>;
  readonly withTenantScopeOps?: Iterable<string>;
}

const OPEN_SQL = `SELECT set_config('request.jwt.claims', $1::text, true),
       set_config('app.request_id',     $2::text, true),
       set_config('app.client_ip',      $3::text, true),
       set_config('app.user_agent',     $4::text, true),
       set_config('statement_timeout',  $5::text, true),
       set_config('lock_timeout',       $6::text, true),
       now() AS tx_started_at`;
const CLAIMS_SQL = `SELECT set_config('request.jwt.claims', $1::text, true)`;
const RETRYABLE = new Set(['40001', '40P01']);
const ENQUEUE = /app\.enqueue_job\s*\(/i;
const enqueued = new WeakMap<object, string>(); // error of a failed app.enqueue_job call -> its task identifier (values[0])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TxState { readonly kind: 'request' | 'identity_auth'; readonly operation: TxOperation; readonly claimsJson: string; open: boolean; scoped: boolean }

const internal = (): Error => new AuthError('common.internal');
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createDb(o: DbOptions) {
  const retryMax = o.retryMax ?? 3;
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  const authOps: ReadonlySet<string> = new Set(o.identityAuthOps ?? IDENTITY_AUTH_OPS);
  const scopeOps: ReadonlySet<string> = new Set(o.withTenantScopeOps ?? WITH_TENANT_SCOPE_OPS);
  const deps: DbErrorDeps = { log: o.log, metrics: o.metrics };
  const timeoutFor = (readOnly?: boolean): number => (readOnly === true
    ? o.statementTimeoutMs ?? 5000
    : readOnly === false ? o.writeStatementTimeoutMs ?? 15000 : o.writeStatementTimeoutMs ?? o.statementTimeoutMs ?? 5000);
  const states = new WeakMap<object, TxState>(); // only tx objects made here are accepted by withTenantScope

  async function attempt<T>(kind: TxState['kind'], input: TxInput, claimsJson: string, fn: TxFn<T>, ctl: TxControl): Promise<T> {
    const client = await o.pool.connect();
    const state: TxState = { kind, operation: Object.freeze({ ...input.operation }), claimsJson, open: true, scoped: false };
    let broken: unknown;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(OPEN_SQL, [
        claimsJson, String(input.requestId), String(input.clientIp ?? ''), String(input.userAgent ?? '').slice(0, 512),
        String(input.statementTimeoutMs ?? timeoutFor(input.readOnly)), String(input.lockTimeoutMs ?? o.lockTimeoutMs ?? 3000),
      ]);
      let n = 0;
      let bound = false;
      const query = (text: string, values: unknown[] = []) => {
        if (!state.open) return Promise.reject(internal()); // a tx kept past its request must not reach a reused connection
        if (!ENQUEUE.test(text)) return client.query(text, values);
        return client.query(text, values).catch((e: unknown) => {
          if (e !== null && typeof e === 'object' && typeof values[0] === 'string') enqueued.set(e, values[0]);
          throw e;
        });
      };
      // T0B-PERF-1 (LD-310): every statement the caller issues counts once (ok or failed) in the request's stats; plumbing
      // (BEGIN/COMMIT, savepoints, the claims set_config) goes through `query` directly and is not counted.
      const counted = (text: string, values?: unknown[]) => {
        const stats = currentRequestStats();
        if (!stats || text === CLAIMS_SQL) return query(text, values);
        const t0 = performance.now();
        const done = () => { stats.recordQuery(performance.now() - t0); };
        return query(text, values).then((r) => { done(); return r; }, (e: unknown) => { done(); throw e; });
      };
      const tx: Tx = {
        query: counted,
        startedAt: new Date(rows[0].tx_started_at),
        operation: state.operation,
        async savepoint<R>(inner: (t: Tx) => Promise<R>): Promise<R> {
          const name = `s${++n}`;
          await query(`SAVEPOINT ${name}`);
          let out: R;
          try { out = await inner(tx); } catch (e) { await query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
          await query(`RELEASE SAVEPOINT ${name}`);
          return out;
        },
        ...(kind === 'identity_auth' && {
          async bindTenant(tenantId: string) {
            if (bound || typeof tenantId !== 'string' || !UUID.test(tenantId)) throw internal();
            bound = true;
            await query(CLAIMS_SQL, [JSON.stringify({ ...JSON.parse(claimsJson), tenant_id: tenantId })]);
          },
        }),
      };
      Object.freeze(tx);
      states.set(tx, state);
      const out = await fn(tx, ctl);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rb) { broken = rb; } // connection unusable: pool destroys it
      throw e;
    } finally {
      state.open = false;
      client.release(broken);
    }
  }

  async function run<T>(kind: TxState['kind'], input: TxInput, claimsJson: string, fn: TxFn<T>): Promise<T> {
    let noRetry = false; // request-level, shared by every attempt of this call only
    const ctl: TxControl = Object.freeze({ noRetry: () => { noRetry = true; } });
    for (let i = 0; ; i++) {
      try {
        return await attempt(kind, input, claimsJson, fn, ctl);
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && RETRYABLE.has(code) && !noRetry && i < retryMax) {
          await sleep(Math.round(10 + random() * 40)); // jitter 10-50 ms [CONV]
          continue;
        }
        const mapped = mapDbError(e, deps);
        // LD-224 (RS-12): one error line with the pg coordinates only; never message/detail/hint/where/params/values.
        if (mapped !== e) {
          const pg = e as Record<string, unknown>;
          const s = (k: string) => (typeof pg[k] === 'string' ? pg[k] : null);
          o.log?.error?.({
            request_id: input.requestId, sqlstate: code, schema: s('schema'), table: s('table'), column: s('column'),
            constraint: s('constraint'), routine: s('routine'), operationId: input.operation.operationId,
          }, 'db_error');
          // T0B-ASYNC-1 (RS-10): a refused enqueue names the task and the operation, never the payload, job key or DB message
          const id = (mapped as { code?: unknown }).code === 'common.service_unavailable' ? enqueued.get(e as object) : undefined;
          if (id !== undefined) {
            o.log?.error?.({ request_id: input.requestId, task_identifier: id.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 128), operationId: input.operation.operationId },
              'enqueue_unknown_task_identifier');
          }
        }
        throw mapped;
      }
    }
  }

  return {
    requestTx<T>(input: RequestTxInput, fn: TxFn<T>): Promise<T> {
      if (!input?.claims || !input.operation) return Promise.reject(internal());
      return run('request', input, JSON.stringify(input.claims), fn);
    },

    /** 08 A25 D-212: refused before any SQL unless identity + x-context identity_auth + allowlisted operationId. */
    identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> {
      const op = input?.operation;
      if (!op || op.module !== 'identity' || op.context !== 'identity_auth' || typeof op.operationId !== 'string'
        || !authOps.has(op.operationId) || !o.identitySystemActorId) return Promise.reject(internal());
      // claims are fixed here; anything the caller passes is ignored
      return run('identity_auth', input, JSON.stringify({ sub: o.identitySystemActorId, actor_type: 'system' }), fn);
    },

    /** 02-TRD §6.3 / D-214: identity, platform context, allowlisted operationId; previous claims restored afterwards. */
    async withTenantScope<T>(tx: Tx, tenantId: string, fn: () => Promise<T>): Promise<T> {
      const s = states.get(tx);
      const op = s?.operation;
      if (!s || !s.open || s.scoped || s.kind !== 'request' || !op || op.module !== 'identity' || op.context !== 'platform'
        || typeof op.operationId !== 'string' || !scopeOps.has(op.operationId)
        || typeof tenantId !== 'string' || !UUID.test(tenantId) || !(o.identitySystemActorId || o.scopeActorId)) throw internal();
      let actorId = o.identitySystemActorId;
      if (!actorId) {
        try { actorId = await o.scopeActorId!(); } catch { throw internal(); } // any lookup failure = common.internal, no driver text
        if (typeof actorId !== 'string' || !UUID.test(actorId)) throw internal();
        if (s.scoped || !s.open) throw internal(); // the lookup awaited: re-check (concurrent call on this tx, or the request ended)
      }
      await tx.query(CLAIMS_SQL, [JSON.stringify({ sub: actorId, actor_type: 'system', tenant_id: tenantId })]);
      s.scoped = true;
      let out: T;
      try {
        out = await fn();
      } catch (e) {
        s.scoped = false;
        await tx.query(CLAIMS_SQL, [s.claimsJson]).catch(() => undefined); // tx may be aborted; it then rolls back anyway
        throw e;
      }
      s.scoped = false;
      await tx.query(CLAIMS_SQL, [s.claimsJson]);
      return out;
    },
  };
}

export type Db = ReturnType<typeof createDb>;
