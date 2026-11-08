// AN-T04 test helper (not a test file): a small in-memory model of the analytics bookkeeping tables behind a fake `db.tx`.
// It never executes SQL. It classifies each statement by its text (02-TRD §9.2 shapes), resolves the bound/literal operands it needs
// (family, [from,to), last_marked_at guard) and applies the effect to: dirty marks, one version tag per rollup table, an event log.
// Transactions have an undo log (rollback restores), advisory locks are real mutexes held to the end of the tx, every query yields once
// so two un-serialised transactions would interleave. A statement hook may throw (failure injection) or mutate the model (marks arriving mid-run).
import { FAMILIES, FAMILY_TABLE, type Family } from '../../domain/families.js';

export type Kind = 'lock' | 'readMarks' | 'replaceDelete' | 'insertRollup' | 'deleteMarks' | 'stateUpsert' | 'runInsert' | 'runUpdate' | 'other';
export interface Mark { tenant: string; family: string; date: string; first: string; last: string }
export interface Logged { tx: number; i: number; kind: Kind; text: string; values: unknown[]; table?: string; acquiredAt?: number }
export interface Ev { tx: number; type: 'replace' | 'state_success' | 'state_failure' | 'run'; family?: string; table?: string; from?: string | null; to?: string | null; text: string; values: unknown[] }
export interface HookArg { kind: Kind; text: string; values: unknown[]; table?: string; family?: string; model: Model }
export interface Model { marks: Map<string, Mark>; partitions: Map<string, string>; clock: { now: string } }

export const T0 = '2026-11-08T06:00:00.000Z';
export const SNAPSHOT = '1970-01-01';
const tables = new Set<string>(Object.values(FAMILY_TABLE));
const markKey = (t: string, f: string, d: string) => `${t}|${f}|${d}`;

export function classify(text: string): { kind: Kind; table?: string } {
  if (/pg_advisory_xact_lock/i.test(text)) return { kind: 'lock' };
  if (/^\s*SELECT\b[\s\S]*\bFROM\s+analytics\.dirty_partitions\b/i.test(text)) return { kind: 'readMarks' };
  if (/^\s*DELETE\s+FROM\s+analytics\.dirty_partitions\b/i.test(text)) return { kind: 'deleteMarks' };
  let m = /^\s*DELETE\s+FROM\s+analytics\.(\w+)/i.exec(text);
  if (m && tables.has(m[1]!)) return { kind: 'replaceDelete', table: m[1]! };
  m = /^\s*INSERT\s+INTO\s+analytics\.(\w+)/i.exec(text);
  if (m && tables.has(m[1]!)) return { kind: 'insertRollup', table: m[1]! };
  if (m && m[1] === 'refresh_state') return { kind: 'stateUpsert' };
  if (m && m[1] === 'refresh_runs') return { kind: 'runInsert' };
  if (/^\s*UPDATE\s+analytics\.refresh_runs\b/i.test(text)) return { kind: 'runUpdate' };
  return { kind: 'other' };
}

