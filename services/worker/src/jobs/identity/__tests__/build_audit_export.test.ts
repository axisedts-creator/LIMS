// C2-T19 worker task identity.build_audit_export (02-TRD §8 row; 03-APP-FLOW §2.7, §7.2; 01-PRD AC-D4.2, AC-D4.6; 07-SECURITY A-13, D-T4, P-3, P-4; 08 A13 P-9).
// ASSUMED seams (spec silent; writer: dispute if wrong):
//  - ../tasks/build_audit_export.ts exports `BUILD_AUDIT_EXPORT = 'identity.build_audit_export'` and `buildAuditExport: TaskHandler` = (payload{tenant_id, export_id}, ctx: JobContext).
//  - SQL on ctx.tx.query(text, values) -> {rows, rowCount?}. The fake below recognises statements by CONTENT: SELECT … FROM identity.audit_exports (the job row),
//    UPDATE identity.audit_exports (status changes), SELECT … FROM audit.audit_log | audit.access_log | identity.auth_events (source rows, with LIMIT n | LIMIT $n),
//    `count(` selects. It models RLS as OFF: a source statement whose params do not carry the tenant id returns ALL tenants' rows; params without the export's range
//    (range_from AND range_to as ISO string or Date) are not range-filtered; a filter whose value is not a param is not applied. So a missing predicate = visible leak.
//  - Source batches: ORDER BY + LIMIT <= 5000 and no OFFSET. Source rows come back with DB column names: audit_log{id,occurred_at,schema_name,table_name,action,row_id,
//    actor_type,actor_id,membership_id,actor_display_name|display_name,centre_id,request_id,support_session_id,changed_columns,old_values,new_values};
//    access_log{id,occurred_at,action,entity_type,entity_id,…}; auth_events{id,occurred_at,event_type,membership_id,actor_display_name,reason_code,client_ip,user_agent}.
//  - ctx.storage.put(bucket, path, bytes, {contentType, ifAbsent?}) -> {sha256 hex, byteSize}; bucket `identity-exports`, path `{tenant_id}/{yyyy}/{mm}/{export_id}.csv`.
//  - ready UPDATE carries (as params) object_path, sha256 (Buffer or hex), size_bytes, row_count, ready_at, expires_at = ctx.now() + 24 h (Date or ISO).
//  - CSV columns = 03-APP-FLOW §7.2 verbatim; action lower-case (`update`); access_log `event_type` = the row's action; auth_events `user_agent_family` (never the raw UA).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { neutraliseFormula, restoreNeutralised } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { BUILD_AUDIT_EXPORT, buildAuditExport } from '../tasks/build_audit_export.js';

const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1), EXPORT_ID = idN(0x1001), MEM = idN(0xd2), USER = idN(0xd1);
const NOW_ISO = '2026-11-08T06:00:00.000Z';
const FROM = '2026-10-01T00:00:00.000Z', TO = '2026-10-31T00:00:00.000Z';
const OLD_SENTINEL = 'PHI-OLD-VALUE-8842', NEW_SENTINEL = 'PHI-NEW-VALUE-9931', UA_TAIL = 'SECRET-UA-TAIL-77';

type Row = Record<string, any>;
const at = (day: number, min = 0) => new Date(Date.UTC(2026, 9, day, 0, min, 0));
const auditRow = (n: number, o: Row = {}): Row => ({
  id: idN(0x2000 + n), audit_id: idN(0x2000 + n), tenant_id: TENANT_A, occurred_at: at(2, n % 50), schema_name: 'core', table_name: 'roles', table: 'core.roles', action: 'UPDATE',
  row_id: idN(0x3000 + n), actor_type: 'user', actor_id: USER, membership_id: MEM, actor_display_name: `Actor ${n}`, display_name: `Actor ${n}`, centre_id: null,
  request_id: idN(0x4000 + n), support_session_id: null, changed_columns: ['display_name'], old_values: { display_name: `${OLD_SENTINEL}-${n}` }, new_values: { display_name: `${NEW_SENTINEL}-${n}` }, ...o,
});
const accessRow = (n: number, o: Row = {}): Row => ({
  id: idN(0x5000 + n), access_id: idN(0x5000 + n), tenant_id: TENANT_A, occurred_at: at(2, n % 50), action: 'audit_entry.view', entity_type: 'audit_entry', entity_id: idN(0x2000 + n),
  actor_type: 'user', actor_id: USER, membership_id: MEM, actor_display_name: `Actor ${n}`, display_name: `Actor ${n}`, centre_id: null, request_id: idN(0x6000 + n),
  support_session_id: null, outcome: 'allowed', detail: { k: OLD_SENTINEL }, ...o,
});
const authRow = (n: number, o: Row = {}): Row => ({
  id: idN(0x7000 + n), event_id: idN(0x7000 + n), tenant_id: TENANT_A, occurred_at: at(2, n % 50), event_type: 'login_failed', membership_id: MEM, actor_display_name: `Actor ${n}`, display_name: `Actor ${n}`,
  reason_code: 'bad_password', client_ip: '10.0.0.5', user_agent: `Mozilla/5.0 (X11; Linux) Gecko ${UA_TAIL}`, ...o,
});

