// C6-T10 test helpers (not a test file). Synthetic data only.
// - makeDb(): in-memory fake of ONE Postgres transaction for reporting.input_files / report_order_items / reports / g_cs_reasons / cs_reasons.
//   Models by SQL CONTENT (never statement position): `col = $n` equality filters on SELECT/UPDATE (so `version = $n` optimistic locking and the
//   explicit tenant predicate are observable; a statement WITHOUT a tenant predicate sees ALL tenants' rows), INSERT ... VALUES ($n,...) [RETURNING],
//   UPDATE ... SET col = $n | version + 1 | COALESCE($n, col) | now() | literal [RETURNING], `SELECT app.enqueue_job(...)` (recorded in `jobs`).
//   Joins / UNION over two tables are NOT modelled (a merge of g_cs_reasons + cs_reasons is). lims_app has no DELETE grant -> DELETE raises 42501.
// - makeStorage(): StorageAdapter fake (put ifAbsent, read, tenant-first-segment check, call log). makeUploads(): the REAL core createUploads over it.
// - EICAR is assembled at run time so no file in the repo contains the full signature (AV false positives).
import { createHash } from 'node:crypto';
import { createUploads } from '../../../core/uploads/index.js';
import type { StorageAdapter } from '../../../core/storage/index.js';
import { TENANT_A, TENANT_B, USER, MEM, REQ_ID, idN, pgError } from './settings.helpers.js';

export { TENANT_A, TENANT_B, USER, MEM, REQ_ID, idN, pgError };
export const CENTRE_1 = idN(0xc1);
export const ORDER_1 = idN(0x0d01);
export const REPORT_1 = idN(0x0e01);
export const ITEM_1 = idN(0x1101);      // outsourced item of tenant A
export const ITEM_2 = idN(0x1102);      // second outsourced item of tenant A
export const ITEM_LAB = idN(0x1103);    // NOT outsourced
export const ITEM_REMOVED = idN(0x1104);
export const ITEM_B = idN(0x11b1);      // tenant B
export const REPORT_B = idN(0x0eb1);
export const FILE_NS = 0x2000;
export const BUCKET = 'reporting-inputs';
export const NOW = '2026-11-07T12:00:00.000Z';

export type Row = Record<string, any>;
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

// ---------------------------------------------------------------------------------------------------- fixtures
const enc = new TextEncoder();
export function pdfBytes(size = 2 * 1024 * 1024, tag = 'synthetic'): Uint8Array {
  const head = enc.encode(`%PDF-1.7\n% ${tag}\n1 0 obj<</Type/Catalog>>endobj\n`);
  const b = new Uint8Array(Math.max(size, head.length + 6)); b.fill(0x20); b.set(head, 0);
  b.set(enc.encode('\n%%EOF'), b.length - 6);
  return b;
}
/** Standard AV test string, split so this repo never contains it contiguously. */
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS', '-TEST-FILE!$H+H*'].join('');
export const eicarPdf = (): Uint8Array => enc.encode(`%PDF-1.4\n${EICAR}\n%%EOF`);
export const fakeScan = async (bytes: Uint8Array): Promise<'clean' | 'infected' | 'unavailable'> =>
  Buffer.from(bytes).includes('EICAR-STANDARD-ANTIVIRUS') ? 'infected' : 'clean';
export const SANITIZED = enc.encode('%PDF-1.7\n% sanitised-by-qpdf\n%%EOF');
export const SENTINEL_NAME = 'SENTINEL-Sita-Karki-report.pdf';   // original filename = P2 metadata: must never reach logs / metric labels / storage keys

