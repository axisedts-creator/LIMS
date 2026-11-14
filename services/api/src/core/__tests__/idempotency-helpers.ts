// Shared helpers for the T0D-05 idempotency tests (02-TRD §6.6, 03-APP-FLOW §3.1 K1–K5, 05-SCHEMA core.idempotency_keys).
// An in-memory emulator of `core.idempotency_keys` (and a tiny `catalog.marker` domain table) on top of the T0D-03 fake PgBouncer.
// It models what the ACs care about and nothing more:
//  - transactions: writes are staged until COMMIT, dropped on ROLLBACK / failed COMMIT (so "same transaction" and "released after rollback" are real);
//  - row locks: UPDATE/DELETE/INSERT on a row wait for another open transaction that touched it (takeover race, concurrent claim);
//  - UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key); ON CONFLICT target must be exactly (tenant_id, actor_id, key);
//  - RLS: a row is visible/writable only when tenant_id = claims.tenant_id (NULL only for scope:'platform' claims) and actor_id = claims.sub;
//    DELETE additionally only on state = 'in_progress' (05-SCHEMA §6 policies);
//  - SQL NULL semantics in WHERE: `tenant_id = x` and the row-value `(tenant_id, actor_id, key) = (…)` NEVER match a NULL tenant
//    (05-SCHEMA ~1164 warns about exactly this); `IS NOT DISTINCT FROM` / `IS NULL` do;
//  - CHECKs: key ~ ^[A-Za-z0-9_-]{1,64}$, octet_length(request_sha256) = 32 (needs bytes, not a hex string), completed__ck.
// Statements are matched by shape (columns by name, `$n` binds resolved), so the implementation is free in parameter order.
import { createHash } from 'node:crypto';
import { createDb } from '../db/tx.js';
import { NOW, REQ_ID, SUB, TENANT_A, createFakePgBouncer, delay, pgError, txInput } from '../db/__tests__/helpers.js';

export { NOW, REQ_ID, SUB, TENANT_A, delay, pgError };
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const USER_A = SUB;
export const USER_B = '0190a000-0000-7000-8000-00000000a002';
export const PATIENT_A = '0190a000-0000-7000-8000-00000000a0c1';
export const PLATFORM_1 = '0190a000-0000-7000-8000-00000000f001';
export const PLATFORM_2 = '0190a000-0000-7000-8000-00000000f002';
export const SECOND = 1000;
export const DAY = 86_400_000;

export interface Row {
  tenant_id: string | null; actor_id: string; key: string; method: string; route: string; request_sha256: Buffer;
  state: 'in_progress' | 'completed'; response_status: number | null; response_body: unknown; created_at: Date; expires_at: Date;
}
export interface Ev { tx: number | null; kind: 'begin' | 'commit' | 'rollback' | 'stmt' | 'idem' | 'marker'; text: string; values: unknown[] }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const idOf = (t: string | null, a: string, k: string) => `${t ?? '∅'}|${a}|${k}`;
const clone = (r: Row): Row => ({ ...r, request_sha256: Buffer.from(r.request_sha256), created_at: new Date(r.created_at), expires_at: new Date(r.expires_at),
  response_body: r.response_body === null || r.response_body === undefined ? null : JSON.parse(JSON.stringify(r.response_body)) });

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let q = false; let cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface TxS { id: number; changes: Map<string, Row | null>; held: Set<string>; markers: unknown[] }
interface Lock { tx: number; done: Promise<void>; free(): void }

