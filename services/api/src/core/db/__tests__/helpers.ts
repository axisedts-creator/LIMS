// Shared helpers for the T0D-03 tests: an in-memory fake of PgBouncer (transaction pooling) in front of Postgres.
// It models only what the AC cares about: transaction-local vs session-level settings on a SHARED server connection.
//  - set_config(k, v, true)  -> cleared at COMMIT / ROLLBACK;   set_config(k, v, false) -> persists on the server connection (a leak)
//  - SELECT app.current_tenant_id() -> tenant_id from the claims setting, NULL when unset
//  - an injected error aborts the transaction (25P02 for every statement except ROLLBACK*), like Postgres
// The real-PgBouncer proof is SP-9 / AC-0B-3.7 (needs a database); this fake proves the code paths issue the right SQL.

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const SUB = '0190a000-0000-7000-8000-00000000a001';
export const IDENTITY_SYSTEM_ACTOR = '0190a000-0000-7000-8000-00000000a5a5';
export const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
export const NOW = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));

export const CLAIMS_KEY = 'request.jwt.claims';

export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly server: number }
export interface PgError extends Error { code?: string; constraint?: string; detail?: string; table?: string }
export const pgError = (code: string, message = `pg error ${code}`, extra: Partial<PgError> = {}): PgError =>
  Object.assign(new Error(message), { code }, extra);

interface Injection { match: RegExp; make: () => Error; times: number }
interface Server {
  readonly id: number;
  busy: boolean;
  inTx: boolean;
  aborted: boolean;
  local: Map<string, string>;
  session: Map<string, string>;
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createFakePgBouncer(servers = 1) {
  const log: Stmt[] = [];
  const injections: Injection[] = [];
  const pool_: Server[] = Array.from({ length: servers }, (_, i) => ({
    id: i, busy: false, inTx: false, aborted: false, local: new Map(), session: new Map(),
  }));
  const waiters: Array<(s: Server) => void> = [];
  const state = { connects: 0, releases: 0, releasedInTx: 0, failConnect: undefined as Error | undefined };

  const setting = (s: Server, k: string): string | undefined => s.local.get(k) ?? s.session.get(k);
  const claimsOf = (s: Server): Record<string, unknown> | undefined => {
    const raw = setting(s, CLAIMS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  };

  function exec(s: Server, text: string, values: readonly unknown[]): { rows: any[] } {
    log.push({ text, values, server: s.id });
    const t = text.trim();
    const inj = injections.find((i) => i.times > 0 && i.match.test(t));
    if (/^(ROLLBACK|ABORT)\b/i.test(t) && !/^ROLLBACK\s+TO\b/i.test(t)) {
      s.inTx = false; s.aborted = false; s.local.clear();
      return { rows: [] };
    }
    if (/^ROLLBACK\s+TO\b/i.test(t)) { s.aborted = false; return { rows: [] }; }
    if (s.aborted) throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    if (inj) {
      inj.times -= 1;
      if (s.inTx) s.aborted = true;
      throw inj.make();
    }
    if (/^BEGIN\b/i.test(t)) { s.inTx = true; return { rows: [] }; }
    if (/^COMMIT\b/i.test(t)) { s.inTx = false; s.local.clear(); return { rows: [] }; }
    if (/^(SAVEPOINT|RELEASE)\b/i.test(t)) return { rows: [] };
    if (/^(SET|RESET)\b/i.test(t)) return { rows: [] };

    const row: Record<string, unknown> = {};
    const re = /set_config\(\s*'([^']+)'\s*,\s*\$(\d+)(?:::text)?\s*,\s*(true|false)\s*\)/gi;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(t))) {
      any = true;
      const [, key, idx, isLocal] = m;
      const v = String(values[Number(idx) - 1]);
      if (isLocal.toLowerCase() === 'true') {
        if (!s.inTx) { /* real PG: set_config(.., true) outside a tx is a no-op at statement end */ } else s.local.set(key, v);
      } else s.session.set(key, v);
      row[`set_config_${key}`] = v;
    }
    if (any) {
      if (/tx_started_at/i.test(t)) row.tx_started_at = NOW;
      return { rows: [row] };
    }
    if (/app\.current_tenant_id\(\)/i.test(t)) return { rows: [{ tenant_id: (claimsOf(s)?.tenant_id as string | undefined) ?? null }] };
    if (/current_setting\(\s*'([^']+)'/i.test(t)) {
      const key = /current_setting\(\s*'([^']+)'/i.exec(t)![1];
      return { rows: [{ value: setting(s, key) ?? null }] };
    }
    return { rows: [{ ok: true }] };
  }

  function acquire(): Promise<Server> {
    const free = pool_.find((s) => !s.busy);
    if (free) { free.busy = true; return Promise.resolve(free); }
    return new Promise((res) => waiters.push(res));
  }

  const pool = {
    async connect() {
      if (state.failConnect) throw state.failConnect;
      state.connects += 1;
      const s = await acquire();
      let released = false;
      return {
        async query(textOrCfg: string | { text: string; values?: unknown[] }, vals?: unknown[]) {
          if (released) throw new Error('query on a released client');
          const text = typeof textOrCfg === 'string' ? textOrCfg : textOrCfg.text;
          const values = typeof textOrCfg === 'string' ? (vals ?? []) : (textOrCfg.values ?? []);
          await delay(0); // every statement is a real async hop, so concurrent requests interleave
          return exec(s, text, values);
        },
        release() {
          if (released) throw new Error('client released twice');
          released = true;
          state.releases += 1;
          if (s.inTx) { state.releasedInTx += 1; s.inTx = false; s.aborted = false; s.local.clear(); }
          const next = waiters.shift();
          if (next) next(s); else s.busy = false;
        },
      };
    },
    /** pool.query(): a statement outside any transaction (autocommit) on whichever server connection is free. */
    async query(text: string, values: unknown[] = []) {
      const c = await pool.connect();
      try { return await c.query(text, values); } finally { c.release(); }
    },
  };

  return {
    pool,
    log,
    state,
    servers: pool_,
    texts: () => log.map((l) => l.text.trim()),
    /** Next `times` statements matching `match` throw the error made by `make`. */
    inject(match: RegExp, make: () => Error, times = 1) { injections.push({ match, make, times }); },
    /** The one statement that sets request.jwt.claims at tx open, parsed. */
    openingClaims(): Record<string, unknown> {
      const st = log.find((l) => /set_config\(\s*'request\.jwt\.claims'/i.test(l.text));
      if (!st) throw new Error('no set_config(request.jwt.claims) statement was issued');
      return JSON.parse(String(st.values[0])) as Record<string, unknown>;
    },
    /** Tenant seen by an untransacted statement on a free server connection. */
    async tenantOutsideTx(): Promise<string | null> {
      return (await pool.query('SELECT app.current_tenant_id() AS tenant_id')).rows[0].tenant_id;
    },
  };
}