// ---------------------------------------------------------------------------------------------------- storage + uploads
export function makeStorage(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial));
  const calls: Array<{ op: string; bucket: string; path: string }> = [];
  const key = (b: string, p: string) => `${b}::${p}`;
  const guard = (tenant: string | undefined, p: string) => { if (tenant && p.split('/')[0] !== tenant) throw new Error('storage: cross-tenant path refused'); };
  const forTenant = (tenant?: string): StorageAdapter => ({
    async put(bucket, path, bytes, o) {
      calls.push({ op: 'put', bucket, path }); guard(tenant, path);
      if (o.ifAbsent && objects.has(key(bucket, path))) throw new Error('storage: object exists');
      objects.set(key(bucket, path), new Uint8Array(bytes)); return { sha256: sha256(bytes), byteSize: bytes.length };
    },
    async read(bucket, path) {
      calls.push({ op: 'read', bucket, path }); guard(tenant, path);
      const o = objects.get(key(bucket, path)); if (!o) throw new Error('storage: not found'); return new Uint8Array(o);
    },
    async move(bucket, from, to) { calls.push({ op: 'move', bucket, path: from }); const o = objects.get(key(bucket, from)); if (o) { objects.delete(key(bucket, from)); objects.set(key(bucket, to), o); } },
    async signedUrl(bucket, path) { calls.push({ op: 'signedUrl', bucket, path }); return 'https://invalid.example/signed'; },
    async delete(bucket, path) { calls.push({ op: 'delete', bucket, path }); objects.delete(key(bucket, path)); },
  });
  return {
    objects, calls, forTenant,
    has: (bucket: string, path: string) => objects.has(key(bucket, path)),
    get: (bucket: string, path: string) => objects.get(key(bucket, path)),
    paths: (bucket = BUCKET) => [...objects.keys()].filter((k) => k.startsWith(`${bucket}::`)).map((k) => k.slice(bucket.length + 2)),
    reads: () => calls.filter((c) => c.op === 'read'),
  };
}
export type FakeStorage = ReturnType<typeof makeStorage>;

// ---------------------------------------------------------------------------------------------------- fake transaction
const DDL_DEFAULTS: Record<string, Row> = {
  input_files: { state: 'pending_scan', version: 1, sort_order: 0, caption: null, detected_mime: null, sanitized_object_path: null, sanitized_sha256: null,
    page_count: null, confirmed_by: null, confirmed_at: null, withdrawn_reason_code: null, withdrawn_reason_text: null, last_error_code: null, narrative_report_id: null },
  report_order_items: { item_status: 'active', outsourced_ready: false, requires_outsourced: false },
  reports: { needs_assembly: false, needs_assembly_since: null },
  report_versions: { status: 'draft', content_snapshot: {} },
  narrative_reports: { status: 'draft', current_version_no: 1, signed_version_no: null, version: 1 },   // C6-T11
  narrative_versions: { status: 'draft', template_id: null, image_file_ids: [], signed_by_membership_id: null, signed_at: null, content_sha256: null, amendment_of_version_no: null, amendment_reason_code: null, amendment_reason_text: null, version: 1 },   // C6-T17
  narrative_templates: { test_id: null, is_active: true, version: 1 },   // C6-T17
  report_templates: { current_version_id: null, is_default: false, version: 1, is_active: true },   // C6-T18
  report_template_versions: { status: 'draft', published_at: null, published_by: null, version: 1, is_active: true },   // C6-T18
  g_cs_reasons: { is_active: true, sort_order: 0 }, cs_reasons: { is_active: true, sort_order: 0 },
};
const TABLES = Object.keys(DDL_DEFAULTS);
const UNIQUE: Record<string, string[][]> = { input_files: [['tenant_id', 'id']], report_order_items: [['tenant_id', 'order_item_id', 'report_id']], reports: [['tenant_id', 'id']], report_versions: [['tenant_id', 'id']], narrative_reports: [['tenant_id', 'id']], narrative_versions: [['tenant_id', 'id'], ['tenant_id', 'narrative_report_id', 'version_no']], narrative_templates: [['tenant_id', 'id'], ['tenant_id', 'code']],
  report_templates: [['tenant_id', 'id']], report_template_versions: [['tenant_id', 'id'], ['tenant_id', 'template_id', 'version_no']], g_cs_reasons: [], cs_reasons: [] };