/** `$n` -> values[n-1]; `'literal'` -> literal; anything else undefined. */
function operand(tok: string | undefined, values: unknown[]): unknown {
  if (!tok) return undefined;
  const p = /^\$(\d+)(?:::\w+)?$/.exec(tok.trim());
  if (p) return values[Number(p[1]) - 1];
  const l = /^'([^']*)'$/.exec(tok.trim());
  return l ? l[1] : undefined;
}
const grab = (text: string, re: RegExp) => re.exec(text)?.[1];
export const rangeOf = (text: string, values: unknown[]) => ({
  from: operand(grab(text, /business_date\s*>=\s*(\$\d+(?:::\w+)?|'[^']*')/i), values) as string | undefined,
  to: operand(grab(text, /business_date\s*<\s*(\$\d+(?:::\w+)?|'[^']*')/i), values) as string | undefined,
});
export function familyOfStatement(text: string, values: unknown[]): string | undefined {
  const eq = operand(grab(text, /\bfamily\s*=\s*(\$\d+(?:::\w+)?|'[^']*')/i), values);
  if (typeof eq === 'string') return eq;
  const bound = values.find((v) => typeof v === 'string' && (FAMILIES as readonly string[]).includes(v));
  if (bound) return bound as string;
  return [...text.matchAll(/'(\w+)'/g)].map((m) => m[1]!).find((s) => (FAMILIES as readonly string[]).includes(s));
}

export const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function createFakeDb(opts: { marks?: readonly { tenant: string; family: Family; date: string; last?: string }[]; hook?: (a: HookArg) => void | Promise<void>; rowCount?: number } = {}) {
  const model: Model = { marks: new Map(), partitions: new Map(), clock: { now: T0 } };
  for (const m of opts.marks ?? []) {
    const last = m.last ?? '2026-11-08T05:00:00.000Z';
    model.marks.set(markKey(m.tenant, m.family, m.date), { tenant: m.tenant, family: m.family, date: m.date, first: last, last });
  }
  const log: Logged[] = [];
  const events: Ev[] = [];
  const txs: { id: number; status: 'open' | 'committed' | 'rolled_back' }[] = [];
  const held = new Map<string, Promise<void>>();
  const sleep = () => new Promise<void>((r) => setImmediate(r));

  async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
    const id = txs.length;
    const rec = { id, status: 'open' as 'open' | 'committed' | 'rolled_back' };
    txs.push(rec);
    const undo: (() => void)[] = [];
    const pending: Ev[] = [];
    const releases: (() => void)[] = [];
    let range: { from?: string; to?: string } = {};
    let i = 0;
    const query = async (text: string, values: unknown[] = []) => {
      await sleep();
      const { kind, table } = classify(text);
      const entry: Logged = { tx: id, i: i++, kind, text, values, ...(table ? { table } : {}) };
      log.push(entry);
      const family = familyOfStatement(text, values);
      if (opts.hook) await opts.hook({ kind, text, values, ...(table ? { table } : {}), ...(family ? { family } : {}), model });
      switch (kind) {
        case 'lock': {
          const key = text + JSON.stringify(values);
          while (held.has(key)) await held.get(key);
          entry.acquiredAt = log.length;   // log position at which the lock was actually granted
          let release!: () => void;
          held.set(key, new Promise<void>((r) => { release = () => { held.delete(key); r(); }; }));
          releases.push(release);
          return { rows: [], rowCount: 1 };
        }
        case 'readMarks': {
          const rows = [...model.marks.values()].filter((m) => m.tenant === values[0])
            .sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
            .map((m) => ({ family: m.family, business_date: m.date, first_marked_at: m.first, last_marked_at: m.last }));
          return { rows, rowCount: rows.length };
        }
        case 'replaceDelete': {
          const r = rangeOf(text, values);
          if (r.from !== undefined) range = r;
          const prev = model.partitions.get(table!);
          model.partitions.set(table!, 'gone');
          undo.push(() => (prev === undefined ? model.partitions.delete(table!) : model.partitions.set(table!, prev)));
          return { rows: [], rowCount: 9 };
        }
        case 'insertRollup': {
          const prev = model.partitions.get(table!);
          model.partitions.set(table!, 'new');
          undo.push(() => (prev === undefined ? model.partitions.delete(table!) : model.partitions.set(table!, prev)));
          const fam = (FAMILIES as readonly string[]).find((f) => FAMILY_TABLE[f as Family] === table);
          pending.push({ tx: id, type: 'replace', ...(fam ? { family: fam } : {}), table: table!, from: range.from ?? null, to: range.to ?? null, text, values });
          return { rows: [], rowCount: opts.rowCount ?? 3 };
        }
        case 'deleteMarks': {
          const r = rangeOf(text, values);
          const guard = operand(grab(text, /last_marked_at\s*<=\s*(\$\d+(?:::\w+)?|'[^']*')/i), values);
          const gone: Mark[] = [];
          for (const [k, m] of [...model.marks]) {
            if (m.tenant !== values[0] || m.family !== family) continue;
            if (r.from !== undefined && m.date < r.from) continue;
            if (r.to !== undefined && m.date >= r.to) continue;
            if (typeof guard === 'string' && Date.parse(m.last) > Date.parse(guard)) continue;
            gone.push(m); model.marks.delete(k);
          }
          undo.push(() => gone.forEach((m) => model.marks.set(markKey(m.tenant, m.family, m.date), m)));
          return { rows: [], rowCount: gone.length };
        }
        case 'stateUpsert':
          pending.push({ tx: id, type: /last_success_at\s*=/i.test(text) ? 'state_success' : 'state_failure', ...(family ? { family } : {}), text, values });
          return { rows: [], rowCount: 1 };
        case 'runInsert': case 'runUpdate':
          pending.push({ tx: id, type: 'run', ...(family ? { family } : {}), text, values });
          return { rows: [], rowCount: 1 };
        default: return { rows: [], rowCount: 0 };
      }
    };
    try {
      const out = await fn({ tx: { query } });
      rec.status = 'committed';
      events.push(...pending);
      return out;
    } catch (e) {
      undo.reverse().forEach((u) => u());
      rec.status = 'rolled_back';
      throw e;
    } finally { releases.forEach((r) => r()); }
  }
  return { model, log, events, txs, db: { tx }, committed: (type?: Ev['type']) => events.filter((e) => (!type || e.type === type)) };
}

/** JobContext subset the refresh engine may use (services/worker core/manifest.ts JobContext). `now()` returns the model clock. */
export function createCtx(fake: ReturnType<typeof createFakeDb>, over: { tenantId?: string | undefined; actorId?: string } = {}) {
  return {
    tenantId: 'tenantId' in over ? over.tenantId : undefined,
    actor: { type: 'system' as const, id: over.actorId ?? ACTOR },
    requestId: 'req-an-t04', jobId: '1', attempt: 1, maxAttempts: 5,
    db: fake.db,
    now: () => fake.model.clock.now,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}
export const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