export type Fake = ReturnType<typeof createFakePgBouncer>;

export const operation = (over: Record<string, unknown> = {}) => ({
  module: 'catalog', operationId: 'listTests', context: 'tenant', ...over,
});

/** Input of db.requestTx(): claims are built server-side by the caller (core/auth), never here. */
export const txInput = (over: Record<string, unknown> = {}) => ({
  claims: { sub: SUB, tenant_id: TENANT_A, actor_type: 'user' },
  requestId: REQ_ID,
  clientIp: '203.0.113.9',
  userAgent: 'vitest',
  operation: operation(),
  ...over,
});

/** Fixed-seed-free deterministic knobs for retry tests. */
export function retryKnobs(randoms: number[] = [0]) {
  const sleeps: number[] = [];
  let i = 0;
  return {
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); },
    random: () => randoms[Math.min(i++, randoms.length - 1)],
  };
}

export function recorder() {
  const calls: Array<{ level: string; obj: any; msg?: string }> = [];
  const mk = (level: string) => (obj: any, msg?: string) => { calls.push({ level, obj, msg }); };
  return {
    calls,
    log: { info: mk('info'), warn: mk('warn'), error: mk('error') },
    metrics: { counts: new Map<string, number>(), inc(name: string) { this.counts.set(name, (this.counts.get(name) ?? 0) + 1); } },
  };
}

/** Awaits a promise expected to reject; returns the rejection (fails if it resolved). */
export async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected rejection, but it resolved');
}