/** report_template_versions partial unique indexes (05-SCHEMA §2.12): one draft and one published row per template. */
const PARTIAL_UNIQUE_STATUS = ['draft', 'published'];
/** app.enforce_mutable_columns trigger on non-draft report_template_versions rows. */
const VERSION_MUTABLE_WHEN_FROZEN = ['status', 'updated_at', 'updated_by', 'version'];

function topLevelGroups(s: string): string[] { const out: string[] = []; let d = 0; let cur = ''; for (const ch of s) { if (ch === '(') { if (d++ === 0) { cur = ''; continue; } } else if (ch === ')') { if (--d === 0) { out.push(cur); continue; } } if (d > 0) cur += ch; } return out; }
function splitComma(s: string): string[] { const out: string[] = []; let d = 0; let q = false; let cur = ''; for (const ch of s) { if (ch === "'") q = !q; if (!q && ch === '(') d++; if (!q && ch === ')') d--; if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }

export interface Seed { input_files?: Row[]; report_order_items?: Row[]; reports?: Row[]; report_versions?: Row[]; narrative_reports?: Row[]; narrative_versions?: Row[]; narrative_templates?: Row[]; report_templates?: Row[]; report_template_versions?: Row[]; g_cs_reasons?: Row[]; cs_reasons?: Row[] }
export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly verb: string }

