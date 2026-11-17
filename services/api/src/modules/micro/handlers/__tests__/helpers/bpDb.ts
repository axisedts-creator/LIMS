// C10 T-13 test helper — an in-memory, multi-transaction fake of the micro tables the breakpoint lifecycle touches.
// NOT a SQL engine: a small, strict dialect (anything outside it THROWS "fake dialect: ..." so a test never passes by accident):
//   SELECT <list> FROM [micro.]<table> [alias] [WHERE <expr>] [ORDER BY ..] [LIMIT n] [FOR UPDATE]   (single table: no JOIN, no sub-select; `count(*)` allowed)
//   UPDATE [micro.]<table> [alias] SET col = <expr>, ... WHERE <expr> [RETURNING ...]
//   INSERT INTO [micro.]<table> (cols) VALUES (exprs) [ON CONFLICT [(cols)] DO NOTHING] [RETURNING ...]      (no DO UPDATE: lock with SELECT ... FOR UPDATE)
//   SAVEPOINT / RELEASE / ROLLBACK TO / SET LOCAL / select set_config(...) are accepted and ignored.
//   <expr>: $n[::type], 'text', numbers, NULL/TRUE/FALSE, now(), column (alias.col allowed), + -, = <> != < <= > >=, IS [NOT] NULL, [NOT] IN (...), = ANY(expr),
//           AND / OR / NOT, parentheses, greatest()/least()/coalesce(), ::casts.
// Semantics: READ COMMITTED (a statement sees committed rows + its own tx's writes), row locks taken by UPDATE and SELECT ... FOR UPDATE and held to commit/rollback
//   (a waiter re-evaluates its WHERE after the lock is granted, as PostgreSQL does), 3 s lock wait => Error "lock wait timeout (deadlock?)".
//   Every statement first yields 0-2 macro-task turns (seeded), so parallel transactions really interleave.
// micro.breakpoint_sets guard (05-SCHEMA §8): status transitions per 03-APP-FLOW §2.5, effective_from frozen once active, CHECK effective_to >= effective_from,
//   CHECK active/retired => effective_from not null  => SQLSTATE P0001 'immutable_row' / 23514.
import { canTransition, type BpStatus } from '../../../domain/breakpoint-set.state.js';

export type Row = Record<string, any>;
export const NOW = new Date('2026-06-15T05:00:30.000Z');

type Tok = { k: 'p' | 's' | 'n' | 'id' | 'op'; v: string };
type Ast = { t: string; [x: string]: any };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    let m: RegExpExecArray | null;
    const rest = src.slice(i);
    if ((m = /^\$(\d+)/.exec(rest))) { out.push({ k: 'p', v: m[1]! }); i += m[0].length; continue; }
    if (c === "'") { let j = i + 1; let s = ''; for (;;) { if (j >= src.length) throw new Error('fake dialect: unterminated string'); if (src[j] === "'") { if (src[j + 1] === "'") { s += "'"; j += 2; continue; } break; } s += src[j++]; } out.push({ k: 's', v: s }); i = j + 1; continue; }
    if ((m = /^\d+(\.\d+)?/.exec(rest))) { out.push({ k: 'n', v: m[0] }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_.]*(\[\])?/.exec(rest))) { out.push({ k: 'id', v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(::|<=|>=|<>|!=|=|<|>|\+|-|\(|\)|,|\*)/.exec(rest))) { out.push({ k: 'op', v: m[0] }); i += m[0].length; continue; }
    throw new Error(`fake dialect: cannot tokenize "${rest.slice(0, 20)}"`);
  }
  return out;
}