interface Src { length: number; slice(a: number, b: number): Row[] }
interface JobOpts {
  source?: 'audit_log' | 'access_log' | 'auth_events'; rows?: Row[]; bulk?: number; exportRow?: Row; putFails?: boolean; existingObject?: boolean;
}
const SOURCE_TABLE: Record<string, RegExp> = { audit_log: /\bFROM\s+audit\.audit_log\b/i, access_log: /\bFROM\s+audit\.access_log\b/i, auth_events: /\bFROM\s+identity\.auth_events\b/i };

function makeJob(o: JobOpts = {}) {
  const source = o.source ?? 'audit_log';
  const job: Row = {
    id: EXPORT_ID, tenant_id: TENANT_A, requested_by_membership_id: MEM, source, filters: {}, range_from: new Date(FROM), range_to: new Date(TO), status: 'queued', row_count: null,
    object_path: null, sha256: null, size_bytes: null, downloads_remaining: 3, ready_at: null, expires_at: null, last_downloaded_at: null, error_code: null, version: 1,
    created_at: new Date('2026-11-08T05:00:00.000Z'), created_by: USER, updated_at: new Date('2026-11-08T05:00:00.000Z'), updated_by: USER, ...(o.exportRow ?? {}),
  };
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const updates: Array<{ text: string; values: unknown[]; status?: string }> = [];
  const sourceSelects: Array<{ text: string; values: unknown[]; limit?: number }> = [];
  const puts: Array<{ bucket: string; path: string; bytes: Uint8Array; opts: any }> = [];
  const logs: unknown[] = [];
  const metrics: unknown[][] = [];
  const store = new Map<string, Uint8Array>(o.existingObject ? [[`${TENANT_A}/2026/11/${EXPORT_ID}.csv`, new Uint8Array([1])]] : []);
  let served = 0, pointer = 0;
  const all: Row[] = o.rows ?? [];

  const has = (values: unknown[], v: unknown) => values.some((x) => x === v || (x instanceof Date && typeof v === 'string' && x.toISOString() === v) || (typeof x === 'string' && v instanceof Date && x === v.toISOString())
    || (x instanceof Date && v instanceof Date && x.getTime() === v.getTime()) || (typeof x === 'string' && typeof v === 'string' && Date.parse(x) === Date.parse(v) && /^\d{4}-/.test(v) && !Number.isNaN(Date.parse(v))));
  const view = (values: unknown[]): Src => {
    if (o.bulk !== undefined) {
      const n = o.bulk;
      return { length: n, slice: (a, b) => { const out: Row[] = []; for (let i = a; i < Math.min(b, n); i++) out.push(source === 'audit_log' ? auditRow(i) : source === 'access_log' ? accessRow(i) : authRow(i)); return out; } };
    }
    let rows = all;
    if (has(values, TENANT_A) || has(values, job.tenant_id)) rows = rows.filter((r) => r.tenant_id === job.tenant_id);
    if (has(values, job.range_from) && has(values, job.range_to)) rows = rows.filter((r) => r.occurred_at >= job.range_from && r.occurred_at < job.range_to);
    for (const [k, v] of Object.entries(job.filters as Record<string, string>)) {
      const col = (r: Row) => (k === 'table' ? `${r.schema_name}.${r.table_name}` : r[k]);
      if (has(values, v) || (k === 'table' && has(values, String(v).split('.')[1]))) rows = rows.filter((r) => col(r) === v);
    }
    return { length: rows.length, slice: (a, b) => rows.slice(a, b) };
  };

  const tx = {
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values });
      const t = text.replace(/\s+/g, ' ').trim();
      // RLS OFF: a lookup that names the id but no tenant sees the row whatever its tenant (the task must then check row.tenant_id itself)
      const seesJob = values.includes(job.id) && (values.includes(job.tenant_id) || !values.some((v) => v === TENANT_A || v === TENANT_B));
      if (/^SELECT/i.test(t) && /\bidentity\.audit_exports\b/i.test(t)) {
        return { rows: seesJob ? [{ ...job }] : [], rowCount: seesJob ? 1 : 0 };
      }
      if (/^UPDATE\s+identity\.audit_exports\b/i.test(t)) {
        const status = /\bstatus\s*=\s*'(\w+)'/i.exec(t.replace(/WHERE.*$/i, ''))?.[1] ?? (values.find((v) => ['building', 'ready', 'failed'].includes(v as string)) as string | undefined);
        const hit = seesJob;
        updates.push({ text, values, ...(status ? { status } : {}) });
        if (hit && status) { job.status = status; job.version += 1; }
        return { rows: hit ? [{ ...job }] : [], rowCount: hit ? 1 : 0 };
      }
      for (const [src, re] of Object.entries(SOURCE_TABLE)) {
        if (src !== source || !re.test(t) || !/^(SELECT|WITH)/i.test(t)) continue;
        if (/\bcount\s*\(/i.test(t)) { const n = view(values).length; return { rows: [{ count: String(n), n, c: n, total: n, row_count: n }], rowCount: 1 }; }
        const m = /\bLIMIT\s+(\d+|\$(\d+))/i.exec(t);
        const limit = m ? (m[2] ? Number(values[Number(m[2]) - 1]) : Number(m[1])) : undefined;
        sourceSelects.push({ text: t, values, ...(limit !== undefined ? { limit } : {}) });
        const v = view(values);
        const take = limit ?? v.length;
        const rows = v.slice(pointer, pointer + take);
        pointer += rows.length; served += rows.length;
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const log = { info: (x: unknown) => logs.push(x), warn: (x: unknown) => logs.push(x), error: (x: unknown) => logs.push(x), debug: (x: unknown) => logs.push(x), child() { return this; } };
  const ctx: any = {
    tenantId: TENANT_A, tx, actor: { type: 'system', id: idN(0xa009) }, requestId: 'r', attempt: 1, maxAttempts: 5, jobId: '1', now: () => NOW_ISO, isNewer: () => true,
    events: {}, core: {}, files: {}, audit: { access: async () => {} }, log, metrics: { inc: (...a: unknown[]) => { metrics.push(a); }, set() {}, observe() {} },
    storage: {
      async put(bucket: string, path: string, bytes: Uint8Array, opts: any) {
        if (o.putFails) throw new Error('storage unavailable');
        if (opts?.ifAbsent && store.has(path)) throw new Error('exists');
        puts.push({ bucket, path, bytes, opts }); store.set(path, bytes);
        return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
      },
    },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  const run = (payload: Row = { tenant_id: TENANT_A, export_id: EXPORT_ID }, c: any = ctx) => buildAuditExport(payload as any, c);
  const csv = () => new TextDecoder().decode(puts[0]!.bytes);
  return { ctx, tx, job, stmts, updates, sourceSelects, puts, logs, metrics, run, csv, served: () => served };
}

/** RFC 4180 parser: quoted fields with doubled quotes, CRLF or LF row ends; strips a UTF-8 BOM. Throws on a stray quote / unterminated field. */
function parseCsv(text: string): string[][] {
  const s = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = []; let row: string[] = []; let f = ''; let i = 0; let q = false; let fresh = true;
  while (i < s.length) {
    const c = s[i]!;
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; if (!(i >= s.length || s[i] === ',' || s[i] === '\r' || s[i] === '\n')) throw new Error('garbage after closing quote'); continue; }
      f += c; i++; continue;
    }
    if (c === '"') { if (!fresh) throw new Error('quote inside an unquoted field'); q = true; fresh = false; i++; continue; }
    if (c === ',') { row.push(f); f = ''; fresh = true; i++; continue; }
    if (c === '\r' || c === '\n') { row.push(f); rows.push(row); row = []; f = ''; fresh = true; i += c === '\r' && s[i + 1] === '\n' ? 2 : 1; continue; }
    f += c; fresh = false; i++;
  }
  if (q) throw new Error('unterminated quoted field');
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const table = (csv: string) => { const [h, ...r] = parseCsv(csv); return { header: h!, rows: r.map((x) => Object.fromEntries(h!.map((k, i) => [k, x[i] ?? '']))) as Record<string, string>[], raw: r }; };

const HEADERS = {
  audit_log: ['audit_id', 'occurred_at_utc', 'occurred_at_local', 'table', 'action', 'row_id', 'actor_type', 'actor_id', 'membership_id', 'actor_display_name', 'centre_id', 'request_id', 'support_session_id', 'changed_columns'],
  access_log: ['access_id', 'occurred_at_utc', 'occurred_at_local', 'event_type', 'entity_type', 'entity_id', 'actor_type', 'actor_id', 'membership_id', 'actor_display_name', 'centre_id', 'request_id', 'support_session_id'],
  auth_events: ['event_id', 'occurred_at_utc', 'occurred_at_local', 'event_type', 'membership_id', 'actor_display_name', 'reason_code', 'client_ip', 'user_agent_family'],
} as const;

describe('contract of the task module', () => {
  it('task identifier is identity.build_audit_export', () => { expect(BUILD_AUDIT_EXPORT).toBe('identity.build_audit_export'); expect(typeof buildAuditExport).toBe('function'); });
});

describe('happy path (AC-D4.2): queued -> building -> ready', () => {
  it.each(['audit_log', 'access_log', 'auth_events'] as const)('%s: header = spec columns, one row per source row, in the identity-exports bucket under the tenant prefix', async (source) => {
    const mk = { audit_log: auditRow, access_log: accessRow, auth_events: authRow }[source];
    const j = makeJob({ source, rows: [mk(1), mk(2), mk(3)] }); await j.run();
    expect(j.puts).toHaveLength(1);
    expect(j.puts[0]!.bucket).toBe('identity-exports');
    expect(j.puts[0]!.path).toBe(`${TENANT_A}/2026/11/${EXPORT_ID}.csv`);
    expect(j.puts[0]!.opts.contentType).toBe('text/csv');
    const t = table(j.csv());
    expect(t.header).toEqual([...HEADERS[source]]);
    expect(t.rows).toHaveLength(3);
    expect(new Set(t.rows.map((r) => r[HEADERS[source][0]]))).toEqual(new Set([1, 2, 3].map((n) => mk(n).id)));
    for (const r of t.rows) { expect(r['occurred_at_local']).not.toBe(''); expect(r['occurred_at_utc']).toMatch(/^2026-10-02T00:\d\d:00(\.000)?Z$/); }
    expect(j.job.status).toBe('ready');
  });
  it('status goes building then ready (each UPDATE names tenant_id and the export id); no other status', async () => {
    const j = makeJob({ rows: [auditRow(1)] }); await j.run();
    expect(j.updates.map((u) => u.status)).toEqual(['building', 'ready']);
    for (const u of j.updates) { expect(u.text).toMatch(/\btenant_id\s*=\s*\$\d/i); expect(u.values).toContain(EXPORT_ID); expect(u.values).toContain(TENANT_A); }
  });
  it('the ready update stores object_path, sha256, size_bytes, row_count, ready_at and expires_at = now + 24 h', async () => {
    const j = makeJob({ rows: [auditRow(1), auditRow(2)] }); await j.run();
    const bytes = j.puts[0]!.bytes; const digest = createHash('sha256').update(bytes).digest();
    const v = j.updates.find((u) => u.status === 'ready')!.values;
    const same = (x: unknown, iso: string) => (x instanceof Date ? x.toISOString() : x) === iso;
    expect(v).toContain(j.puts[0]!.path);
    expect(v.some((x) => (Buffer.isBuffer(x) && x.equals(digest)) || x === digest.toString('hex'))).toBe(true);
    expect(v).toContain(bytes.length);
    expect(v).toContain(2);
    expect(v.some((x) => same(x, NOW_ISO))).toBe(true);
    expect(v.some((x) => same(x, '2026-11-09T06:00:00.000Z'))).toBe(true);
  });
  it('empty result -> ready with a header-only file and row_count 0', async () => {
    const j = makeJob({ rows: [] }); await j.run();
    expect(table(j.csv()).rows).toHaveLength(0); expect(table(j.csv()).header).toEqual([...HEADERS.audit_log]);
    expect(j.updates.find((u) => u.status === 'ready')!.values).toContain(0);
  });
});

describe('metadata only - no values (07-SECURITY threat 5; 08 A3.3)', () => {
  it('audit_log: old_values / new_values never appear in the file, and there is no such column', async () => {
    const j = makeJob({ rows: [auditRow(1), auditRow(2)] }); await j.run();
    const text = j.csv();
    expect(text).not.toContain(OLD_SENTINEL); expect(text).not.toContain(NEW_SENTINEL);
    expect(table(text).header.join(',')).not.toMatch(/old|new|value|detail/i);
    expect(j.sourceSelects.every((s) => !/old_values|new_values/i.test(s.text))).toBe(true);
  });
  it('access_log detail and the raw auth user agent are not exported (only user_agent_family)', async () => {
    const a = makeJob({ source: 'access_log', rows: [accessRow(1)] }); await a.run(); expect(a.csv()).not.toContain(OLD_SENTINEL);
    const b = makeJob({ source: 'auth_events', rows: [authRow(1)] }); await b.run(); expect(b.csv()).not.toContain(UA_TAIL);
  });
  it('nothing sensitive reaches the logs (no cell values, no names)', async () => {
    const j = makeJob({ rows: [auditRow(1, { actor_display_name: 'LOGLEAK-NAME-5521' })] }); await j.run();
    expect(JSON.stringify(j.logs)).not.toContain('LOGLEAK-NAME-5521');
  });
});

describe('AC-D4.6 / D-T4 - CSV injection guard = shared neutraliseFormula + RFC 4180 quoting only', () => {
  const NASTY = ['=HYPERLINK("http://evil.example/x","click")', '+SUM(1,2)', '-2+3', '@SUM(A1)', '\t=1+1', '\r=1+1', "'quoted", "'=already", "''two", 'normal', 'a,b', 'say "hi"', 'line1\nline2', 'tail=ok', 'ünïcode नेपाली', ' =lead-space', '=', "'"];
  const nastyRows = () => NASTY.map((n, i) => auditRow(i + 1, { actor_display_name: n, display_name: n }));
  it.each(['audit_log', 'access_log', 'auth_events'] as const)('%s: every actor_display_name cell equals neutraliseFormula(raw) and restoreNeutralised gives the raw text back', async (source) => {
    const mk = { audit_log: auditRow, access_log: accessRow, auth_events: authRow }[source];
    const rows = NASTY.map((n, i) => mk(i + 1, { actor_display_name: n, display_name: n }));
    const j = makeJob({ source, rows }); await j.run();
    const t = table(j.csv());
    expect(t.rows).toHaveLength(NASTY.length);
    const byId = new Map(t.rows.map((r) => [r[HEADERS[source][0]]!, r['actor_display_name']!]));
    NASTY.forEach((raw, i) => {
      const cell = byId.get(mk(i + 1).id)!;
      expect(cell, JSON.stringify(raw)).toBe(neutraliseFormula(raw));
      expect(restoreNeutralised(cell), JSON.stringify(raw)).toBe(raw);
    });
  });
  it('a leading apostrophe is guarded too: \'x becomes \'\'x (not left as is)', async () => {
    const j = makeJob({ rows: [auditRow(1, { actor_display_name: "'x", display_name: "'x" })] }); await j.run();
    expect(table(j.csv()).rows[0]!['actor_display_name']).toBe("''x");
  });
  it('the dangerous prefixes end up with a leading quote in the FILE too (what Excel sees), never a bare = + - @ TAB CR at a cell start', async () => {
    const j = makeJob({ rows: nastyRows() }); await j.run();
    for (const r of table(j.csv()).raw) for (const cell of r) expect(cell, JSON.stringify(cell)).not.toMatch(/^[=+\-@\t\r]/);
  });
  it('every other text column is guarded as well (reason_code, event_type, table, action, entity_type), not only the display name', async () => {
    const a = makeJob({ source: 'auth_events', rows: [authRow(1, { reason_code: '=1+1', event_type: '@evil' })] }); await a.run();
    const ta = table(a.csv()).rows[0]!; expect(ta['reason_code']).toBe("'=1+1"); expect(ta['event_type']).toBe("'@evil");
    const b = makeJob({ source: 'access_log', rows: [accessRow(1, { entity_type: '-cmd', action: '+act' })] }); await b.run();
    expect(table(b.csv()).rows[0]!['entity_type']).toBe("'-cmd");
    const c = makeJob({ source: 'audit_log', rows: [auditRow(1, { table_name: '=t', changed_columns: ['=x'] })] }); await c.run();
    for (const cell of table(c.csv()).raw[0]!) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });
  it('RFC 4180: commas, quotes, CR/LF inside cells survive a strict parse; every row has the header\'s field count', async () => {
    const j = makeJob({ rows: nastyRows() }); await j.run();
    const rows = parseCsv(j.csv()); const w = rows[0]!.length;
    expect(rows.every((r) => r.length === w)).toBe(true);
    const t = table(j.csv()); const names = t.rows.map((r) => r['actor_display_name']);
    expect(names).toContain(neutraliseFormula('a,b')); expect(names).toContain('say "hi"'); expect(names).toContain('line1\nline2');
  });
  it('the bytes are valid UTF-8 and the file has no module-local escaping artefacts (no backslash escaping of quotes)', async () => {
    const j = makeJob({ rows: nastyRows() }); await j.run();
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(j.puts[0]!.bytes)).not.toThrow();
    expect(j.csv()).not.toContain('\\"');
  });
});

