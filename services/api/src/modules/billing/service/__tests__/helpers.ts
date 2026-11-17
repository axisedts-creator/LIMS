// BL-T04 test helpers (not a test file). Fake `tx` facades that recognise the three statements of 02-TRD §12 by shape, not by parameter order.
import type { Tx } from '../../../../core/db/tx.js';

export const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
export const TENANT_B = '01a1a98a-ac40-7000-8000-00000000a002';
export const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const LOCK = /set_config\(\s*'lock_timeout'/i;
export const UPD = /^\s*UPDATE\s+billing\.fiscal_counters/i;
export const INS = /INSERT\s+INTO\s+billing\.fiscal_counters/i;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Call { readonly sql: string; readonly values: unknown[] }
/** Value a set_config('lock_timeout', …) statement sets: SQL literal or the bound number/string. */
export function lockValue(c: Call): string | undefined {
  const lit = /set_config\(\s*'lock_timeout'\s*,\s*'([^']*)'/i.exec(c.sql)?.[1];
  return lit ?? c.values.map(String).find((v) => /^\d+(ms)?$/.test(v));
}
/** tenant / series / fy of a counter statement, found by shape so the writer is free to choose parameter order. */
export function keyOf(values: unknown[]): string {
  const s = values.map(String);
  const t = s.find((v) => UUID.test(v)), series = s.find((v) => /^(INV|CN|RC)(:|$)/.test(v)), fy = s.find((v) => /^\d{4}\/\d{2}$/.test(v));
  return `${t}|${series}|${fy}`;
}

export type Handler = (c: Call, n: number) => { rows: any[] } | undefined | Promise<{ rows: any[] } | undefined>;
export function fakeTx(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      const c = { sql, values };
      calls.push(c);
      return (await handler(c, calls.length)) ?? { rows: [] };
    },
    startedAt: new Date(), operation: { module: 'billing', operationId: 'BL-T04.fake' },
    savepoint: async <T>(fn: (t: Tx) => Promise<T>) => fn(tx as unknown as Tx),
  };
  return { tx: tx as unknown as Tx, calls };
}

export const pgError = (code: string, message = code) => Object.assign(new Error(message), { code });

/** A single healthy counter row: UPDATE returns the next number and `allocatedAt`. */
export function healthy(start: number, allocatedAt: string | Date): Handler {
  let last = start;
  return (c) => (UPD.test(c.sql) ? { rows: [{ last_no: ++last, allocated_at: allocatedAt }] } : undefined);
}

/** In-memory model of Postgres row locks + rollback for fiscal_counters (what the real DB gives the service). */
export class SimDb {
  rows = new Map<string, number>();
  stuck = false;
  private chain = new Map<string, Promise<void>>();
  private held = new Set<string>();
  private pending = new Map<string, { owner: object; done: Promise<void>; fin: () => void }>(); // rows INSERTed but not yet committed
  private t: number;
  constructor(startIso: string, readonly stepMs = 1) { this.t = Date.parse(startIso); }
  now() { const iso = new Date(this.t).toISOString(); this.t += this.stepMs; return iso; }
  begin() {
    const undo: Array<() => void> = [], release: Array<() => void> = [], keys: string[] = [], created: string[] = [];
    const me = {};
    let timeout = '0'; // a fresh pooled connection: no lock timeout
    let finished = false;
    // rows are only made visible (commit) or already removed (rollback, undo ran first) by the time waiters on an INSERT are woken
    const done = () => { for (const r of release) r(); for (const k of created) { const p = this.pending.get(k); this.pending.delete(k); p?.fin(); } finished = true; };
    const tx = fakeTx(async (c) => {
      if (LOCK.test(c.sql)) { timeout = lockValue(c) ?? '0'; return { rows: [{ set_config: timeout }] }; }
      if (INS.test(c.sql)) {
        const k = keyOf(c.values);
        // ON CONFLICT DO NOTHING: another tx's uncommitted row of this key makes us wait for its commit (→ conflict, no-op) or rollback (→ we insert it).
        for (let p = this.pending.get(k); p && p.owner !== me; p = this.pending.get(k)) await p.done;
        if (!this.rows.has(k)) {
          this.rows.set(k, 0);
          let fin!: () => void;
          this.pending.set(k, { owner: me, done: new Promise<void>((r) => { fin = r; }), fin });
          created.push(k); undo.push(() => this.rows.delete(k));
        }
        return { rows: [] };
      }
      if (UPD.test(c.sql)) {
        const k = keyOf(c.values);
        if (!this.rows.has(k) || (this.pending.has(k) && this.pending.get(k)!.owner !== me)) return { rows: [] }; // uncommitted rows of other txs are invisible
        if (!keys.includes(k)) {
          // `stuck` = the holder keeps the row longer than any timeout: a waiter with lock_timeout > 0 gets 55P03, one with 0 waits forever.
          if (this.held.has(k) && this.stuck && !/^0(ms)?$/.test(timeout)) throw pgError('55P03', 'canceling statement due to lock timeout');
          const prev = this.chain.get(k) ?? Promise.resolve();
          let open!: () => void;
          this.chain.set(k, new Promise<void>((r) => { open = r; }));
          await prev;
          this.held.add(k); keys.push(k);
          release.push(() => { this.held.delete(k); open(); });
        }
        const before = this.rows.get(k)!;
        this.rows.set(k, before + 1); undo.push(() => this.rows.set(k, before));
        return { rows: [{ last_no: before + 1, allocated_at: this.now() }] };
      }
      return undefined;
    });
    return {
      ...tx,
      get lockTimeout() { return timeout; },
      commit() { if (!finished) done(); },
      rollback() { if (finished) return; for (const u of undo.reverse()) u(); done(); },
    };
  }
}
