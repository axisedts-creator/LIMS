// C6-T04 test helpers (not a test file). Synthetic data only.
// An in-memory fake of ONE Postgres transaction for the reporting consumers, modelled by SQL CONTENT (never statement position):
//   - tables are any `schema.table`; DDL defaults + unique keys + FKs for the reporting tables the consumers touch (05-SCHEMA §2)
//   - WHERE: AND of atoms, parenthesised OR groups; atoms `col op $n|literal`, `col = ANY($n)`, `$n = ANY(col)`, `col IN (...)`, `col IS [NOT] NULL`, `$n IS [NOT] NULL`
//   - INSERT ... VALUES (...) [, (...)] [ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET ...] [RETURNING]; a plain INSERT hitting a unique key raises 23505
//   - UPDATE ... SET col = $n | col + n | EXCLUDED.col | COALESCE | GREATEST | literal | now() ... WHERE ... [RETURNING]
//   - SELECT ... FROM <one table> [alias] WHERE ... [ORDER BY | FOR UPDATE | LIMIT]; JOIN / sub-select / WITH / unnest / INSERT..SELECT are NOT modelled and
//     throw `FAKE-UNSUPPORTED-SQL` (write single-table statements; see .orchestra/notes/C6-T04-tests.md)
//   - `SELECT app.enqueue_job(identifier, payload, job_key, run_at, max_attempts)` is recorded in `jobs`
//   - rls:true (default) hides other tenants' rows and refuses foreign-tenant INSERTs (42501); rls:false removes that safety net so only the
//     statement's own tenant predicate protects (REQ-SEC-024)

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const idN = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const SYSTEM_ACTOR = idN(0xa009);
export const NOW = '2026-11-07T12:00:30.000Z';
export const OCCURRED_AT = '2026-11-07T12:00:00.000Z';

export const ORDER = idN(0xf001);
export const PATIENT = idN(0xba7e);
export const BRANCH = idN(0xb001);
export const CENTRE = idN(0xc001);
export const REFERRER = idN(0xd0c1);
export const PARTNER = idN(0x9a47);
export const ITEM_CBC = idN(0x1001);
export const ITEM_XRAY = idN(0x1002);
export const ITEM_OUT = idN(0x1003);
export const ORDERABLE_CBC = idN(0x2001);
export const ORDERABLE_XRAY = idN(0x2002);
export const ORDERABLE_OUT = idN(0x2003);
export const TEST_CBC = idN(0x3001);
export const TEST_XRAY = idN(0x3002);
export const TEST_OUT = idN(0x3003);
export const TEMPLATE_XRAY = idN(0x4001);
export const REG_NO = 'REG-SENTINEL-77';
export const CENTRE_CODE = 'KTM01';

export type Row = Record<string, any>;
export const pgError = (code: string, message = 'db error') => Object.assign(new Error(message), { code });
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