export function makeDb(seed: Seed = {}, opts: { failOn?: Array<{ match: RegExp; error: () => Error }> } = {}) {
  const store: Record<string, Row[]> = {};
  for (const t of TABLES) store[t] = ((seed as Record<string, Row[]>)[t] ?? []).map((r) => ({ ...DDL_DEFAULTS[t], ...r }));
  const stmts: Stmt[] = []; const jobs: Array<{ identifier: string; payload: any; jobKey: unknown; values: unknown[] }> = [];

  const eqFilters = (where: string, values: readonly unknown[]) =>
    [
      ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)(?:::\w+)?/g)].map((m) => [m[1]!, values[Number(m[2]) - 1]] as const),
      ...[...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*'([^']*)'/g)].map((m) => [m[1]!, m[2]!] as const),   // literal `state = 'confirmed'`
    ].filter(([, v]) => v !== null && v !== undefined);
  const matches = (r: Row, f: ReadonlyArray<readonly [string, unknown]>) => f.every(([c, v]) => !(c in r) || r[c] === v);
  const tokenValue = (t: string, values: readonly unknown[]): unknown => {
    const p = /\$(\d+)/.exec(t)?.[1]; if (p) return values[Number(p) - 1];
    if (/^now\(\)$/i.test(t)) return NOW; if (/^null$/i.test(t)) return null; if (/^true$/i.test(t)) return true; if (/^false$/i.test(t)) return false;
    if (/^-?\d+$/.test(t)) return Number(t); return t.replace(/^'|'$/g, '');
  };
  function applySet(r: Row, set: string, values: readonly unknown[], excluded?: Row) {
    for (const a of splitComma(set.replace(/\bwhere\b[\s\S]*$/i, '').replace(/\breturning\b[\s\S]*$/i, ''))) {
      const m = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(a); if (!m) continue;
      const col = m[1]!; const rhs = m[2]!.trim();
      if (/^(?:[\w.]+\.)?version\s*\+\s*1$/i.test(rhs)) r[col] = (r[col] ?? 0) + 1;
      else if (/^excluded\.(\w+)/i.test(rhs)) r[col] = excluded?.[/^excluded\.(\w+)/i.exec(rhs)![1]!];
      else if (/^coalesce\(\s*\$(\d+)/i.test(rhs)) { const v = values[Number(/^coalesce\(\s*\$(\d+)/i.exec(rhs)![1]) - 1]; if (v !== null && v !== undefined) r[col] = v; }
      else if (/^coalesce\(\s*\w+\s*,\s*now\(\)\s*\)$/i.test(rhs)) { r[col] = r[col] ?? NOW; }
      else if (!/\(/.test(rhs) || /^\$\d+/.test(rhs)) r[col] = tokenValue(rhs.replace(/::\w+(\[\])?$/, ''), values);
    }
  }

  function exec(text: string, values: readonly unknown[]): Row[] {
    for (const f of opts.failOn ?? []) if (f.match.test(text)) throw f.error();
    if (/\bapp\.enqueue_job\s*\(/i.test(text)) {
      let payload: any = values[1]; if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* keep */ } }
      jobs.push({ identifier: String(values[0]), payload, jobKey: values[2], values: [...values] }); return [{ enqueue_job: 1 }];
    }
    const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase();
    const bothCs = /\bg_cs_reasons\b/.test(text) && /(?<![g_\w])cs_reasons\b/.test(text);
    if (verb === 'select' && bothCs) {
      const set = values.find((v) => typeof v === 'string' && /_reasons$/.test(v)); const t = values.find((v) => v === TENANT_A || v === TENANT_B);
      const byCode = new Map<string, Row>(store['g_cs_reasons']!.filter((r) => !set || r['set_name'] === set).map((r) => [r['code'], r]));
      for (const r of store['cs_reasons']!.filter((x) => x['tenant_id'] === t && (!set || x['set_name'] === set))) byCode.set(r['code'], r);
      return [...byCode.values()].filter((r) => r['is_active']).map((r) => ({ ...r }));
    }
    const table = /(?:from|into|update)\s+reporting\.(\w+)/i.exec(text)?.[1];
    if (!table || !(table in store)) return [];
    const rows = store[table]!;
    if (verb === 'delete') throw pgError('42501', 'permission denied: no DELETE grant');
    if (verb === 'select' && table === 'report_versions') {   // O4 lookup: tenant + status IN ('released','superseded') + content_snapshot.outsourcedAttachments @> [{inputFileId}]
      if (!/tenant_id\s*=\s*\$1/i.test(text)) return rows.map(() => ({ '?column?': 1 }));   // missing tenant predicate -> sees every tenant's versions
      const wanted = /\bstatus\s+in\s*\(([^)]*)\)/i.exec(text)?.[1]?.match(/'([^']*)'/g)?.map((x) => x.slice(1, -1)) ?? [];
      return rows.filter((r) => r['tenant_id'] === values[0] && wanted.includes(r['status'])
        && ((r['content_snapshot']?.outsourcedAttachments ?? []) as Row[]).some((a) => a['inputFileId'] === values[1])).map(() => ({ '?column?': 1 }));
    }
    if (verb === 'select') {
      const where = /\bwhere\b([\s\S]*)$/i.exec(text)?.[1] ?? ''; const f = eqFilters(where, values);
      return rows.filter((r) => matches(r, f)).map((r) => ({ ...r }));
    }
    if (verb === 'update') {
      const m = /\bset\b([\s\S]*?)\bwhere\b([\s\S]*)$/i.exec(text); if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: UPDATE without WHERE');
      const f = eqFilters(m[2]!, values); const hit = rows.filter((r) => matches(r, f));
      for (const r of hit) {
        if (table !== 'report_template_versions') { applySet(r, m[1]!, values); continue; }
        const next: Row = { ...r }; applySet(next, m[1]!, values);
        if (r['status'] !== 'draft' && Object.keys(next).some((c) => !VERSION_MUTABLE_WHEN_FROZEN.includes(c) && JSON.stringify(next[c]) !== JSON.stringify(r[c]))) throw pgError('P0001', 'not mutable');
        if (PARTIAL_UNIQUE_STATUS.includes(next['status']) && next['status'] !== r['status']
          && rows.some((o) => o !== r && o['template_id'] === r['template_id'] && o['tenant_id'] === r['tenant_id'] && o['status'] === next['status'])) throw pgError('23505', 'duplicate key');
        Object.assign(r, next);
      }
      return /\breturning\b/i.test(text) ? hit.map((r) => ({ ...r })) : [];
    }
    if (verb === 'insert') {
      const m = /into\s+reporting\.\w+\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b([\s\S]*?))?(?:\breturning\b[\s\S]*)?$/i.exec(text);
      if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: INSERT must be `INSERT INTO reporting.t (cols) VALUES ($1, ...)`');
      const cols = m[1]!.split(',').map((c) => c.trim()); const out: Row[] = [];
      for (const g of topLevelGroups(m[2]!)) {
        const toks = splitComma(g); const row: Row = { ...DDL_DEFAULTS[table] };
        cols.forEach((c, i) => { const t = toks[i]!; if (/^default$/i.test(t)) return; row[c] = tokenValue(t, values); });
        if (row['tenant_id'] === undefined || row['tenant_id'] === null) throw pgError('23502', 'null tenant_id');
        if (table === 'report_template_versions' && PARTIAL_UNIQUE_STATUS.includes(row['status'])
          && rows.some((o) => o['tenant_id'] === row['tenant_id'] && o['template_id'] === row['template_id'] && o['status'] === row['status'])) throw pgError('23505', 'duplicate key');
        const dup = rows.find((e) => (UNIQUE[table] ?? []).some((u) => u.every((c) => e[c] === row[c])));
        if (dup) { if (!m[3]) throw pgError('23505', 'duplicate key'); if (/do\s+nothing/i.test(m[3])) continue; applySet(dup, /do\s+update\s+set([\s\S]*)$/i.exec(m[3])?.[1] ?? '', values, row); out.push({ ...dup }); }
        else { rows.push(row); out.push({ ...row }); }
      }
      return /\breturning\b/i.test(text) ? out : [];
    }
    return [];
  }
  const tx = {
    startedAt: new Date(NOW),
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values: [...values], verb: (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase() });
      return { rows: exec(text, values) };
    },
    savepoint: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  return {
    tx, stmts, store, jobs,
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(s.verb)),
    reporting: () => stmts.filter((s) => /\breporting\./i.test(s.text)),
    files: () => store['input_files']!, file: (id: string) => store['input_files']!.find((r) => r['id'] === id),
    item: (itemId: string) => store['report_order_items']!.find((r) => r['order_item_id'] === itemId),
    report: (id: string) => store['reports']!.find((r) => r['id'] === id),
    jobsOf: (identifier: string) => jobs.filter((j) => j.identifier === identifier),
  };
}
export type FakeDb = ReturnType<typeof makeDb>;