describe('tenant isolation and range / filters (P-3, P-4)', () => {
  it('P-4: tenant B rows never appear in tenant A\'s file (the source statements carry the tenant id)', async () => {
    const rows = [auditRow(1), auditRow(2, { tenant_id: TENANT_B, actor_display_name: 'B-ONLY-PERSON', display_name: 'B-ONLY-PERSON' }), auditRow(3)];
    const j = makeJob({ rows }); await j.run();
    expect(j.csv()).not.toContain('B-ONLY-PERSON'); expect(table(j.csv()).rows).toHaveLength(2);
    for (const s of j.sourceSelects) expect(s.text).toMatch(/\btenant_id\s*=\s*\$\d/i);
  });
  it('rows outside [range_from, range_to) are not exported (end exclusive); the range is a bound parameter', async () => {
    const rows = [auditRow(1, { occurred_at: new Date(FROM) }), auditRow(2, { occurred_at: new Date(Date.parse(TO) - 1) }), auditRow(3, { occurred_at: new Date(TO) }), auditRow(4, { occurred_at: new Date(Date.parse(FROM) - 1) })];
    const j = makeJob({ rows }); await j.run();
    expect(table(j.csv()).rows.map((r) => r['audit_id']).sort()).toEqual([auditRow(1).id, auditRow(2).id].sort());
  });
  it('stored filters are applied (table core.roles) - other tables\' rows are absent', async () => {
    const rows = [auditRow(1), auditRow(2, { table_name: 'users', table: 'core.users' }), auditRow(3)];
    const j = makeJob({ rows, exportRow: { filters: { table: 'core.roles' } } }); await j.run();
    expect(table(j.csv()).rows.map((r) => r['table'])).toEqual(['core.roles', 'core.roles']);
  });
  it('payload tenant_id missing / different from the job tenant / not the export\'s tenant -> no statement touches data, no object, no throw', async () => {
    for (const payload of [{ export_id: EXPORT_ID }, { tenant_id: TENANT_B, export_id: EXPORT_ID }, { tenant_id: 'nope', export_id: EXPORT_ID }, { tenant_id: TENANT_A }, { tenant_id: TENANT_A, export_id: 'nope' }]) {
      const j = makeJob({ rows: [auditRow(1)] }); await j.run(payload as any);
      expect(j.puts, JSON.stringify(payload)).toHaveLength(0); expect(j.sourceSelects).toHaveLength(0); expect(j.updates).toHaveLength(0);
    }
  });
  it('an export row of another tenant (tenant filter missing in the lookup) is not built', async () => {
    const j = makeJob({ rows: [auditRow(1)], exportRow: { tenant_id: TENANT_B } }); await j.run();
    expect(j.puts).toHaveLength(0);
  });
});