// ------------------------------------------------------------------------------------------------ DDL knowledge (05-SCHEMA §2)
const DEFAULTS: Record<string, Row> = {
  'reporting.reports': { state: 'open', needs_assembly: false, needs_assembly_since: null, latest_version_no: 0, released_version_no: null, lab_ready_seq: null,
    lab_approved_set_hash: null, lab_completeness: null, lab_contains_amendment: false, regeneration_counter: 0, review_flag: null, cancelled_at: null,
    referrer_id: null, partner_id: null, version: 1 },
  'reporting.report_order_items': { narrative_test_ids: [], item_status: 'active', lab_ready: false, narrative_ready: false, outsourced_ready: false,
    ready_marker: null, approved_results: 0, amendment_pending: false, specimen_hint: null, specimen_hint_seq: null, items_version: null, version: 1 },
  'reporting.narrative_reports': { status: 'draft', current_version_no: 1, signed_version_no: null, version: 1 },
  'reporting.narrative_versions': { status: 'draft', image_file_ids: [], template_id: null, version: 1 },
  'reporting.report_versions': { status: 'rendering', discarded_at: null, discard_reason: null, released_at: null, version: 1 },
  'reporting.settings': { auto_release: 'when_eligible', narrative_report_mode: 'separate', is_active: true, version: 1 },
};
const UNIQUE: Record<string, string[][]> = {
  'reporting.reports': [['id'], ['tenant_id', 'order_id', 'family']],
  'reporting.report_order_items': [['id'], ['tenant_id', 'order_item_id', 'report_id']],
  'reporting.narrative_reports': [['id'], ['tenant_id', 'order_item_id', 'test_id']],
  'reporting.narrative_versions': [['id'], ['tenant_id', 'narrative_report_id', 'version_no']],
  'reporting.report_versions': [['id'], ['tenant_id', 'report_id', 'version_no']],
  'reporting.settings': [['tenant_id']],
};
const FKS: Array<[string, string, string]> = [   // [child table, child col, parent table] (parent matched by id + tenant_id)
  ['reporting.report_order_items', 'report_id', 'reporting.reports'],
  ['reporting.narrative_reports', 'report_id', 'reporting.reports'],
  ['reporting.narrative_versions', 'narrative_report_id', 'reporting.narrative_reports'],
];

export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly verb: string }
export interface JobRec { identifier: string; payload: any; jobKey: string | null; runAt: unknown; maxAttempts: unknown; text: string }

// ------------------------------------------------------------------------------------------------ tiny SQL helpers
const unsupported = (what: string): never => { throw new Error(`FAKE-UNSUPPORTED-SQL: ${what} (single-table statements with $n parameters only)`); };
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const splitMemo = new Map<string, string[]>();   // pure function of (s, sep): evalWhere re-splits the same WHERE text once per ROW per statement (O(rows x len^2)); cache it (C6-T14 load host cost)
function splitTop(s: string, sep: RegExp): string[] {
  const key = `${sep.source}/${sep.flags}|${s}`; const hit = splitMemo.get(key);
  if (hit) return [...hit];
  const r = splitTopRaw(s, sep); if (splitMemo.size > 5000) splitMemo.clear(); splitMemo.set(key, r); return [...r];
}
function splitTopRaw(s: string, sep: RegExp): string[] {   // split on a separator word/char at paren depth 0 and outside quotes
  const out: string[] = []; let d = 0; let q = false; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") q = !q;
    if (!q && ch === '(') d++;
    if (!q && ch === ')') d--;
    if (!q && d === 0) { const m = sep.exec(s.slice(i)); if (m && m.index === 0 && m[0]!.length > 0) { out.push(cur.trim()); cur = ''; i += m[0]!.length - 1; continue; } }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const stripParens = (s: string): string => { let t = s.trim(); while (t.startsWith('(') && t.endsWith(')') && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim(); return t; };
function balanced(s: string): boolean { let d = 0; for (const ch of s) { if (ch === '(') d++; if (ch === ')' && --d < 0) return false; } return d === 0; }
function groups(s: string): string[] {   // "(a,b),(c,d)" -> ["a,b","c,d"]
  const out: string[] = []; let d = 0; let cur = ''; let q = false;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') { if (d++ === 0) { cur = ''; continue; } }
    else if (!q && ch === ')') { if (--d === 0) { out.push(cur); continue; } }
    if (d > 0) cur += ch;
  }
  return out;
}

let counter = 0x70000;
const stripCast = (t: string) => t.replace(/::[a-z_]+(\[\])?$/i, '').trim();
function value(tok: string, values: readonly unknown[], row?: Row, excluded?: Row): unknown {
  const t = stripCast(tok.trim());
  let m: RegExpExecArray | null;
  if ((m = /^\$(\d+)$/.exec(t))) return values[Number(m[1]) - 1];
  if (/^now\(\)$/i.test(t)) return NOW;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^null$/i.test(t)) return null;
  if (/^'\{\}'$/.test(t)) return [];
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if ((m = /^excluded\.(\w+)$/i.exec(t))) return excluded?.[m[1]!];
  if (/^(gen_random_uuid|uuid_generate_v\d|uuidv7|app\.uuidv7)\(\)$/i.test(t)) return idN(++counter);
  if (row && (m = /^(?:[\w.]+\.)?(\w+)$/.exec(t)) && m[1]! in row) return row[m[1]!];
  return unsupported(`expression \`${tok}\``);
}
function setExpr(rhs: string, values: readonly unknown[], row: Row, excluded?: Row): unknown {
  const r = stripParens(rhs); let m: RegExpExecArray | null;
  if ((m = /^(?:[\w.]+\.)?(\w+)\s*\+\s*(\d+|\$\d+(?:::\w+)?)$/.exec(r))) return (row[m[1]!] ?? 0) + Number(value(m[2]!, values, row, excluded));
  if ((m = /^coalesce\s*\((.*)\)$/is.exec(r))) { for (const a of splitTop(m[1]!, /^,/)) { const v = setExpr(a, values, row, excluded); if (v !== null && v !== undefined) return v; } return null; }
  if ((m = /^greatest\s*\((.*)\)$/is.exec(r))) { const vs = splitTop(m[1]!, /^,/).map((a) => setExpr(a, values, row, excluded)).filter((v) => v !== null && v !== undefined) as number[]; return vs.length ? Math.max(...vs) : null; }
  return value(r, values, row, excluded);
}
function applySet(row: Row, set: string, values: readonly unknown[], excluded?: Row) {
  const before = { ...row };
  for (const a of splitTop(set, /^,/)) {
    const m = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(a); if (!m) { unsupported(`SET item \`${a}\``); continue; }
    row[m[1]!] = setExpr(m[2]!, values, before, excluded);
  }
}