/** A tenant-A world: one report, outsourced items ITEM_1/ITEM_2, a lab item, a removed item; tenant B has its own outsourced item. */
export function world(extra: Seed = {}): Seed {
  const item = (tenant: string, report: string, itemId: string, o: Row = {}) =>
    ({ tenant_id: tenant, report_id: report, order_item_id: itemId, order_id: ORDER_1, centre_id: CENTRE_1, requires_outsourced: true, ...o });
  return {
    reports: [{ tenant_id: TENANT_A, id: REPORT_1, centre_id: CENTRE_1, order_id: ORDER_1 }, { tenant_id: TENANT_B, id: REPORT_B, centre_id: CENTRE_1, order_id: ORDER_1 }],
    report_order_items: [
      item(TENANT_A, REPORT_1, ITEM_1), item(TENANT_A, REPORT_1, ITEM_2), item(TENANT_A, REPORT_1, ITEM_LAB, { requires_outsourced: false }),
      item(TENANT_A, REPORT_1, ITEM_REMOVED, { item_status: 'removed' }), item(TENANT_B, REPORT_B, ITEM_B),
    ],
    g_cs_reasons: [{ set_name: 'outsourced_withdraw_reasons', code: 'wrong_patient', display: 'Wrong patient', sort_order: 1 },
      { set_name: 'outsourced_withdraw_reasons', code: 'wrong_report', display: 'Wrong report', sort_order: 2 }],
    ...extra,
  };
}

