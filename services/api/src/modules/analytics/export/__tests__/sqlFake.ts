// AN-T15 test helper (not a test file). Synthetic data only. An in-memory emulator of analytics.exports / analytics.export_files / app.enqueue_job that
// classifies statements by their TEXT (02-TRD §10, 05-SCHEMA §exports) and applies the spec'd effect to plain JS data. It never runs SQL.
// Shared by the API handler tests (user tx, RLS own-only) and the worker build tests (system actor, no RLS).
//
// SEAMS the writer must honour (pinned here; dispute through the reviewer):
//   * INSERT INTO analytics.exports | analytics.export_files uses the form  (col, ...) VALUES (expr, ...)  with $n / 'literal' / number / now() / NULL.
//   * UPDATE analytics.exports SET col = expr, ...  WHERE ...  with expr = $n | 'lit' | number | NULL | now() | now() + interval 'N hours|days' | col + 1 | col.
//       Download counter (TRD §10.3): `SET downloads_used = downloads_used + 1 ... WHERE ... downloads_used < downloads_allowed AND status = 'ready' [AND expires_at > ...] RETURNING ...`
//       is applied ATOMICALLY with exactly the guards the TEXT contains (0 rows when a guard fails). A writer that omits a guard must check it in code.
//   * Quota (TRD §10.1 step 5): two statements `SELECT count(*) ... FROM analytics.exports WHERE ... requested_by_membership_id ... requested_at > ...` (user, rolling hour)
//       and `... requested_on ...` (tenant, business day). The row carries the aliases count|n|cnt|total and (oldest|min|oldest_at|oldest_requested_at) = earliest requested_at in the window.
//   * Any other SELECT ... FROM analytics.exports returns FULL rows (snake_case columns of 05-SCHEMA; bigint columns as strings like node-pg), newest first.
import { uuidv7 } from '../../../../../../../packages/shared-ts/src/uuidv7/index.js';

export const HOUR = 3_600_000;
export const DAY_MS = 86_400_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const localDate = (iso: string): string => new Date(Date.parse(iso) + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10);

export interface ExportRow {
  id: string; tenant_id: string; requested_by_membership_id: string; report_code: string; format: string; params: unknown;
  scope_all_centres: boolean; scope_centre_ids: string[]; scope_effective_centre_ids?: string[] | null;
  status: string; requested_at: Date; requested_on: string; building_started_at: Date | null; ready_at: Date | null; expires_at: Date | null;
  row_count: string | null; size_bytes: string | null; sha256: string | null; downloads_allowed: number; downloads_used: number; failure_code: string | null;
  version: number; created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null;
}
export interface FileRow { tenant_id: string; export_id: string; content: Buffer; content_type: string; sha256: string; created_at: Date; created_by: string; expires_at: Date }
export interface Stmt { text: string; values: unknown[]; txId: string }
export interface Who { tenant: string; txId?: string; /** user tx: RLS own rows only */ membership?: string }