describe('batching (5,000) and boundaries', () => {
  it.each([[12_001], [10_000], [5_000], [5_001]])('%i rows: every batch LIMIT <= 5000 with ORDER BY and no OFFSET; CSV holds every row exactly once', async (n) => {
    const j = makeJob({ bulk: n }); await j.run();
    expect(j.sourceSelects.length).toBeGreaterThanOrEqual(Math.ceil(n / 5000));
    for (const s of j.sourceSelects) { expect(s.limit, s.text).toBeLessThanOrEqual(5000); expect(s.limit).toBeGreaterThan(0); expect(s.text).toMatch(/ORDER BY/i); expect(s.text).not.toMatch(/\bOFFSET\b/i); }
    const t = table(j.csv()); expect(t.rows).toHaveLength(n); expect(new Set(t.rows.map((r) => r['audit_id'])).size).toBe(n);
    expect(j.updates.find((u) => u.status === 'ready')!.values).toContain(n);
  }, 60_000);
  it('more than 500,000 rows (the estimate was wrong): failed with identity.export_too_large, no object, nothing marked ready', async () => {
    const j = makeJob({ bulk: 500_001 }); await j.run();
    expect(j.puts).toHaveLength(0);
    expect(j.updates.some((u) => u.status === 'ready')).toBe(false);
    const f = j.updates.find((u) => u.status === 'failed')!; expect(f).toBeTruthy(); expect(f.values).toContain('identity.export_too_large');
    expect(j.job.status).toBe('failed');
  }, 120_000);
});