let seq = FILE_NS;
export const fileId = () => idN(++seq);
/** A seeded input_files row (tenant A, ITEM_1 by default). */
export function fileRow(o: Row = {}): Row {
  const id = (o['id'] as string) ?? fileId(); const tenant = (o['tenant_id'] as string) ?? TENANT_A;
  return {
    id, tenant_id: tenant, centre_id: CENTRE_1, order_id: ORDER_1, order_item_id: ITEM_1, kind: 'outsourced_pdf', state: 'pending_scan',
    original_filename: 'synthetic-report.pdf', declared_mime: 'application/pdf', size_bytes: 2048, sha256_original: sha256('x'),
    quarantine_object_path: `${tenant}/quarantine/2026/11/${id}.bin`, external_lab_name: 'Synthetic Reference Lab', version: 1, ...o,
  };
}
export const sanitizedPath = (tenant: string, id: string) => `${tenant}/outsourced/2026/11/${id}.pdf`;

// ---------------------------------------------------------------------------------------------------- API ctx
export function makeApiCtx(db: FakeDb, storage: FakeStorage, over: Record<string, unknown> = {}) {
  const tenantId = (over['tenantId'] as string) ?? TENANT_A;
  const access: Array<Record<string, any>> = []; const logs: unknown[] = []; const metrics: Array<{ name: string; labels: any }> = [];
  const scanner = (over['scan'] as typeof fakeScan | undefined) ?? fakeScan;
  const ctx = {
    tenantId, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, tx: db.tx, now: () => NOW, ports: {},
    storage: storage.forTenant(tenantId), files: { scan: scanner },
    uploads: createUploads({ files: { scan: scanner }, storage: storage.forTenant(tenantId), module: 'reporting', tenantId }),
    audit: { access: async (e: Record<string, any>) => { access.push(e); } },
    log: { info: (o: unknown) => logs.push(o), warn: (o: unknown) => logs.push(o), error: (o: unknown) => logs.push(o) },
    metrics: { inc: (name: string, labels?: any) => metrics.push({ name, labels: labels ?? {} }) },
    ...over,
  } as any;
  return { ctx, access, logs, metrics };
}
export const incoming = (bytes: Uint8Array, filename = 'synthetic-report.pdf', mimeType = 'application/pdf') => ({ filename, mimeType, bytes });

// ---------------------------------------------------------------------------------------------------- worker ctx
export function makeJobCtx(db: FakeDb, storage: FakeStorage, over: Record<string, unknown> = {}) {
  const tenantId = (over['tenantId'] as string | undefined) ?? TENANT_A;
  const logs: unknown[] = []; const metrics: Array<{ name: string; labels: any; value: number }> = [];
  const scanner = (over['scan'] as typeof fakeScan | undefined) ?? fakeScan;
  const ctx: any = {
    tenantId, actor: { type: 'system', id: idN(0xa009) }, requestId: REQ_ID, tx: db.tx, now: () => NOW, attempt: 1, maxAttempts: 5, jobId: 'job-1',
    storage: storage.forTenant(tenantId), files: { scan: scanner },
    log: { info: (o: unknown) => logs.push(o), warn: (o: unknown) => logs.push(o), error: (o: unknown) => logs.push(o) },
    metrics: { inc: (name: string, labels?: any, by?: number) => metrics.push({ name, labels: labels ?? {}, value: by ?? 1 }) },
    events: {}, core: {}, audit: {}, isNewer: () => true, ...over,
  };
  ctx.db = { tx: async (fn: (c: unknown) => Promise<unknown>) => fn(ctx) };
  return { ctx, logs, metrics };
}