export function balanced(text: string, open: number): string {
  let depth = 0, q = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('sqlFake: unbalanced parentheses');
}
export function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (const c of s) {
    if (c === "'") q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') depth--;
    if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export class ExportsDb {
  exports = new Map<string, ExportRow>();
  files = new Map<string, FileRow>();            // key `${tenant}|${export_id}`
  jobs: { identifier: string; payload: any; jobKey: unknown }[] = [];
  log: Stmt[] = [];
  events: string[] = [];                         // 'insert:exports' | 'enqueue' | 'audit:<phase>' ... in order
  other: string[] = [];
  clock = { now: '2026-11-06T06:00:00.000Z' };
  failOn: ((text: string) => unknown) | undefined;

  reset(now = '2026-11-06T06:00:00.000Z'): void {
    this.exports.clear(); this.files.clear(); this.jobs.length = 0; this.log.length = 0; this.events.length = 0; this.other.length = 0; this.clock.now = now; this.failOn = undefined;
  }
  advance(ms: number): void { this.clock.now = new Date(Date.parse(this.clock.now) + ms).toISOString(); }

  seed(o: Partial<ExportRow> & { id: string; tenant_id: string; requested_by_membership_id: string }): ExportRow {
    const at = o.requested_at ?? new Date(this.clock.now);
    const row: ExportRow = {
      report_code: 'income', format: 'csv', params: { business_date_from: '2026-11-05', business_date_to: '2026-11-06' }, scope_all_centres: true, scope_centre_ids: [],
      status: 'queued', requested_at: at, requested_on: localDate(at.toISOString()), building_started_at: null, ready_at: null, expires_at: null,
      row_count: null, size_bytes: null, sha256: null, downloads_allowed: 3, downloads_used: 0, failure_code: null, version: 1,
      created_at: at, created_by: o.requested_by_membership_id, updated_at: at, updated_by: o.requested_by_membership_id, ...o,
    };
    this.exports.set(row.id, row);
    return row;
  }
  seedFile(tenant: string, exportId: string, content: Buffer, contentType: string, sha256: string, expires: Date): FileRow {
    const f: FileRow = { tenant_id: tenant, export_id: exportId, content, content_type: contentType, sha256, created_at: new Date(this.clock.now), created_by: 'seed', expires_at: expires };
    this.files.set(`${tenant}|${exportId}`, f);
    return f;
  }
  mine(tenant: string): ExportRow[] { return [...this.exports.values()].filter((r) => r.tenant_id === tenant); }

  private evalExpr(expr: string, values: unknown[], row?: Record<string, any>): unknown {
    const e = expr.trim();
    let m = /^\(?\s*\$(\d+)\s*\)?(::[\w\[\]]+)?$/.exec(e);
    if (m) return values[Number(m[1]) - 1];
    if (/^NULL$/i.test(e)) return null;
    if (/^-?\d+$/.test(e)) return Number(e);
    if ((m = /^'((?:[^']|'')*)'(::[\w\[\]]+)?$/.exec(e))) return m[1]!.replace(/''/g, "'");
    if (/^now\(\)$/i.test(e) || /^clock_timestamp\(\)$/i.test(e)) return new Date(this.clock.now);
    if ((m = /^now\(\)\s*\+\s*interval\s+'(\d+)\s*(hours?|days?|minutes?)'$/i.exec(e))) {
      const unit = m[2]!.toLowerCase().startsWith('h') ? HOUR : m[2]!.toLowerCase().startsWith('d') ? DAY_MS : 60_000;
      return new Date(Date.parse(this.clock.now) + Number(m[1]) * unit);
    }
    if (row && (m = /^(\w+)\s*\+\s*1$/.exec(e))) return Number(row[m[1]!]) + 1;
    if (row && /^\w+$/.test(e) && e in row) return row[e];
    return e;                                   // unknown expression kept verbatim (tests that care use a form listed in the header)
  }

  /** One statement. `who.membership` set = a user transaction under RLS (own exports / own files only). */
  async exec(text: string, values: unknown[] = [], who: Who): Promise<{ rows: any[]; rowCount: number }> {
    this.log.push({ text, values, txId: who.txId ?? 'main' });
    if (this.failOn) { const e = this.failOn(text); if (e) throw e; }
    await Promise.resolve();                     // one yield per statement: read-then-write races interleave exactly as with two connections
    const own = (r: { tenant_id: string; requested_by_membership_id?: string }) => r.tenant_id === who.tenant && (!who.membership || r.requested_by_membership_id === who.membership);

    if (/app\.enqueue_job/i.test(text)) {
      let payload: any = values[1]; try { payload = JSON.parse(String(values[1])); } catch { /* keep raw */ }
      this.jobs.push({ identifier: String(values[0]), payload, jobKey: values[2] });
      this.events.push('enqueue');
      return { rows: [], rowCount: 1 };
    }

    let m = /^\s*INSERT\s+INTO\s+analytics\.(exports|export_files)\s*\(([^)]*)\)\s*VALUES\s*/i.exec(text);
    if (m) {
      const cols = m[2]!.split(',').map((c) => c.trim());
      const exprs = splitTop(balanced(text, m[0].length));
      if (exprs.length !== cols.length) throw new Error(`sqlFake: ${cols.length} columns but ${exprs.length} VALUES in: ${text}`);
      const rec: Record<string, any> = {};
      cols.forEach((c, i) => { rec[c] = this.evalExpr(exprs[i]!, values); });
      if (rec.tenant_id !== who.tenant) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
      if (m[1] === 'exports') {
        if (typeof rec.id !== 'string' || !UUID_RE.test(rec.id)) throw new Error('sqlFake: analytics.exports INSERT must supply id (uuidv7)');
        const at = new Date(this.clock.now);
        const row = { ...this.seed({ id: rec.id, tenant_id: rec.tenant_id, requested_by_membership_id: rec.requested_by_membership_id }), ...rec } as ExportRow;
        row.params = typeof rec.params === 'string' ? JSON.parse(rec.params) : rec.params;
        row.requested_at = at; row.requested_on = localDate(at.toISOString());
        this.exports.set(row.id, row);
        this.events.push('insert:exports');
        return { rows: [{ ...row }], rowCount: 1 };
      }
      const key = `${rec.tenant_id}|${rec.export_id}`;
      if (this.files.has(key)) throw Object.assign(new Error('duplicate key value violates unique constraint "export_files__pk"'), { code: '23505' });
      this.files.set(key, { created_at: new Date(this.clock.now), ...rec } as FileRow);
      this.events.push('insert:export_files');
      return { rows: [], rowCount: 1 };
    }

    if ((m = /^\s*UPDATE\s+analytics\.exports\s+(?:\w+\s+)?SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?)(\s+RETURNING[\s\S]*)?$/i.exec(text))) {
      const where = m[2]!;
      const row = [...this.exports.values()].find((r) => own(r) && values.includes(r.id));
      if (!row) return { rows: [], rowCount: 0 };
      const now = Date.parse(this.clock.now);
      if (/status\s*=\s*'ready'/i.test(where) && row.status !== 'ready') return { rows: [], rowCount: 0 };
      if (/downloads_used\s*<\s*downloads_allowed/i.test(where) && row.downloads_used >= row.downloads_allowed) return { rows: [], rowCount: 0 };
      if (/expires_at\s*>/i.test(where) && !(row.expires_at && row.expires_at.getTime() > now)) return { rows: [], rowCount: 0 };
      const snapshot = { ...row };
      for (const a of splitTop(m[1]!)) {
        const kv = /^(\w+)\s*=\s*([\s\S]+)$/.exec(a);
        if (!kv) continue;
        let v = this.evalExpr(kv[2]!, values, snapshot);
        if (kv[1] === 'params' && typeof v === 'string') v = JSON.parse(v);
        (row as any)[kv[1]!] = v;
      }
      this.events.push(`update:exports:${row.status}`);
      return { rows: m[3] ? [{ ...row }] : [], rowCount: 1 };
    }

    if (/^\s*SELECT[\s\S]*\bFROM\s+analytics\.exports\b/i.test(text) && /\b(count|min)\s*\(/i.test(text)) {
      const mine = [...this.exports.values()].filter((r) => r.tenant_id === who.tenant);
      let win: ExportRow[];
      if (/requested_by_membership_id/i.test(text)) {
        const membership = values.find((v) => typeof v === 'string' && v !== who.tenant && UUID_RE.test(v));
        const since = Date.parse(this.clock.now) - HOUR;
        win = mine.filter((r) => r.requested_by_membership_id === membership && r.requested_at.getTime() > since);
      } else if (/requested_on/i.test(text)) {
        const day = (values.find((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) as string | undefined) ?? localDate(this.clock.now);
        win = mine.filter((r) => r.requested_on === day);
      } else throw new Error(`sqlFake: unrecognised quota statement: ${text}`);
      const oldest = win.length ? new Date(Math.min(...win.map((r) => r.requested_at.getTime()))) : null;
      const n = win.length;
      return { rows: [{ count: String(n), n, cnt: n, total: n, oldest, min: oldest, oldest_at: oldest, oldest_requested_at: oldest }], rowCount: 1 };
    }

    if (/^\s*SELECT[\s\S]*\bFROM\s+analytics\.exports\b/i.test(text)) {
      let rows = [...this.exports.values()].filter(own);
      const idm = /\b(?:\w+\.)?id\s*=\s*\$(\d+)/i.exec(text);
      if (idm) rows = rows.filter((r) => r.id === values[Number(idm[1]) - 1]);
      const statuses = values.find((v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && !UUID_RE.test(x)));
      if (statuses && /status/i.test(text)) rows = rows.filter((r) => statuses.includes(r.status));
      rows.sort((a, b) => b.requested_at.getTime() - a.requested_at.getTime() || b.id.localeCompare(a.id));
      const lim = /LIMIT\s+(?:\$(\d+)|(\d+))/i.exec(text);
      if (lim) rows = rows.slice(0, lim[1] ? Number(values[Number(lim[1]) - 1]) : Number(lim[2]));
      return { rows: rows.map((r) => ({ ...r, row_count: r.row_count === null ? null : String(r.row_count), size_bytes: r.size_bytes === null ? null : String(r.size_bytes) })), rowCount: rows.length };
    }

    if (/^\s*SELECT[\s\S]*\bFROM\s+analytics\.export_files\b/i.test(text)) {
      const id = values.find((v) => typeof v === 'string' && UUID_RE.test(v) && v !== who.tenant);
      const f = this.files.get(`${who.tenant}|${id}`);
      const parent = f && this.exports.get(f.export_id);
      return f && parent && own(parent) ? { rows: [{ ...f }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    this.other.push(text);
    return { rows: [], rowCount: 0 };
  }
}

export const newExportId = (): string => uuidv7();
export const iso = (d: unknown): string | null => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString());