function evalAtom(row: Row, atomRaw: string, values: readonly unknown[]): boolean {
  const atom = stripParens(atomRaw); let m: RegExpExecArray | null;
  const col = (c: string) => row[c.replace(/^\w+\./, '')];
  if ((m = /^\$(\d+)(?:::\w+)?\s+is\s+(not\s+)?null$/i.exec(atom))) { const isNull = values[Number(m[1]) - 1] == null; return m[2] ? !isNull : isNull; }
  if ((m = /^([\w.]+)\s+is\s+(not\s+)?null$/i.exec(atom))) { const isNull = col(m[1]!) == null; return m[2] ? !isNull : isNull; }
  if ((m = /^([\w.]+)\s*=\s*any\s*\(\s*\$(\d+)(?:::\w+\[\])?\s*\)$/i.exec(atom))) { const arr = values[Number(m[2]) - 1]; return Array.isArray(arr) && arr.includes(col(m[1]!)); }
  if ((m = /^\$(\d+)(?:::\w+)?\s*=\s*any\s*\(\s*([\w.]+)\s*\)$/i.exec(atom))) { const arr = col(m[2]!); return Array.isArray(arr) && arr.includes(values[Number(m[1]) - 1]); }
  if ((m = /^([\w.]+)\s+(not\s+)?in\s*\(([^)]*)\)$/i.exec(atom))) { const set = m[3]!.split(',').map((x) => value(x, values)); const hit = set.includes(col(m[1]!)); return m[2] ? !hit : hit; }
  if ((m = /^([\w.]+)\s*(<>|!=|<=|>=|=|<|>)\s*(\S+(?:::\w+)?)$/.exec(atom))) {
    const l = col(m[1]!); const r = value(m[3]!, values) as any;
    if (l == null || r == null) return false;
    switch (m[2]) { case '=': return l === r; case '<>': case '!=': return l !== r; case '<': return l < r; case '<=': return l <= r; case '>': return l > r; default: return l >= r; }
  }
  return unsupported(`WHERE atom \`${atom}\``);
}
const whereMemo = new Map<string, string[][]>();   // WHERE text -> AND-list of OR-lists of atoms (parsed once, not once per row)
function evalWhere(row: Row, where: string, values: readonly unknown[]): boolean {
  if (!where.trim()) return true;
  let c = whereMemo.get(where);
  if (!c) { c = splitTop(where, /^\s+and\s+/i).map((conj) => splitTop(stripParens(conj), /^\s+or\s+/i)); if (whereMemo.size > 5000) whereMemo.clear(); whereMemo.set(where, c); }
  return c.every((ors) => ors.some((a) => evalAtom(row, a, values)));
}