class P {
  i = 0;
  constructor(readonly t: Tok[], readonly src: string) {}
  peek(o = 0) { return this.t[this.i + o]; }
  isKw(w: string, o = 0) { const x = this.peek(o); return x?.k === 'id' && x.v.toUpperCase() === w; }
  isOp(w: string, o = 0) { const x = this.peek(o); return x?.k === 'op' && x.v === w; }
  eat() { return this.t[this.i++]!; }
  need(w: string) { const x = this.eat(); if (!x || x.v.toUpperCase() !== w) throw new Error(`fake dialect: expected ${w} in "${this.src}"`); }
  done() { return this.i >= this.t.length; }
  or(): Ast { let l = this.and(); while (this.isKw('OR')) { this.eat(); l = { t: 'or', l, r: this.and() }; } return l; }
  and(): Ast { let l = this.not(); while (this.isKw('AND')) { this.eat(); l = { t: 'and', l, r: this.not() }; } return l; }
  not(): Ast { if (this.isKw('NOT')) { this.eat(); return { t: 'not', e: this.not() }; } return this.cmp(); }
  cmp(): Ast {
    const l = this.add();
    const x = this.peek();
    if (!x) return l;
    if (x.k === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(x.v)) {
      this.eat();
      if (x.v === '=' && this.isKw('ANY')) { this.eat(); this.need_op('('); const e = this.or(); this.need_op(')'); return { t: 'any', l, e }; }
      return { t: 'cmp', op: x.v === '!=' ? '<>' : x.v, l, r: this.add() };
    }
    if (this.isKw('IS')) { this.eat(); let neg = false; if (this.isKw('NOT')) { this.eat(); neg = true; } this.need('NULL'); return { t: 'isnull', e: l, neg }; }
    if (this.isKw('IN') || (this.isKw('NOT') && this.isKw('IN', 1))) {
      let neg = false; if (this.isKw('NOT')) { this.eat(); neg = true; } this.eat(); this.need_op('(');
      const items: Ast[] = [this.add()]; while (this.isOp(',')) { this.eat(); items.push(this.add()); }
      this.need_op(')'); return { t: 'in', e: l, items, neg };
    }
    return l;
  }
  need_op(o: string) { const x = this.eat(); if (!x || x.v !== o) throw new Error(`fake dialect: expected ${o} in "${this.src}"`); }
  add(): Ast { let l = this.cast(); while (this.isOp('+') || this.isOp('-')) { const op = this.eat().v; l = { t: 'arith', op, l, r: this.cast() }; } return l; }
  cast(): Ast { let e = this.prim(); while (this.isOp('::')) { this.eat(); e = { t: 'cast', e, to: this.eat().v.toLowerCase() }; } return e; }
  prim(): Ast {
    const x = this.eat();
    if (!x) throw new Error(`fake dialect: unexpected end in "${this.src}"`);
    if (x.k === 'p') return { t: 'param', n: Number(x.v) };
    if (x.k === 's') return { t: 'lit', v: x.v };
    if (x.k === 'n') return { t: 'lit', v: Number(x.v) };
    if (x.k === 'op' && x.v === '(') { const e = this.or(); this.need_op(')'); return e; }
    if (x.k === 'id') {
      const u = x.v.toUpperCase();
      if (u === 'NULL') return { t: 'lit', v: null };
      if (u === 'TRUE') return { t: 'lit', v: true };
      if (u === 'FALSE') return { t: 'lit', v: false };
      if (this.isOp('(')) {
        this.eat(); const args: Ast[] = [];
        if (!this.isOp(')')) { args.push(this.or()); while (this.isOp(',')) { this.eat(); args.push(this.or()); } }
        this.need_op(')');
        if (!['now', 'greatest', 'least', 'coalesce', 'count'].includes(x.v.toLowerCase())) throw new Error(`fake dialect: function ${x.v}() not supported`);
        return { t: 'fn', name: x.v.toLowerCase(), args };
      }
      return { t: 'col', name: x.v.split('.').pop()!.toLowerCase() };
    }
    throw new Error(`fake dialect: unexpected "${x.v}" in "${this.src}"`);
  }
}
const parseExpr = (src: string): Ast => { const p = new P(tokenize(src), src); const e = p.or(); if (!p.done()) throw new Error(`fake dialect: trailing tokens in "${src}"`); return e; };

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const norm = (v: unknown): unknown => (v instanceof Date ? v.getTime() : typeof v === 'string' && ISO.test(v) ? Date.parse(v) : v);
const toDate = (v: unknown): unknown => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v as string));