describe('validation at build time and failure handling (03-APP-FLOW §2.7)', () => {
  it('re-validates stored filters: an unknown key / malformed value -> failed (queued -> failed), no source statement with that text, no object', async () => {
    for (const filters of [{ 'x; DROP TABLE audit.audit_log': 'v' }, { actor_id: "' OR 1=1 --" }, { tenant_id: TENANT_B }, { table: 'core.roles; select 1' }]) {
      const j = makeJob({ rows: [auditRow(1)], exportRow: { filters } }); await j.run();
      expect(j.puts, JSON.stringify(filters)).toHaveLength(0);
      expect(j.job.status).toBe('failed');
      expect(j.updates.find((u) => u.status === 'failed')!.text).toMatch(/\berror_code\b/i);
      expect(j.stmts.some((s) => /DROP TABLE|OR 1=1|select 1/.test(s.text))).toBe(false);
    }
  });
  it('range wider than 31 days or inverted -> failed, nothing built (DB CHECK bypassed by a bad row)', async () => {
    for (const exportRow of [{ range_to: new Date('2026-12-15T00:00:00.000Z') }, { range_from: new Date(TO), range_to: new Date(FROM) }]) {
      const j = makeJob({ rows: [auditRow(1)], exportRow }); await j.run();
      expect(j.puts).toHaveLength(0); expect(j.job.status).toBe('failed');
    }
  });
  it('terminal / finished exports are not rebuilt: ready, failed, expired -> no object, no update, no throw (job redelivery)', async () => {
    for (const status of ['ready', 'failed', 'expired']) {
      const j = makeJob({ rows: [auditRow(1)], exportRow: { status } }); await j.run();
      expect(j.puts, status).toHaveLength(0); expect(j.updates, status).toHaveLength(0);
    }
  });
  it('a retry after a crash while building (status building, object of the first attempt exists) still ends ready', async () => {
    const j = makeJob({ rows: [auditRow(1)], exportRow: { status: 'building' }, existingObject: true }); await j.run();
    expect(j.job.status).toBe('ready'); expect(j.puts).toHaveLength(1);
  });
  it('storage failure: the error propagates (retry), the export is never marked ready', async () => {
    const j = makeJob({ rows: [auditRow(1)], putFails: true });
    await expect(j.run()).rejects.toThrow();
    expect(j.updates.some((u) => u.status === 'ready')).toBe(false);
  });
  it('the job makes no change to any table other than identity.audit_exports (no source mutation)', async () => {
    const j = makeJob({ rows: [auditRow(1), auditRow(2)] }); await j.run();
    for (const s of j.stmts) if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.text)) expect(s.text).toMatch(/identity\.audit_exports/i);
  });
});