// ------------------------------------------------------------------------------------------------ the database
export interface Seed { [table: string]: Row[] }
export interface DbOpts { rls?: boolean; tenant?: string; allowDelete?: readonly string[]; failOn?: Array<{ match: RegExp; error: () => Error; times?: number }> }

export function makeDb(seed: Seed = {}, opts: DbOpts = {}) {
  const rls = opts.rls ?? true; const tenant = opts.tenant ?? TENANT_A;
  const store: Record<string, Row[]> = {};
  const rowsOf = (t: string) => (store[t] ??= []);
  for (const [t, rows] of Object.entries(seed)) store[t] = rows.map((r) => ({ ...(DEFAULTS[t] ?? {}), ...r }));
  const stmts: Stmt[] = []; const jobs: JobRec[] = [];
  const savepoints = new Map<string, { store: Record<string, Row[]>; jobs: number }>();
  const failures = (opts.failOn ?? []).map((f) => ({ ...f, left: f.times ?? Infinity }));

  const visible = (t: string) => rowsOf(t).filter((r) => !rls || r['tenant_id'] === undefined || r['tenant_id'] === tenant);

  function exec(textRaw: string, values: readonly unknown[]): Row[] {
    const text = norm(textRaw);
    for (const f of failures) if (f.left > 0 && f.match.test(text)) { f.left -= 1; throw f.error(); }
    if (/app\.enqueue_job/i.test(text)) {
      const m = /app\.enqueue_job\s*\(([\s\S]*)\)/i.exec(text); const args = splitTop(m?.[1] ?? '', /^,/);
      const raw = value(args[1] ?? '$2', values); const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      jobs.push({ identifier: String(value(args[0] ?? '$1', values)), payload, jobKey: (args[2] ? (value(args[2], values) as string | null) : null) ?? null,
        runAt: args[3] ? (/^\$/.test(stripCast(args[3])) ? value(args[3], values) : args[3]) : undefined, maxAttempts: args[4] ? value(args[4], values) : undefined, text });
      return [{ enqueue_job: null }];
    }
    const verb = (/^(select|insert|update|delete|with)\b/i.exec(text)?.[1] ?? 'other').toLowerCase();
    if (verb === 'with' || /\bjoin\b|\(\s*select\b|\bunnest\s*\(|\bcount\s*\(/i.test(text)) unsupported(text.slice(0, 90));
    const table = /\b(?:from|into|update)\s+((?:reporting|core|catalog|frontdesk|lab|billing|micro|anatomic)\.\w+)/i.exec(text)?.[1];
    if (!table) return [];
    if (verb === 'delete') {
      // C6-T16: DELETE stays "no grant" unless the test opts a table in (E tables only, 05-SCHEMA §6: purge_ephemeral under the system actor). WHERE is mandatory.
      if (!opts.allowDelete?.includes(table)) throw pgError('42501', 'permission denied: no DELETE grant');
      const where = /\bwhere\b([\s\S]*?)(?:\breturning\b[\s\S]*)?$/i.exec(text)?.[1];
      if (!where?.trim()) return unsupported('DELETE without WHERE');
      const rows = rowsOf(table); const hit = visible(table).filter((r) => evalWhere(r, where, values));
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return /\breturning\b/i.test(text) ? hit.map((r) => ({ ...r })) : [];
    }

    if (verb === 'select') {
      const where = /\bwhere\b([\s\S]*?)(?:\border\s+by\b|\bfor\s+update\b|\blimit\b|\bgroup\s+by\b|$)/i.exec(text)?.[1] ?? '';
      return visible(table).filter((r) => evalWhere(r, where, values)).map((r) => ({ ...r }));
    }
    if (verb === 'update') {
      const m = /\bset\b([\s\S]*?)\bwhere\b([\s\S]*?)(?:\breturning\b[\s\S]*)?$/i.exec(text);
      if (!m) return unsupported('UPDATE without WHERE');
      const hit = visible(table).filter((r) => evalWhere(r, m![2]!, values));
      for (const r of hit) applySet(r, m![1]!, values);
      return /\breturning\b/i.test(text) ? hit.map((r) => ({ ...r })) : [];
    }
    if (verb === 'insert') {
      const m = /into\s+[\w.]+\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b([\s\S]*?))?(?:\breturning\b[\s\S]*)?$/i.exec(text);
      if (!m) return unsupported('INSERT must be `INSERT INTO t (cols) VALUES (...)`');
      const cols = m[1]!.split(',').map((c) => c.trim()); const out: Row[] = [];
      for (const g of groups(m[2]!)) {
        const toks = splitTop(g, /^,/); const row: Row = { ...(DEFAULTS[table] ?? {}) };
        cols.forEach((c, i) => { const t = toks[i]!; if (/^default$/i.test(t)) return; row[c] = value(t, values); });
        if (rls && row['tenant_id'] !== undefined && row['tenant_id'] !== tenant) throw pgError('42501', 'new row violates row-level security policy');
        for (const [child, c, parent] of FKS) {
          if (child === table && !rowsOf(parent).some((p) => p['id'] === row[c] && p['tenant_id'] === row['tenant_id'])) throw pgError('23503', `fk ${child}.${c}`);
        }
        const dup = rowsOf(table).find((e) => (UNIQUE[table] ?? []).some((k) => k.every((c) => e[c] !== undefined && e[c] === row[c])));
        if (dup) {
          const oc = m[3]; if (!oc) throw pgError('23505', `duplicate key value violates unique constraint on ${table}`);
          if (/do\s+nothing/i.test(oc)) continue;
          const su = /do\s+update\s+set([\s\S]*?)(?:\bwhere\b([\s\S]*))?$/i.exec(oc);
          if (!su) return unsupported(`ON CONFLICT ${oc}`);
          if (!su[2] || evalWhere(dup, su[2], values)) applySet(dup, su[1]!, values, row);
          out.push({ ...dup });
        } else { rowsOf(table).push(row); out.push({ ...row }); }
      }
      return /\breturning\b/i.test(text) ? out : [];
    }
    return [];
  }

  const tx = {
    startedAt: new Date(NOW),
    async query(text: string, values: unknown[] = []) {
      const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase();
      stmts.push({ text: norm(text), values: [...values], verb });
      // Savepoints behave like Postgres: ROLLBACK TO restores rows + enqueued jobs in place (tests keep their `store` references). RELEASE is a no-op.
      const sp = /^\s*savepoint\s+(\w+)/i.exec(text);
      if (sp) { savepoints.set(sp[1]!.toLowerCase(), { store: structuredClone(store), jobs: jobs.length }); return { rows: [] }; }
      const rb = /^\s*rollback\s+to\s+savepoint\s+(\w+)/i.exec(text);
      if (rb) {
        const snap = savepoints.get(rb[1]!.toLowerCase());
        if (snap) {
          for (const t of Object.keys(store)) store[t]!.length = 0;
          for (const [t, rows] of Object.entries(snap.store)) (store[t] ??= []).push(...rows);
          jobs.length = snap.jobs;
        }
        return { rows: [] };
      }
      return { rows: exec(text, values) };
    },
    savepoint: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const all = (t: string) => rowsOf(t).map((r) => ({ ...r }));
  return {
    tx, stmts, jobs, store,
    all,
    reports: () => all('reporting.reports'), items: () => all('reporting.report_order_items'),
    narratives: () => all('reporting.narrative_reports'), nversions: () => all('reporting.narrative_versions'),
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(s.verb)),
    reportingStmts: () => stmts.filter((s) => /\breporting\./i.test(s.text)),
    /** Deep copy of the five tables the created/items_changed consumers write, for "nothing changed" comparisons. */
    snapshot: () => structuredClone({ r: store['reporting.reports'], i: store['reporting.report_order_items'], n: store['reporting.narrative_reports'], v: store['reporting.narrative_versions'] }),
  };
}
export type Db = ReturnType<typeof makeDb>;

// ------------------------------------------------------------------------------------------------ ports + ctx
const notFound = () => Object.assign(new Error('not found'), { code: 'common.not_found' });
export const WORKFLOW: Record<string, string> = { [TEST_CBC]: 'standard', [TEST_XRAY]: 'narrative', [TEST_OUT]: 'outsourced' };

export function orderSummary(over: Record<string, unknown> = {}, items?: any[]): any {
  return {
    orderId: ORDER, registrationNo: REG_NO, patientId: PATIENT, branchId: BRANCH, centreId: CENTRE, visitType: 'opd', billingMode: 'cash',
    referrerId: REFERRER, priority: 'routine', status: 'registered', source: 'front_desk', registeredAt: OCCURRED_AT, version: 1,
    items: items ?? [
      { orderItemId: ITEM_CBC, orderableId: ORDERABLE_CBC, orderableKind: 'test', testIds: [TEST_CBC], priority: 'routine', status: 'active', outsourced: false },
      { orderItemId: ITEM_XRAY, orderableId: ORDERABLE_XRAY, orderableKind: 'test', testIds: [TEST_XRAY], priority: 'routine', status: 'active', outsourced: false },
      { orderItemId: ITEM_OUT, orderableId: ORDERABLE_OUT, orderableKind: 'test', testIds: [TEST_OUT], priority: 'routine', status: 'active', outsourced: true },
    ],
    ...over,
  };
}

export function makePorts(o: { summary?: any; workflow?: Record<string, string> } = {}) {
  const calls = { getOrderSummary: [] as any[], getTest: [] as any[] };
  const workflow = o.workflow ?? WORKFLOW;
  const ports = {
    frontdesk: {
      async getOrderSummary(_ctx: unknown, input: { orderId: string }) {
        calls.getOrderSummary.push(input);
        if (!o.summary || input.orderId !== o.summary.orderId) throw notFound();
        return structuredClone(o.summary);
      },
    },
    catalog: {
      async getTest(_ctx: unknown, input: { testId: string }) {
        calls.getTest.push(input);
        const wf = workflow[input.testId]; if (!wf) throw notFound();
        return { id: input.testId, code: 'T' + input.testId.slice(-4), name: 'Synthetic test', departmentId: idN(0x5001), departmentCode: 'LAB', specimenTypeCodes: ['BLD'],
          workflowType: wf, analytes: [], isActive: true, revision: 1 };
      },
    },
  };
  return { ports, calls };
}

export function makeLog() {
  const lines: unknown[][] = []; const log: any = {};
  for (const l of ['debug', 'info', 'warn', 'error']) log[l] = (...a: unknown[]) => { lines.push(a); };
  log.child = () => log;
  const text = () => lines.map((a) => { try { return JSON.stringify(a, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : x)); } catch { return String(a); } }).join('\n');
  return { log, lines, text };
}

/** A JobContext (services/worker/src/core/manifest.ts) + `ports` ASSUMED to carry FrontdeskPort/CatalogPort, `core.centre` as core-repo's `centre()`. */
export function makeCtx(db: Db, o: { ports?: ReturnType<typeof makePorts>['ports']; tenantId?: string; logs?: ReturnType<typeof makeLog> } = {}) {
  const logs = o.logs ?? makeLog();
  const ctx: any = {
    tenantId: o.tenantId ?? TENANT_A, actor: { type: 'system', id: SYSTEM_ACTOR }, requestId: idN(0xf1), tx: db.tx,
    db: { tx: (fn: (c: unknown) => Promise<unknown>) => fn(ctx) },
    events: { publish: async () => ({ eventId: idN(1), duplicate: false }) },
    core: { async centre(_c: unknown, input: { centreId: string }) { return { id: input.centreId, branchId: BRANCH, centreCode: CENTRE_CODE, name: 'Synthetic centre', centreKind: 'own', isActive: true }; } },
    storage: {}, files: {}, audit: { access: async () => undefined }, log: logs.log, attempt: 1, maxAttempts: 10, jobId: '1',
    now: () => NOW, isNewer: (last: number | undefined, seq: number) => last === undefined || last === null || seq > last,
    ports: o.ports ?? makePorts().ports,
  };
  return { ctx, logs };
}

// ------------------------------------------------------------------------------------------------ event envelopes (03-IC §3 shapes)
let evSeq = 0x80000;
export const newEventId = () => idN(++evSeq);
export function envelope(type: string, producer: string, aggType: string, aggId: string, seq: number, payload: Record<string, unknown>, over: Record<string, unknown> = {}): any {
  return {
    event_id: newEventId(), event_type: type, tenant_id: TENANT_A, occurred_at: OCCURRED_AT, actor: { type: 'user', id: idN(0xa001) },
    idempotency_key: `${type}:${aggId}:${seq}`, producer, aggregate: { type: aggType, id: aggId, seq }, request_id: idN(0xf2), payload, ...over,
  };
}
const ITEM_EVT = (id: string, orderable: string, testId: string, outsourced?: boolean) =>
  ({ order_item_id: id, orderable_id: orderable, orderable_kind: 'test', test_ids: [testId], priority: 'routine', ...(outsourced === undefined ? {} : { outsourced }) });
export const THREE_ITEMS = () => [ITEM_EVT(ITEM_CBC, ORDERABLE_CBC, TEST_CBC), ITEM_EVT(ITEM_XRAY, ORDERABLE_XRAY, TEST_XRAY), ITEM_EVT(ITEM_OUT, ORDERABLE_OUT, TEST_OUT, true)];

export const orderCreated = (payloadOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => envelope('frontdesk.order.created.v1', 'frontdesk', 'order', ORDER, 1, {
  order_id: ORDER, patient_id: PATIENT, branch_id: BRANCH, centre_id: CENTRE, visit_type: 'opd', billing_mode: 'cash', referrer_id: REFERRER, priority: 'routine',
  collection_mode: 'walk_in', source: 'front_desk', registered_at: OCCURRED_AT, items: THREE_ITEMS(), ...payloadOver }, over);
export const itemsChanged = (payloadOver: Record<string, unknown> = {}, seq = 2, over: Record<string, unknown> = {}) => envelope('frontdesk.order.items_changed.v1', 'frontdesk', 'order', ORDER, seq, {
  order_id: ORDER, items_version: 2, added: [], removed: [{ order_item_id: ITEM_OUT, reason_code: 'patient_request' }], changed_at: OCCURRED_AT, ...payloadOver }, over);
export const orderCancelled = (over: Record<string, unknown> = {}) => envelope('frontdesk.order.cancelled.v1', 'frontdesk', 'order', ORDER, 3,
  { order_id: ORDER, reason_code: 'patient_request', cancelled_at: OCCURRED_AT, requires_credit_note: false }, over);
export const resultApproved = (itemId = ITEM_CBC, over: Record<string, unknown> = {}) => envelope('lab.result.approved.v1', 'lab', 'result', idN(0x6001), 1, {
  result_id: idN(0x6001), result_version_no: 1, order_id: ORDER, order_item_id: itemId, test_id: TEST_CBC, analyte_id: idN(0x7001), department_id: idN(0x5001),
  approved_at: OCCURRED_AT, approved_by_membership_id: idN(0x3001) }, over);
export const resultAmended = (itemId = ITEM_CBC, over: Record<string, unknown> = {}) => envelope('lab.result.amended.v1', 'lab', 'result', idN(0x6001), 2, {
  result_id: idN(0x6001), previous_version_no: 1, new_version_no: 2, order_id: ORDER, order_item_id: itemId, test_id: TEST_CBC, analyte_id: idN(0x7001),
  amendment_reason_code: 'typo', amended_at: OCCURRED_AT, amended_by_membership_id: idN(0x3001) }, over);
export const specimenStatus = (toStatus: string, seq: number, itemIds: string[] | undefined = [ITEM_CBC], over: Record<string, unknown> = {}) =>
  envelope('lab.specimen.status_changed.v1', 'lab', 'specimen', idN(0x8001), seq, {
    specimen_id: idN(0x8001), order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, specimen_type_code: 'BLD', to_status: toStatus, changed_at: OCCURRED_AT,
    ...(itemIds ? { order_item_ids: itemIds } : {}) }, over);
export const HASH_1 = 'a'.repeat(64); export const HASH_2 = 'b'.repeat(64);
export const readyForReport = (seq: number, itemIds: string[] = [ITEM_CBC], payloadOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  envelope('lab.order.ready_for_report.v1', 'lab', 'order', ORDER, seq, {
    order_id: ORDER, completeness: 'complete', order_item_ids: itemIds, approved_set_hash: HASH_1, contains_amendment: false, ready_at: OCCURRED_AT, ...payloadOver }, over);
export const catalogChanged = (entityType = 'test', over: Record<string, unknown> = {}) => envelope('catalog.changed.v1', 'catalog', 'catalog', idN(0x9001), 5,
  { catalog_revision: 5, entity_type: entityType, entity_id: TEST_CBC, change_kind: 'updated', effective_from: OCCURRED_AT }, over);

/** Seed a report shell with the three items of the AC-01.1 order (what the created consumer produces), for the follow-up events. */
export function seededShell(extraSeed: Seed = {}, opts: DbOpts = {}) {
  const LAB = idN(0xa101); const NAR = idN(0xa102);
  const base = { tenant_id: TENANT_A, centre_id: CENTRE, order_id: ORDER, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR };
  const item = (n: number, report: string, orderItem: string, flags: [boolean, boolean, boolean], extra: Row = {}) => ({
    ...base, id: idN(0xb100 + n), report_id: report, order_item_id: orderItem, orderable_id: idN(0x2000 + n), orderable_kind: 'test', test_ids: [idN(0x3000 + n)], priority: 'routine',
    requires_lab: flags[0], requires_narrative: flags[1], requires_outsourced: flags[2], ...extra });
  const db = makeDb({
    'reporting.reports': [
      { ...base, id: LAB, branch_id: BRANCH, patient_id: PATIENT, family: 'laboratory', order_source: 'front_desk', registered_at: OCCURRED_AT, registration_no: REG_NO, centre_code: CENTRE_CODE },
      { ...base, id: NAR, branch_id: BRANCH, patient_id: PATIENT, family: 'narrative', order_source: 'front_desk', registered_at: OCCURRED_AT, registration_no: REG_NO, centre_code: CENTRE_CODE },
    ],
    'reporting.report_order_items': [
      item(1, LAB, ITEM_CBC, [true, false, false], { items_version: 1 }), item(2, NAR, ITEM_XRAY, [false, true, false], { narrative_test_ids: [TEST_XRAY], items_version: 1 }),
      item(3, LAB, ITEM_OUT, [false, false, true], { items_version: 1 }),
    ],
    ...extraSeed,
  }, opts);
  return { db, LAB, NAR };
}