function evalAst(a: Ast, row: Row, params: unknown[], now: Date): any {
  const ev = (x: Ast) => evalAst(x, row, params, now);
  switch (a.t) {
    case 'lit': return a.v;
    case 'param': { if (a.n > params.length) throw new Error(`fake dialect: $${a.n} has no bound value`); const v = params[a.n - 1]; return v === undefined ? null : v; }
    case 'col': return row[a.name] === undefined ? null : row[a.name];
    case 'cast': { const v = ev(a.e); if (v === null) return null; if (a.to.startsWith('timestamp')) return toDate(v); if (a.to === 'integer' || a.to === 'int') return Number(v); if (a.to.endsWith('[]')) return v; return v; }
    case 'fn': {
      const args = a.args.map(ev);
      if (a.name === 'now') return new Date(now);
      if (a.name === 'coalesce') return args.find((v: unknown) => v !== null) ?? null;
      const live = args.filter((v: unknown) => v !== null);
      if (live.length === 0) return null;
      const pick = a.name === 'greatest' ? (x: any, y: any) => (norm(x) as number) >= (norm(y) as number) ? x : y : (x: any, y: any) => (norm(x) as number) <= (norm(y) as number) ? x : y;
      return live.reduce(pick);
    }
    case 'arith': { const l = ev(a.l); const r = ev(a.r); if (l === null || r === null) return null; return a.op === '+' ? (norm(l) as number) + (norm(r) as number) : (norm(l) as number) - (norm(r) as number); }
    case 'isnull': { const v = ev(a.e); return a.neg ? v !== null : v === null; }
    case 'not': { const v = ev(a.e); return v === null ? null : !v; }
    case 'and': { const l = ev(a.l); if (l === false) return false; const r = ev(a.r); if (r === false) return false; return l === null || r === null ? null : true; }
    case 'or': { const l = ev(a.l); if (l === true) return true; const r = ev(a.r); if (r === true) return true; return l === null || r === null ? null : false; }
    case 'any': { const l = ev(a.l); const arr = ev(a.e); if (l === null || !Array.isArray(arr)) return null; return arr.some((x: unknown) => norm(x) === norm(l)); }
    case 'in': { const l = ev(a.e); if (l === null) return null; const hit = a.items.some((it: Ast) => norm(ev(it)) === norm(l)); return a.neg ? !hit : hit; }
    case 'cmp': {
      const l = norm(ev(a.l)); const r = norm(ev(a.r));
      if (l === null || r === null) return null;
      switch (a.op) { case '=': return l === r; case '<>': return l !== r; case '<': return (l as any) < (r as any); case '<=': return (l as any) <= (r as any); case '>': return (l as any) > (r as any); default: return (l as any) >= (r as any); }
    }
    default: throw new Error(`fake dialect: ast ${a.t}`);
  }
}