export function createIdemEnv(opts: { servers?: number } = {}) {
  const clock = { t: NOW.getTime() };
  const now = () => new Date(clock.t);
  const fake = createFakePgBouncer(opts.servers ?? 8);
  const committed = new Map<string, Row>();
  const markers: unknown[] = [];
  const locks = new Map<string, Lock>();
  const events: Ev[] = [];
  const failures: Array<{ match: RegExp; make: () => Error; times: number }> = [];
  let seq = 0;

  const view = (tx: TxS | null, id: string): Row | undefined => {
    if (tx?.changes.has(id)) return tx.changes.get(id) ?? undefined;
    return committed.get(id);
  };
  async function waitFree(tx: TxS | null, id: string): Promise<void> {
    for (;;) { const l = locks.get(id); if (!l || l.tx === tx?.id) return; await l.done; }
  }
  function lockRow(tx: TxS | null, id: string): void {
    if (!tx || locks.get(id)?.tx === tx.id) return;
    let free!: () => void;
    const done = new Promise<void>((r) => { free = r; });
    locks.set(id, { tx: tx.id, done, free });
    tx.held.add(id);
  }
  function endTx(tx: TxS, commit: boolean): void {
    if (commit) {
      for (const [id, r] of tx.changes) { if (r) committed.set(id, r); else committed.delete(id); }
      markers.push(...tx.markers);
    }
    for (const id of tx.held) { const l = locks.get(id); if (l?.tx === tx.id) { locks.delete(id); l.free(); } }
  }

  const rlsOk = (c: Record<string, any> | null, r: Row): boolean =>
    !!c && r.actor_id === c.sub && r.tenant_id === (c.tenant_id ?? null) && (r.tenant_id !== null || c.scope === 'platform');

  const evalExpr = (tok: string, values: unknown[]): unknown => {
    let m: RegExpExecArray | null;
    if ((m = /^\$(\d+)(?:::\w+)?$/.exec(tok))) return values[Number(m[1]) - 1];
    if ((m = /^'([^']*)'(?:::\w+)?$/.exec(tok))) return m[1];
    if (/^now\(\)$/i.test(tok)) return now();
    if ((m = /^now\(\)\s*\+\s*interval\s*'(\d+)\s*(day|days|hour|hours)'$/i.exec(tok))) return new Date(clock.t + Number(m[1]) * (/^day/i.test(m[2]) ? DAY : 3_600_000));
    if (/^null$/i.test(tok)) return null;
    throw new Error(`fake idempotency table: unsupported expression ${tok}`);
  };

  function matchRows(sql: string, where: string, values: unknown[], claims: Record<string, any> | null, tx: TxS | null): Array<{ id: string; row: Row }> {
    const nullBlocks = /\(\s*tenant_id\s*,\s*actor_id\s*,\s*key\s*\)\s*=\s*\(/i.test(where) || /\btenant_id\s*=\s*/i.test(where);
    const out: Array<{ id: string; row: Row }> = [];
    const ids = new Set([...committed.keys(), ...(tx ? [...tx.changes.keys()] : [])]);
    for (const id of ids) {
      const row = view(tx, id);
      if (!row || !rlsOk(claims, row)) continue;
      if (!values.some((v) => v === row.key)) continue;
      if (row.tenant_id === null && nullBlocks) continue;
      if (/state\s*=\s*'in_progress'/i.test(where) && row.state !== 'in_progress') continue;
      let m: RegExpExecArray | null;
      if ((m = /created_at\s*<=\s*now\(\)\s*-\s*interval\s*'(\d+)\s*seconds?'/i.exec(where)) && clock.t - row.created_at.getTime() < Number(m[1]) * SECOND) continue;
      if ((m = /created_at\s*<=\s*\$(\d+)/i.exec(where)) && row.created_at.getTime() > new Date(values[Number(m[1]) - 1] as any).getTime()) continue;
      if ((m = /created_at\s*>\s*now\(\)\s*-\s*interval\s*'(\d+)\s*seconds?'/i.exec(where)) && clock.t - row.created_at.getTime() >= Number(m[1]) * SECOND) continue;
      out.push({ id, row });
    }
    return out;
  }

  async function execIdem(t: string, values: unknown[], claims: Record<string, any> | null, tx: TxS | null): Promise<{ rows: any[] }> {
    if (!tx) throw new Error('fake idempotency table: statement outside a transaction');
    const fail = failures.find((f) => f.times > 0 && f.match.test(t));
    if (fail) { fail.times -= 1; throw fail.make(); }
    let m: RegExpExecArray | null;
    if (/^INSERT INTO core\.idempotency_keys/i.test(t)) {
      m = /^INSERT INTO core\.idempotency_keys\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*ON CONFLICT\s*(.*)$/i.exec(t);
      if (!m) throw new Error(`fake idempotency table: unsupported INSERT ${t}`);
      const cols = m[1].split(',').map((c) => c.trim());
      const toks = splitTop(m[2]);
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => { o[c] = evalExpr(toks[i], values); });
      if (!/^\(\s*tenant_id\s*,\s*actor_id\s*,\s*key\s*\)\s*DO NOTHING/i.test(m[3])) throw pgError('42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
      const row: Row = { tenant_id: (o.tenant_id as string | null) ?? null, actor_id: o.actor_id as string, key: o.key as string, method: o.method as string,
        route: o.route as string, request_sha256: o.request_sha256 as Buffer, state: o.state as any, response_status: null, response_body: null,
        created_at: (o.created_at as Date) ?? now(), expires_at: o.expires_at as Date };
      if (!rlsOk(claims, row)) throw pgError('42501', 'new row violates row-level security policy for table "idempotency_keys"');
      if (typeof row.key !== 'string' || !KEY_RE.test(row.key)) throw pgError('23514', 'violates check constraint "idempotency_keys__key__ck"');
      if (!(row.request_sha256 instanceof Uint8Array) || row.request_sha256.byteLength !== 32) throw pgError('23514', 'violates check constraint "idempotency_keys__sha__ck"');
      if (!['in_progress', 'completed'].includes(row.state) || !(row.expires_at instanceof Date)) throw pgError('23514', 'violates check constraint');
      const id = idOf(row.tenant_id, row.actor_id, row.key);
      await waitFree(tx, id);
      if (view(tx, id)) return { rows: [] };
      lockRow(tx, id);
      tx.changes.set(id, row);
      return { rows: /RETURNING/i.test(t) ? [{ key: row.key }] : [] };
    }
    if (/^SELECT\b/i.test(t)) {
      const where = /\bWHERE\b(.*)$/i.exec(t)?.[1] ?? '';
      const found = matchRows(t, where, values, claims, tx);
      if (/FOR UPDATE/i.test(t) && found[0]) { await waitFree(tx, found[0].id); lockRow(tx, found[0].id); }
      return { rows: matchRows(t, where, values, claims, tx).map((f) => clone(f.row)) };
    }
    if ((m = /^UPDATE core\.idempotency_keys\s+SET (.*?)\s+WHERE (.*?)(?:\s+RETURNING .*)?$/i.exec(t))) {
      const [, set, where] = m;
      const found = matchRows(t, where, values, claims, tx)[0];
      if (!found) return { rows: [] };
      await waitFree(tx, found.id); // row lock: wait for the other transaction, then re-evaluate (READ COMMITTED)
      const again = matchRows(t, where, values, claims, tx)[0];
      if (!again) return { rows: [] };
      lockRow(tx, again.id);
      const next = clone(again.row) as any;
      for (const a of splitTop(set)) {
        const am = /^(\w+)\s*=\s*(.*)$/s.exec(a);
        if (!am) throw new Error(`fake idempotency table: unsupported SET ${a}`);
        let v = evalExpr(am[2].trim(), values);
        if (am[1] === 'response_body' && typeof v === 'string') v = JSON.parse(v);
        next[am[1]] = v;
      }
      if ((next.state === 'completed') !== (next.response_status !== null && next.response_status !== undefined)) throw pgError('23514', 'violates check constraint "idempotency_keys__completed__ck"');
      if (next.response_status === undefined) next.response_status = null;
      tx.changes.set(again.id, next);
      return { rows: /RETURNING/i.test(t) ? [{ key: next.key }] : [] };
    }
    if ((m = /^DELETE FROM core\.idempotency_keys\s+WHERE (.*?)(?:\s+RETURNING .*)?$/i.exec(t))) {
      const found = matchRows(t, m[1], values, claims, tx).filter((f) => f.row.state === 'in_progress')[0]; // delete policy: in_progress only
      if (!found) return { rows: [] };
      await waitFree(tx, found.id);
      const again = matchRows(t, m[1], values, claims, tx).filter((f) => f.row.state === 'in_progress')[0];
      if (!again) return { rows: [] };
      lockRow(tx, again.id);
      tx.changes.set(again.id, null);
      return { rows: /RETURNING/i.test(t) ? [{ key: again.row.key }] : [] };
    }
    throw new Error(`fake idempotency table: unsupported statement ${t}`);
  }

  const pool = {
    async connect() {
      const c = await fake.pool.connect();
      let tx: TxS | null = null;
      let claims: Record<string, any> | null = null;
      const ev = (kind: Ev['kind'], text: string, values: unknown[] = []) => events.push({ tx: tx?.id ?? null, kind, text, values });
      return {
        async query(text: string, values: unknown[] = []) {
          const t = norm(text);
          if (/^BEGIN\b/i.test(t)) { const r = await c.query(text, values); tx = { id: ++seq, changes: new Map(), held: new Set(), markers: [] }; ev('begin', t); return r; }
          if (/^COMMIT\b/i.test(t)) {
            try { const r = await c.query(text, values); if (tx) endTx(tx, true); ev('commit', t); tx = null; return r; }
            catch (e) { if (tx) endTx(tx, false); ev('rollback', 'COMMIT FAILED'); tx = null; throw e; }
          }
          if (/^(ROLLBACK|ABORT)\b/i.test(t) && !/^ROLLBACK\s+TO\b/i.test(t)) { const r = await c.query(text, values); if (tx) endTx(tx, false); ev('rollback', t); tx = null; return r; }
          if (/set_config\(\s*'request\.jwt\.claims'/i.test(t) && typeof values[0] === 'string') claims = JSON.parse(values[0]);
          if (/core\.idempotency_keys/i.test(t)) {
            await delay(0);
            const r = await execIdem(t, values, claims, tx);
            ev('idem', t, values);
            return r;
          }
          if (/^INSERT INTO catalog\.marker/i.test(t)) { await delay(0); tx?.markers.push(values[0]); ev('marker', t, values); return { rows: [] }; }
          const r = await c.query(text, values);
          if (/tx_started_at/i.test(t) && r.rows[0]) r.rows[0].tx_started_at = now();
          ev('stmt', t, values);
          return r;
        },
        release(err?: unknown) { if (tx) { endTx(tx, false); tx = null; } (c as any).release(err); },
      };
    },
  };

  const db = createDb({ pool, sleep: async () => {}, random: () => 0 } as any) as any;
  return {
    clock, fake, db, events, markers,
    /** Wall clock handed to createIdempotency({ now }). */
    now: () => clock.t,
    advance(ms: number) { clock.t += ms; },
    rows: (): Row[] => [...committed.values()].map(clone),
    row(key: string, tenant: string | null, actor: string): Row | undefined { const r = committed.get(idOf(tenant, actor, key)); return r && clone(r); },
    /** What app.purge_idempotency_keys() does (K5). */
    purgeExpired() { for (const [id, r] of [...committed]) if (r.expires_at.getTime() < clock.t) committed.delete(id); },
    /** The next `times` statements on core.idempotency_keys matching `match` throw. */
    failIdem(match: RegExp, make: () => Error = () => pgError('57P01', 'terminating connection due to administrator command'), times = 1) { failures.push({ match, make, times }); },
    idemStatements: () => events.filter((e) => e.kind === 'idem'),
  };
}
export type Env = ReturnType<typeof createIdemEnv>;

// ---- request factory + pipeline emulation (stages 6, 7, 8, 10, 11 of 02-TRD §6.2) ----
export const tenantClaims = (over: Record<string, unknown> = {}) => ({ sub: USER_A, tenant_id: TENANT_A, actor_type: 'user', ...over });
export const platformClaims = (sub = PLATFORM_1) => ({ sub, actor_type: 'user', scope: 'platform', platform_staff_id: sub, platform_role: 'platform_admin' });

export const makeReq = (over: Record<string, unknown> = {}): any => ({
  operation: { module: 'catalog', operationId: 'createTest', context: 'tenant', idempotency: 'required' },
  method: 'POST', routeTemplate: '/v1/catalog/tests', pathParams: {}, query: {},
  body: { code: 'CBC', name: 'Complete blood count' },
  idempotencyKey: 'key-0001',
  claims: tenantClaims(), requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest',
  ...over,
});
export const platformReq = (over: Record<string, unknown> = {}): any =>
  makeReq({ operation: { module: 'identity', operationId: 'provisionTenant', context: 'platform', idempotency: 'required' },
    routeTemplate: '/v1/identity/tenants', body: { code: 'ACME', name: 'Acme Labs' }, claims: platformClaims(), ...over });

export interface HandlerResult { status: number; body?: unknown }
export type Handler = (tx: any, h: { commitOnError(): void }) => Promise<HandlerResult>;
export interface Served { status: number; body: unknown; headers: Record<string, string>; error?: any; replayed: boolean; ran: boolean }

export const header = (s: { headers: Record<string, string> }, name: string): string | undefined =>
  Object.entries(s.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

class Rolled extends Error { constructor(readonly r: HandlerResult) { super('rolled back'); } }

/** Pipeline stages 6–11 around the idempotency hook: begin → requestTx(handler, finish) → rollback unless status < 400 or commitOnError → release after rollback. */
export async function serve(env: Env, idem: any, req: any, handler: Handler): Promise<Served> {
  let d: any;
  try { d = await idem.begin(req); }
  catch (e: any) {
    return { status: e?.statusCode ?? 500, body: { code: e?.code }, headers: e?.retryAfterSeconds ? { 'Retry-After': String(e.retryAfterSeconds) } : {}, error: e, replayed: false, ran: false };
  }
  if (d.action === 'replay') return { status: d.status, body: d.body, headers: d.headers ?? {}, replayed: true, ran: false };
  const input = txInput({ claims: req.claims, requestId: req.requestId, operation: { module: req.operation.module, operationId: req.operation.operationId, context: req.operation.context } });
  let cob = false;
  let ran = false;
  const wrapped = async (tx: any): Promise<HandlerResult> => {
    ran = true;
    const r = await handler(tx, { commitOnError() { cob = true; } });
    if (d.action === 'proceed') await idem.finish(tx, d.handle, { status: r.status, body: r.body, commitOnError: cob });
    if (r.status >= 400 && !cob) throw new Rolled(r); // stage 11: roll back on >= 400 unless commitOnError
    return r;
  };
  try {
    const r = await env.db.requestTx(input, wrapped);
    return { status: r.status, body: r.body, headers: {}, replayed: false, ran };
  } catch (e: any) {
    if (d.action === 'proceed') await idem.release(d.handle); // after the rollback, separate transaction
    if (e instanceof Rolled) return { status: e.r.status, body: e.r.body, headers: {}, replayed: false, ran: true };
    return { status: 500, body: { code: 'common.internal' }, headers: {}, error: e, replayed: false, ran };
  }
}

export interface Deferred<T = void> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** A handler that counts its runs and writes one domain marker in the request transaction. */
export function counting(result: HandlerResult | ((n: number) => HandlerResult) = { status: 201, body: { id: 'test-1', code: 'CBC' } }) {
  const st = { runs: 0 };
  const handler: Handler = async (tx) => {
    const n = ++st.runs;
    await tx.query('INSERT INTO catalog.marker (v) VALUES ($1)', [`run-${n}`]);
    return typeof result === 'function' ? result(n) : result;
  };
  return Object.assign(handler, { st });
}

// canonical request hash, computed independently of the implementation (02-TRD §6.6 step 1)
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
export const expectedSha = (r: { method: string; routeTemplate: string; pathParams?: unknown; query?: unknown; body?: unknown }): Buffer =>
  createHash('sha256').update(canon({ method: r.method, route_template: r.routeTemplate, path_params: r.pathParams ?? {}, query: r.query ?? {}, body: r.body })).digest();