const splitTop = (s: string): string[] => {
  const out: string[] = []; let d = 0; let q = false; let cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') d++;
    if (!q && ch === ')') d--;
    if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

const TABLES = ['breakpoint_sets', 'breakpoint_rows', 'breakpoint_bands', 'breakpoint_import_issues', 'settings', 'isolates', 'cultures', 'v_organisms', 'ast_results'] as const;
const WRITABLE = new Set(['breakpoint_sets', 'settings']);
const SETTINGS_DEFAULTS: Row = { manual_ast_standard: null, zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: true, recent_window_days: 7, version: 1, is_active: true };

function guardSets(old: Row | undefined, next: Row): void {
  const err = (code: string, msg: string) => Object.assign(new Error(msg), { code });
  if (old && old['status'] !== next['status'] && !canTransition(old['status'] as BpStatus, next['status'] as BpStatus)) throw err('P0001', 'immutable_row');
  if (old && old['status'] === 'active' && norm(old['effective_from']) !== norm(next['effective_from'])) throw err('P0001', 'immutable_row');
  if (['active', 'retired'].includes(next['status']) && next['effective_from'] == null) throw err('23514', 'breakpoint_sets__active_dates__ck');
  if (next['effective_to'] != null && next['effective_from'] != null && (norm(next['effective_to']) as number) < (norm(next['effective_from']) as number)) throw err('23514', 'breakpoint_sets__range__ck');
}

export interface Stmt { readonly tx: number; readonly kind: 'select' | 'for_update' | 'update' | 'insert' | 'other'; readonly table: string; readonly text: string; readonly params: unknown[] }

export function makeDb(o: { seed?: number; now?: Date; spread?: boolean } = {}) {
  let rs = (o.seed ?? 1) >>> 0;
  const rnd = () => { rs = (rs + 0x6d2b79f5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const now = o.now ?? NOW;
  const committed = new Map<string, Map<string, Row>>(TABLES.map((t) => [t, new Map()]));
  const locks = new Map<string, { tx: number; q: (() => void)[] }>();
  const log: Stmt[] = [];
  const state = { writes: 0, failAtWrite: 0, txSeq: 0 };
  const clone = (r: Row): Row => ({ ...r });
  const tbl = (name: string): Map<string, Row> => { const t = committed.get(name); if (!t) throw new Error(`fake dialect: table ${name} not modelled`); return t; };

  function begin(tenantId?: string) {
    const id = ++state.txSeq;
    const over = new Map<string, Map<string, Row | null>>();
    const held = new Set<string>();
    let open = true;
    const ov = (t: string) => { let m = over.get(t); if (!m) { m = new Map(); over.set(t, m); } return m; };
    const view = (t: string): Row[] => {
      const base = new Map(tbl(t));
      for (const [k, v] of over.get(t) ?? []) { if (v === null) base.delete(k); else base.set(k, v); }
      return [...base.values()];
    };
    async function lock(t: string, rowId: string) {
      const key = `${t}:${rowId}`;
      for (;;) {
        const cur = locks.get(key);
        if (!cur || cur.tx === id) { if (!cur) locks.set(key, { tx: id, q: [] }); held.add(key); return; }
        await new Promise<void>((res, rej) => {
          const to = setTimeout(() => rej(new Error('lock wait timeout (deadlock?)')), 3000);
          cur.q.push(() => { clearTimeout(to); res(); });
        });
      }
    }
    const release = () => { for (const k of held) { const l = locks.get(k); locks.delete(k); l?.q.forEach((f) => f()); } held.clear(); };
    const yieldTurns = async () => { const n = o.spread === false ? 0 : Math.floor(rnd() * 3); for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

    /** rows matching WHERE in this tx's view; with lockRows, lock them and re-evaluate until stable (READ COMMITTED re-check). */
    async function match(t: string, where: Ast | null, params: unknown[], lockRows: boolean): Promise<Row[]> {
      const pass = (r: Row) => where === null || evalAst(where, r, params, now) === true;
      for (let guard = 0; guard < 50; guard++) {
        const hit = view(t).filter(pass);
        if (!lockRows) return hit.map(clone);
        for (const r of hit) await lock(t, r['id']);
        const again = view(t).filter(pass);
        if (again.length === hit.length && again.every((r) => hit.some((h) => h['id'] === r['id']))) return again;
      }
      throw new Error('fake: lock loop did not stabilise');
    }

    async function query(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      if (!open) throw new Error('fake: query on a finished transaction');
      await yieldTurns();
      const sqlText = text.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().replace(/;$/, '');
      if (/^(SAVEPOINT|RELEASE|ROLLBACK TO|SET LOCAL|BEGIN|COMMIT)\b/i.test(sqlText) || /^SELECT\s+set_config\(/i.test(sqlText)) return { rows: [], rowCount: 0 };
      let m: RegExpExecArray | null;
      if ((m = /^SELECT\s+([\s\S]+?)\s+FROM\s+(?:micro\.)?(\w+)(?:\s+(?:AS\s+)?(?!WHERE\b|ORDER\b|LIMIT\b|FOR\b)(\w+))?(\s+[\s\S]*)?$/i.exec(sqlText))) {
        const [, list, table, , tail = ''] = m;
        if (/\b(JOIN|UNION)\b|\(\s*SELECT\b/i.test(sqlText)) throw new Error(`fake dialect: single-table SELECT only (no JOIN / sub-select): ${sqlText.slice(0, 120)}`);
        let rest = tail;
        const forUpdate = /\sFOR\s+UPDATE(\s+(NOWAIT|SKIP\s+LOCKED))?\s*$/i.test(rest);
        if (forUpdate) rest = rest.replace(/\sFOR\s+UPDATE(\s+(NOWAIT|SKIP\s+LOCKED))?\s*$/i, '');
        rest = rest.replace(/\sLIMIT\s+(\d+|\$\d+)\s*$/i, '').replace(/\sORDER\s+BY\s+[\s\S]*$/i, '');
        const w = /^\s*WHERE\s+([\s\S]+)$/i.exec(rest);
        if (rest.trim() && !w) throw new Error(`fake dialect: unsupported SELECT tail "${rest.trim().slice(0, 60)}"`);
        const where = w ? parseExpr(w[1]!) : null;
        log.push({ tx: id, kind: forUpdate ? 'for_update' : 'select', table: table!, text: sqlText, params });
        const rows = await match(table!, where, params, forUpdate);
        if (/^count\(\*\)/i.test(list!)) return { rows: [{ count: rows.length }], rowCount: 1 };
        return { rows, rowCount: rows.length };
      }
      if ((m = /^UPDATE\s+(?:micro\.)?(\w+)(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+?)(?:\s+RETURNING\s+([\s\S]+))?$/i.exec(sqlText))) {
        const [, table, sets, wh, returning] = m;
        if (!WRITABLE.has(table!)) throw new Error(`fake dialect: UPDATE on ${table} — a breakpoint lifecycle operation must never write there (AC-13.4)`);
        log.push({ tx: id, kind: 'update', table: table!, text: sqlText, params });
        if (++state.writes === state.failAtWrite) throw new Error('injected failure');
        const assigns = splitTop(sets!).map((a) => { const e = /^(\w+)\s*=\s*([\s\S]+)$/.exec(a); if (!e) throw new Error(`fake dialect: SET item "${a}"`); return { col: e[1]!.toLowerCase(), ast: parseExpr(e[2]!) }; });
        const rows = await match(table!, parseExpr(wh!), params, true);
        const out: Row[] = [];
        for (const r of rows) {
          const next = clone(r);
          for (const a of assigns) next[a.col] = evalAst(a.ast, r, params, now);
          if (table === 'breakpoint_sets') guardSets(r, next);
          ov(table!).set(next['id'], next);
          out.push(clone(next));
        }
        return { rows: returning ? out : [], rowCount: out.length };
      }
      if ((m = /^INSERT\s+INTO\s+(?:micro\.)?(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(ON\s+CONFLICT[\s\S]*?)?(?:\s*RETURNING\s+([\s\S]+))?$/i.exec(sqlText))) {
        const [, table, cols, vals, conflict, returning] = m;
        if (!WRITABLE.has(table!)) throw new Error(`fake dialect: INSERT into ${table} is not expected from a breakpoint lifecycle operation`);
        if (conflict && !/DO\s+NOTHING\s*$/i.test(conflict)) throw new Error('fake dialect: only ON CONFLICT DO NOTHING (lock the settings row with SELECT ... FOR UPDATE)');
        log.push({ tx: id, kind: 'insert', table: table!, text: sqlText, params });
        if (++state.writes === state.failAtWrite) throw new Error('injected failure');
        const names = cols!.split(',').map((c) => c.trim().toLowerCase());
        const exprs = splitTop(vals!).map(parseExpr);
        if (names.length !== exprs.length) throw new Error('fake dialect: column/value count');
        const row: Row = table === 'settings' ? { ...SETTINGS_DEFAULTS } : {};
        names.forEach((n, i) => { row[n] = evalAst(exprs[i]!, {}, params, now); });
        row['created_at'] ??= new Date(now); row['updated_at'] ??= new Date(now);
        const key = table === 'settings' ? (r: Row) => r['tenant_id'] === row['tenant_id'] : (r: Row) => r['id'] === row['id'];
        // an insert of a key that is not committed yet waits for a concurrent uncommitted insert of the same key (unique index); an existing key does not block
        if (!view(table!).some(key)) await lock(table!, `uniq:${table === 'settings' ? row['tenant_id'] : row['id']}`);
        if (view(table!).some(key)) {
          if (conflict) return { rows: [], rowCount: 0 };
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        if (table === 'settings') for (const need of ['id', 'tenant_id', 'created_by', 'updated_by']) if (row[need] == null) throw Object.assign(new Error(`null value in column ${need}`), { code: '23502' });
        ov(table!).set(row['id'], row);
        return { rows: returning ? [clone(row)] : [], rowCount: 1 };
      }
      if (/^DELETE\b/i.test(sqlText)) throw new Error(`fake dialect: DELETE is never expected from the breakpoint lifecycle (AC-13.4): ${sqlText.slice(0, 80)}`);
      throw new Error(`fake dialect: statement not supported: ${sqlText.slice(0, 160)}`);
    }

    return {
      id, tenantId, query,
      commit() { for (const [t, m] of over) for (const [k, v] of m) { if (v === null) tbl(t).delete(k); else tbl(t).set(k, v); } over.clear(); open = false; release(); },
      rollback() { over.clear(); open = false; release(); },
    };
  }

  return {
    begin, log, state,
    now,
    /** direct committed insert (test setup), any modelled table */
    put(table: (typeof TABLES)[number], row: Row): Row { const r = { ...row }; if (r['id'] === undefined) throw new Error('put: id required'); tbl(table).set(r['id'], r); return r; },
    rows(table: (typeof TABLES)[number]): Row[] { return [...tbl(table).values()].map(clone); },
    get(table: (typeof TABLES)[number], id: string): Row | undefined { const r = tbl(table).get(id); return r ? clone(r) : undefined; },
    snapshot(): string { return JSON.stringify([...committed].map(([t, m]) => [t, [...m.values()]])); },
    writeCount: () => log.filter((s) => s.kind === 'update' || s.kind === 'insert').length,
  };
}
export type Db = ReturnType<typeof makeDb>;
