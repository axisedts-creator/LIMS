// C10 T-11 — breakpoint import endpoint + storage: M42 createBreakpointImport, M41 list, M43 get, M44 issues, M45 rows, M49 template.
// Spec: 06-IMPLEMENTATION-PLAN row T-11; 02-TRD §5 M41–M45/M49, §8 (job micro.breakpoint_import_validate), §9.1 (template), §13 (access_log);
//       01-PRD AC-12.1, AC-12.3, AC-12.5; 07-SECURITY T-B1, T-B3, T-B4, T-B6, S-05, S-10, S-12 (API half), S-13 (API half), S-15; 08 §4.13 / R12b (ctx.uploads, ctx.storage).
// No database: a scripted ctx.tx fake (below) that understands INSERT/SELECT on micro.breakpoint_sets and app.enqueue_job; the REAL core
// createUploads (module 'micro') over an in-memory storage; a privileged-aware IdentityPort fake (as catalog helpers/identity.ts).
// SEAMS (spec silent; the writer must match): handlers in handlers/*.ts spread into REAL in handlers/index.ts, over service/breakpoint.service.ts +
//   repository/breakpoints.repo.ts. Handler request for M42: body = { metadata: {...}, file: { filename, mimeType, bytes: Uint8Array } } (as frontdesk uploadTrf).
//   permission FIRST via ctx.ports.IdentityPort.assertRole(ctx, { permission }); privileged => aal2 enforced INSIDE assertRole (auth.mfa_required passes through).
//   set rows are written by ONE `INSERT INTO micro.breakpoint_sets (<columns>) VALUES (...)` with 05-SCHEMA §8 column names (file_bucket, file_object_path,
//   file_sha256, file_bytes, status, intended_effective_from, created_by = ctx.actor.id ...); job = `SELECT app.enqueue_job('micro.breakpoint_import_validate',
//   $payload::jsonb, $set_id)` in the SAME tx after the insert, payload {tenant_id, set_id} (payload shape ASSUMED by analogy with catalog.import_validate).
//   M49 result: { status: 200, body: string | Uint8Array (CSV text), headers (any case) }.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { createUploads } from '../../../../core/uploads/index.js';
import { handlers } from '../index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'));
const specOps = (): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId) out[op.operationId] = op;
  return out;
};

const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
const USER_A = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = '2026-06-15T05:00:30.000Z';
const MAX = 5_242_880;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PERM = 'micro.breakpoint.manage';
const JOB = 'micro.breakpoint_import_validate';
const HEADER = 'organism_scope,organism_code,antibiotic_code,method,specimen_site_code,qualifier_code,category_code,lower_value,lower_inclusive,upper_value,upper_inclusive,note';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const META = {
  standard: 'CLSI', standard_version: '2026', title: 'Synthetic title',
  licence_attestation_text: 'Synthetic attestation: test data only, licensed for this laboratory.', intended_effective_from: '2026-01-15T08:30:00.000Z',
};
let seq = 0;
/** distinct synthetic CSV per call (different sha256); the marker is what must never reach a SQL parameter or log. */
const csv = (marker = `SYNTHETIC-MARKER-${++seq}`) => Buffer.from(`${HEADER}\n# ${marker}\nany,,syn_antibiotic,mic,,,S,,true,2,true,NOT CLINICAL\n`, 'utf8');

// ------------------------------------------------------------------ fakes
type Row = Record<string, any>;
interface Call { readonly text: string; readonly params: unknown[] }
function makeDb() {
  const sets: Row[] = [];
  const calls: Call[] = [];
  const jobs: Call[] = [];
  const state = { failEnqueue: false, n: 0 };
  const splitTop = (s: string): string[] => {
    const out: string[] = []; let depth = 0; let cur = ''; let q = false;
    for (const ch of s) {
      if (ch === "'") q = !q;
      if (!q && ch === '(') depth++;
      if (!q && ch === ')') depth--;
      if (!q && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const evalVal = (v: string, params: unknown[]): unknown => {
    const p = /^\$(\d+)/.exec(v);
    if (p) return params[Number(p[1]) - 1];
    const s = /^'((?:[^']|'')*)'/.exec(v);
    if (s) return s[1]!.replace(/''/g, "'");
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    return undefined; // now(), DEFAULT, NULL ... -> column default
  };
  const dto = (r: Row): Row => ({ ...r, imported_by_display: 'Synthetic Importer' });
  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    if (/enqueue_job/i.test(text)) {
      if (state.failEnqueue) throw new Error('enqueue failed');
      jobs.push({ text, params });
      return { rows: [{}], rowCount: 1 };
    }
    const ins = /^\s*INSERT\s+INTO\s+(?:micro\.)?breakpoint_sets\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*(ON\s+CONFLICT.*?)?(RETURNING.*)?$/is.exec(text);
    if (ins) {
      const cols = ins[1]!.split(',').map((c) => c.trim());
      const vals = splitTop(ins[2]!);
      const row: Row = { version: 1, is_active: true, row_count: 0, band_count: 0, error_count: 0, warning_count: 0, created_at: new Date(NOW), updated_at: new Date(NOW) };
      cols.forEach((c, i) => { const v = evalVal(vals[i] ?? '', params); if (v !== undefined) row[c] = v; });
      for (const k of ['intended_effective_from', 'effective_from', 'effective_to']) if (typeof row[k] === 'string') row[k] = new Date(row[k]);
      if (sets.some((s) => s.tenant_id === row.tenant_id && s.standard === row.standard && s.file_sha256 === row.file_sha256 && !['invalid', 'discarded'].includes(s.status))) {
        if (ins[3]) return { rows: [], rowCount: 0 };
        throw Object.assign(new Error('duplicate key value violates unique constraint "breakpoint_sets__tenant_id_standard_sha__p_uq"'), { code: '23505', constraint: 'breakpoint_sets__tenant_id_standard_sha__p_uq' });
      }
      sets.push(row);
      return { rows: ins[4] ? [dto(row)] : [], rowCount: 1 };
    }
    if (/^\s*(SELECT|WITH)/i.test(text) && /breakpoint_sets/i.test(text)) {
      let rows = sets.slice();
      if (params.includes(TENANT_A) || params.includes(TENANT_B)) rows = rows.filter((r) => params.includes(r.tenant_id)); // RLS + explicit filter; no tenant param => no filter (a leak the tests then see)
      if (rows.some((r) => params.includes(r.id))) rows = rows.filter((r) => params.includes(r.id));
      const shaP = params.find((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p));
      if (shaP) {
        rows = rows.filter((r) => r.file_sha256 === shaP);
        const std = params.find((p) => p === 'CLSI' || p === 'EUCAST' || p === 'ECOFF');
        if (std) rows = rows.filter((r) => r.standard === std);
        if (/discarded/i.test(text)) rows = rows.filter((r) => !['invalid', 'discarded'].includes(r.status));
      }
      return { rows: rows.map(dto), rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    sets, calls, jobs, state, query,
    seed(over: Row): Row {
      const id = over.id ?? `01950c10-0000-7000-8000-${String(++state.n).padStart(12, '0')}`;
      const row: Row = {
        id, tenant_id: TENANT_A, standard: 'CLSI', standard_version: '2026', title: 'Seeded synthetic', licence_attestation_text: 'Synthetic attestation: seeded test row only.',
        file_bucket: 'micro-imports', file_object_path: `${over.tenant_id ?? TENANT_A}/breakpoints/${id}.csv`, file_sha256: sha(Buffer.from(`seed-${id}`)), file_bytes: 10, status: 'validated',
        version: 1, is_active: true, row_count: 0, band_count: 0, error_count: 0, warning_count: 0, created_at: new Date(NOW), created_by: USER_A, updated_at: new Date(NOW), updated_by: USER_A, ...over,
      };
      sets.push(row);
      return row;
    },
    writes: () => calls.filter((c) => !/^\s*SELECT/i.test(c.text) || /enqueue_job/i.test(c.text)),
  };
}
type Db = ReturnType<typeof makeDb>;

function makeStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const log = { puts: [] as string[], deletes: [] as string[], signed: 0, scans: 0 };
  const storage = {
    async put(bucket: string, path: string, bytes: Uint8Array, opts: { contentType: string; ifAbsent?: boolean }) {
      const k = `${bucket}/${path}`;
      if (opts?.ifAbsent && objects.has(k)) throw new LimsError('common.internal');
      objects.set(k, { bytes: Buffer.from(bytes), contentType: opts.contentType });
      log.puts.push(k);
      return { sha256: sha(bytes), byteSize: bytes.length };
    },
    async read(bucket: string, path: string) { const o = objects.get(`${bucket}/${path}`); if (!o) throw new LimsError('common.not_found'); return new Uint8Array(o.bytes); },
    async delete(bucket: string, path: string) { objects.delete(`${bucket}/${path}`); log.deletes.push(`${bucket}/${path}`); },
    async move() { throw new Error('unexpected move'); },
    async signedUrl() { log.signed++; throw new Error('signed URLs never leave the core (P-2)'); },
  };
  return { objects, log, storage };
}

const PRIVILEGED = new Set([PERM]);
function makeIdentity(grants: readonly string[], aal: 1 | 2) {
  const calls: string[] = [];
  return {
    calls,
    async assertRole(_ctx: unknown, r: { permission: string }) {
      calls.push(r?.permission);
      if (!grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && aal < 2) throw new LimsError('auth.mfa_required');
    },
    async getActor() { return { actor: { type: 'user', id: USER_A }, displayName: 'Synthetic Importer', permissions: [...grants], centreScope: { all: true, centreIds: [] }, isLocked: false }; },
  };
}

function setup(o: { db?: Db; grants?: readonly string[]; aal?: 1 | 2; tenant?: string } = {}) {
  const db = o.db ?? makeDb();
  const tenantId = o.tenant ?? TENANT_A;
  const st = makeStorage();
  const identity = makeIdentity(o.grants ?? [PERM, 'micro.culture.read'], o.aal ?? 2);
  const real = createUploads({ files: { scan: async () => { st.log.scans++; return 'clean' as const; } }, storage: st.storage as never, module: 'micro', tenantId });
  const accepts: any[] = [];
  const uploads = { accept: async (f: any, opts: any) => { accepts.push(opts); return real.accept(f, opts); } };
  const logs: string[] = [];
  const access: Row[] = [];
  const ctx: any = {
    operationId: '', clientIp: '203.0.113.9', tenantId, requestId: '0190c607-0000-7000-8000-000000009001', now: () => new Date(NOW),
    log: { info: (x: unknown) => logs.push(JSON.stringify(x)), warn: (x: unknown) => logs.push(JSON.stringify(x)), error: (x: unknown) => logs.push(JSON.stringify(x)) },
    actor: { type: 'user', id: USER_A, membershipId: '01a1a98a-ac40-7000-8000-00000000a500' },
    tx: { query: db.query },
    ports: { IdentityPort: identity },
    uploads, storage: st.storage, files: { scan: async () => 'clean' },
    audit: { access: async (e: Row) => { access.push(e); } },
    events: { publish: async () => ({ eventId: 'e', duplicate: false }) },
  };
  return { db, ctx, identity, accepts, logs, access, ...st };
}
type S = ReturnType<typeof setup>;

const fileOf = (bytes: Uint8Array = csv(), filename = 'breakpoints.csv', mimeType = 'text/csv') => ({ filename, mimeType, bytes });
const reqFor = (body: unknown, headers: Record<string, string> = { 'idempotency-key': 'k-0001' }) => ({ params: {}, query: {}, headers, body });
const upload = (s: S, over: { metadata?: Row; file?: any; extra?: Row } = {}) =>
  handlers['createBreakpointImport']!(reqFor({ metadata: { ...META, ...(over.metadata ?? {}) }, file: over.file ?? fileOf(), ...(over.extra ?? {}) }), { ...s.ctx, operationId: 'createBreakpointImport' });
const call = (s: S, op: string, req: Partial<{ params: Row; query: Row; headers: Row; body: unknown }> = {}) =>
  handlers[op]!({ params: {}, query: {}, headers: {}, body: undefined, ...req }, { ...s.ctx, operationId: op });
const errOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as any);
const expectErr = async (p: Promise<unknown>, code: string) => { const e = await errOf(p); expect(e, `expected rejection ${code}`).toBeDefined(); expect(e.code).toBe(code); return e; };
/** nothing persisted: no DB write, no object, no job, no audit row. */
const untouched = (s: S) => {
  expect(s.db.writes().map((w) => w.text)).toEqual([]);
  expect(s.objects.size).toBe(0);
  expect(s.db.jobs).toHaveLength(0);
  expect(s.access).toHaveLength(0);
};
const DTO_KEYS = ['id', 'version', 'standard', 'standard_version', 'title', 'licence_attestation_text', 'status', 'file_sha256', 'file_bytes', 'row_count', 'band_count', 'error_count', 'warning_count',
  'intended_effective_from', 'effective_from', 'effective_to', 'imported_by_display', 'created_at', 'activated_by_display', 'activated_at', 'retired_at'];
const T = 20_000;

// ------------------------------------------------------------------ contract pins
describe('C10-T11 contract pins (micro.yaml)', () => {
  const EXPECT = {
    listBreakpointSets: { perm: 'micro.culture.read', idem: 'none' },
    createBreakpointImport: { perm: PERM, idem: 'required' },
    getBreakpointSet: { perm: 'micro.culture.read', idem: 'none' },
    listBreakpointImportIssues: { perm: PERM, idem: 'none' },
    listBreakpointRows: { perm: PERM, idem: 'none' },
    downloadBreakpointTemplate: { perm: PERM, idem: 'none' },
  } as const;
  it.each(Object.keys(EXPECT) as (keyof typeof EXPECT)[])('%s: single x-permission + idempotency class of TRD §5 (D-64: M41/M43 = micro.culture.read)', (id) => {
    const op = specOps()[id];
    expect(op, id).toBeDefined();
    expect(op['x-permission']).toBe(EXPECT[id].perm);
    expect(op['x-idempotency']).toBe(EXPECT[id].idem);
    expect(Object.keys(op).filter((k) => k === 'x-permissions')).toEqual([]);
  });

  it('M42: multipart, x-upload text/csv only, file ≤ 5,242,880 bytes, declares the TRD error codes (incl. auth.mfa_required, 413, 415, micro.breakpoint_import_invalid)', () => {
    const op = specOps()['createBreakpointImport'];
    expect(op['x-upload']).toEqual(['text/csv']);
    const schema = op.requestBody.content['multipart/form-data'].schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.file.maxLength).toBe(MAX);
    expect(schema.properties.metadata.additionalProperties).toBe(false);
    for (const c of ['micro.breakpoint_import_invalid', 'common.payload_too_large', 'common.unsupported_media_type', 'auth.mfa_required', 'auth.forbidden', 'common.idempotency_key_required']) expect(op['x-error-codes'], c).toContain(c);
  });

  it('privileged: contracts/permissions.yaml marks micro.breakpoint.manage privileged (aal2 enforced by IdentityPort.assertRole)', () => {
    const txt = loadSpecText();
    expect(/code: micro\.breakpoint\.manage, privileged: true/.test(txt)).toBe(true);
  });
});
function loadSpecText(): string {
  return readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8');
}

// ------------------------------------------------------------------ AC-12.1 happy path
describe('AC-12.1 createBreakpointImport: set + object + job; the API never parses the file', () => {
  it('201 BreakpointSetDto, status uploaded, intended_effective_from stored and echoed as IsoUtc, no internal columns', async () => {
    const s = setup();
    const bytes = csv();
    const r = await upload(s, { file: fileOf(bytes) });
    expect(r.status).toBe(201);
    const b: any = r.body;
    expect(b.id).toMatch(UUID);
    expect(b).toMatchObject({ standard: 'CLSI', standard_version: '2026', title: META.title, licence_attestation_text: META.licence_attestation_text, status: 'uploaded', file_sha256: sha(bytes), file_bytes: bytes.length, version: 1, row_count: 0, band_count: 0, error_count: 0, warning_count: 0, intended_effective_from: META.intended_effective_from });
    expect(typeof b.imported_by_display).toBe('string');
    expect(b.imported_by_display.length).toBeGreaterThan(0);
    expect(b.created_at).toMatch(ISO);
    expect(Object.keys(b).every((k) => DTO_KEYS.includes(k)), `unexpected keys: ${Object.keys(b)}`).toBe(true);
    for (const k of Object.keys(b)) expect(b[k], k).not.toBeNull(); // no null on the wire (TRD §5 preamble)
    const row = s.db.sets[0]!;
    expect(row).toMatchObject({ id: b.id, tenant_id: TENANT_A, status: 'uploaded', standard: 'CLSI', file_sha256: sha(bytes), file_bytes: bytes.length, created_by: USER_A });
    expect((row.intended_effective_from as Date).toISOString()).toBe(META.intended_effective_from);
  }, T);

  it('intended_effective_from is optional: absent => stored NULL/absent and not in the DTO', async () => {
    const s = setup();
    const { intended_effective_from: _x, ...noIntended } = META;
    const r = await handlers['createBreakpointImport']!(reqFor({ metadata: noIntended, file: fileOf() }), { ...s.ctx, operationId: 'createBreakpointImport' });
    expect(r.status).toBe(201);
    expect((r.body as any).intended_effective_from).toBeUndefined();
    expect(s.db.sets[0]!.intended_effective_from ?? null).toBeNull();
  }, T);

  it('stores the bytes verbatim in bucket micro-imports at {tenant_id}/breakpoints/{set_id}.csv via ctx.uploads.accept (one put, no scan for text/csv), recorded on the row', async () => {
    const s = setup();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv()]); // BOM kept: the API does not touch the content
    const r: any = await upload(s, { file: fileOf(bytes) });
    const path = `${TENANT_A}/breakpoints/${r.body.id}.csv`;
    expect(s.log.puts).toEqual([`micro-imports/${path}`]);
    const o = s.objects.get(`micro-imports/${path}`)!;
    expect(Buffer.compare(o.bytes, bytes)).toBe(0);
    expect(o.contentType).toBe('text/csv');
    expect(s.db.sets[0]).toMatchObject({ file_bucket: 'micro-imports', file_object_path: path });
    expect(s.log.scans).toBe(0);
    expect(s.accepts).toHaveLength(1);
    expect(s.accepts[0]).toMatchObject({ allow: ['text/csv'], maxBytes: MAX, bucket: 'micro-imports', objectPath: path, scan: 'not_applicable' });
  }, T);

  it('enqueues micro.breakpoint_import_validate (job_key = set id, payload {tenant_id, set_id} only) in the SAME transaction, after the insert', async () => {
    const s = setup();
    const r: any = await upload(s);
    expect(s.db.jobs).toHaveLength(1);
    const j = s.db.jobs[0]!;
    const hay = [j.text, ...j.params.map(String)];
    expect(hay.some((h) => h.includes(JOB))).toBe(true);
    expect(j.params.includes(r.body.id), 'job_key = set id').toBe(true);
    const payload = j.params.map((p) => { try { return typeof p === 'string' ? JSON.parse(p) : p; } catch { return undefined; } }).find((p) => p && typeof p === 'object' && !Array.isArray(p));
    expect(payload).toEqual({ tenant_id: TENANT_A, set_id: r.body.id }); // no file name, bytes, attestation, title
    const w = s.db.writes().map((x) => x.text);
    expect(w.findIndex((t) => /enqueue_job/i.test(t))).toBeGreaterThan(w.findIndex((t) => /INSERT INTO (micro\.)?breakpoint_sets/i.test(t)));
    expect(w.findIndex((t) => /INSERT INTO (micro\.)?breakpoint_sets/i.test(t))).toBeGreaterThanOrEqual(0);
  }, T);

  it('a failing enqueue rejects the request (the core rolls the request transaction back); no 201 is returned', async () => {
    const s = setup();
    s.db.state.failEnqueue = true;
    await expect(upload(s)).rejects.toThrow('enqueue failed');
    expect(s.db.calls.some((c) => /enqueue_job/i.test(c.text))).toBe(true);
  }, T);

  it('never parses: a syntactically wrong but UTF-8 file (bad header, garbage) is accepted as uploaded — validation is the job (T-12)', async () => {
    const s = setup();
    const r = await upload(s, { file: fileOf(Buffer.from('not,the,header\nx,y\n"unbalanced quote\n', 'utf8')) });
    expect(r.status).toBe(201);
    expect((r.body as any).status).toBe('uploaded');
    expect(s.db.jobs).toHaveLength(1);
  }, T);

  it('writes one access_log row: breakpoint_set.import / micro_breakpoint_set / set id (TRD §13, S-11)', async () => {
    const s = setup();
    const r: any = await upload(s);
    expect(s.access).toHaveLength(1);
    expect(s.access[0]).toMatchObject({ action: 'breakpoint_set.import', entityType: 'micro_breakpoint_set', entityId: r.body.id });
  }, T);

  it('file content never reaches a SQL parameter, the response, the access log or a log line (T-B4: stored nowhere except the object)', async () => {
    const s = setup();
    const marker = 'PLANTED-CELL-=cmd|calc-9f3a';
    const r: any = await upload(s, { file: fileOf(csv(marker)) });
    const seen = [JSON.stringify(s.db.calls), JSON.stringify(r), JSON.stringify(s.access), s.logs.join('\n')].join('\n');
    expect(seen).not.toContain(marker);
  }, T);
});

// ------------------------------------------------------------------ upload checks
describe('upload checks: 5 MiB cap (413), UTF-8 / NUL (422), type (415), sha256 dedupe (422)', () => {
  it('a file of exactly 5,242,880 bytes is accepted', async () => {
    const s = setup();
    const line = 'x'.repeat(1023) + '\n';
    const bytes = Buffer.alloc(MAX, 0x20);
    for (let i = 0; i + line.length <= MAX; i += line.length) bytes.write(line, i, 'utf8');
    const r = await upload(s, { file: fileOf(bytes) });
    expect(r.status).toBe(201);
    expect((r.body as any).file_bytes).toBe(MAX);
    expect(s.db.sets[0]!.file_bytes).toBe(MAX);
  }, 60_000);

  it('5,242,881 bytes -> 413 common.payload_too_large; nothing stored, no row, no job (S-12)', async () => {
    const s = setup();
    await expectErr(upload(s, { file: fileOf(Buffer.alloc(MAX + 1, 0x61)) }), 'common.payload_too_large');
    untouched(s);
  }, 60_000);

  it.each([
    ['a NUL byte', Buffer.concat([csv(), Buffer.from([0x00]), Buffer.from('tail\n')])],
    ['invalid UTF-8 (lone continuation byte)', Buffer.concat([csv(), Buffer.from([0xc3, 0x28, 0x0a])])],
    ['UTF-16 text', Buffer.from(`${HEADER}\n`, 'utf16le')],
  ])('%s -> 422 micro.breakpoint_import_invalid; nothing stored, no row, no job', async (_n, bytes) => {
    const s = setup();
    await expectErr(upload(s, { file: fileOf(bytes) }), 'micro.breakpoint_import_invalid');
    untouched(s);
  }, T);

  it.each([
    ['extension .xlsx', fileOf(csv(), 'breakpoints.xlsx', 'text/csv')],
    ['extension .pdf', fileOf(csv(), 'breakpoints.pdf', 'application/pdf')],
    ['declared type text/plain', fileOf(csv(), 'breakpoints.csv', 'text/plain')],
    ['double extension .csv.exe', fileOf(csv(), 'breakpoints.csv.exe', 'text/csv')],
  ])('%s -> 415 common.unsupported_media_type; nothing stored', async (_n, file) => {
    const s = setup();
    await expectErr(upload(s, { file }), 'common.unsupported_media_type');
    untouched(s);
  }, T);

  it('AC-12.3 same sha256 + same standard, not discarded/invalid -> 422 micro.breakpoint_import_invalid detail "duplicate file"; no 2nd row/object/job', async () => {
    const s = setup();
    const bytes = csv();
    const first: any = await upload(s, { file: fileOf(bytes) });
    const e = await expectErr(upload(s, { file: fileOf(bytes, 'copy.csv') }), 'micro.breakpoint_import_invalid');
    expect(e.detail).toBe('duplicate file');
    expect(s.db.sets).toHaveLength(1);
    expect(s.db.jobs).toHaveLength(1);
    expect([...s.objects.keys()]).toEqual([`micro-imports/${TENANT_A}/breakpoints/${first.body.id}.csv`]);
  }, T);

  it('the duplicate rule also covers uploaded/validating/validated/active/retired sets of that standard', async () => {
    for (const status of ['uploaded', 'validating', 'validated', 'active', 'retired']) {
      const s = setup();
      const bytes = csv();
      s.db.seed({ file_sha256: sha(bytes), status, standard: 'CLSI', ...(['active', 'retired'].includes(status) ? { effective_from: new Date('2026-01-01T00:00:00Z') } : {}) });
      await expectErr(upload(s, { file: fileOf(bytes) }), 'micro.breakpoint_import_invalid');
      expect(s.db.sets, status).toHaveLength(1);
    }
  }, T);

  it.each(['invalid', 'discarded'])('a %s set with the same sha256 does not block a new upload (AC-12.3 "not discarded/invalid")', async (status) => {
    const s = setup();
    const bytes = csv();
    s.db.seed({ file_sha256: sha(bytes), status, standard: 'CLSI' });
    const r = await upload(s, { file: fileOf(bytes) });
    expect(r.status).toBe(201);
    expect(s.db.sets).toHaveLength(2);
  }, T);

  it('same file under a DIFFERENT standard is not a duplicate', async () => {
    const s = setup();
    const bytes = csv();
    await upload(s, { file: fileOf(bytes) });
    const r = await upload(s, { file: fileOf(bytes), metadata: { standard: 'EUCAST' } });
    expect(r.status).toBe(201);
    expect(s.db.sets).toHaveLength(2);
  }, T);

  it('same file in ANOTHER tenant is not a duplicate and never reveals tenant A\'s set (S-01)', async () => {
    const db = makeDb();
    const bytes = csv();
    db.seed({ tenant_id: TENANT_A, file_sha256: sha(bytes), status: 'active', effective_from: new Date('2026-01-01T00:00:00Z') });
    const b = setup({ db, tenant: TENANT_B });
    const r = await upload(b, { file: fileOf(bytes) });
    expect(r.status).toBe(201);
    expect(db.sets.filter((x) => x.tenant_id === TENANT_B)).toHaveLength(1);
    expect(b.log.puts[0]).toContain(`micro-imports/${TENANT_B}/breakpoints/`);
  }, T);

  it('two identical uploads racing -> exactly one 201 and one 422 micro.breakpoint_import_invalid (unique index violation mapped, never 500); one set, one job, one object', async () => {
    const db = makeDb();
    const a = setup({ db });
    const b = setup({ db });
    const bytes = csv();
    const out = await Promise.allSettled([upload(a, { file: fileOf(bytes) }), upload(b, { file: fileOf(bytes) })]);
    const ok = out.filter((o) => o.status === 'fulfilled');
    const bad = out.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0]!.reason as any).code).toBe('micro.breakpoint_import_invalid');
    expect(db.sets).toHaveLength(1);
    expect(db.jobs).toHaveLength(1);
    const winner = (ok[0] as PromiseFulfilledResult<any>).value.body.id;
    const remaining = [...a.objects.keys(), ...b.objects.keys()];
    expect(remaining, 'the loser must not leave an orphan object').toEqual([`micro-imports/${TENANT_A}/breakpoints/${winner}.csv`]);
  }, T);
});

// ------------------------------------------------------------------ strict input (S-05)
describe('M42 strict metadata/body validation -> 400 common.validation_failed; nothing persisted', () => {
  const BAD: Array<[string, Row]> = [
    ['unknown standard', { metadata: { standard: 'FOO' } }],
    ['lower-case standard', { metadata: { standard: 'clsi' } }],
    ['empty standard_version', { metadata: { standard_version: '' } }],
    ['standard_version 33 chars', { metadata: { standard_version: 'v'.repeat(33) } }],
    ['numeric standard_version', { metadata: { standard_version: 2026 } }],
    ['empty title', { metadata: { title: '' } }],
    ['title 121 chars', { metadata: { title: 't'.repeat(121) } }],
    ['attestation 19 chars', { metadata: { licence_attestation_text: 'a'.repeat(19) } }],
    ['attestation 501 chars', { metadata: { licence_attestation_text: 'a'.repeat(501) } }],
    ['attestation missing', { metadata: { licence_attestation_text: undefined } }],
    ['intended_effective_from not IsoUtc', { metadata: { intended_effective_from: '2026-01-15' } }],
    ['forged status in metadata', { metadata: { status: 'active' } }],
    ['forged tenant_id in metadata', { metadata: { tenant_id: TENANT_B } }],
    ['forged created_by in metadata', { metadata: { created_by: USER_A } }],
    ['unknown top-level field', { extra: { status: 'validated' } }],
    ['file not an object', { file: 'a,b,c' }],
    ['file bytes not binary', { file: { filename: 'a.csv', mimeType: 'text/csv', bytes: 'a,b,c' } }],
  ];
  it.each(BAD)('%s', async (_n, over) => {
    const s = setup();
    const e = await expectErr(upload(s, over as never), 'common.validation_failed');
    expect(JSON.stringify(e.detail ?? e.extra ?? '')).not.toContain(META.licence_attestation_text);
    untouched(s);
  }, T);

  it('metadata missing entirely -> 400', async () => {
    const s = setup();
    await expectErr(handlers['createBreakpointImport']!(reqFor({ file: fileOf() }), { ...s.ctx, operationId: 'createBreakpointImport' }), 'common.validation_failed');
    untouched(s);
  }, T);

  it('file missing entirely -> 400', async () => {
    const s = setup();
    await expectErr(handlers['createBreakpointImport']!(reqFor({ metadata: META }), { ...s.ctx, operationId: 'createBreakpointImport' }), 'common.validation_failed');
    untouched(s);
  }, T);

  it('the stored path never comes from the client: hostile filename / metadata cannot choose the object path (S-15, T-B6)', async () => {
    const s = setup();
    const r: any = await upload(s, { file: fileOf(csv(), `../../${TENANT_B}/breakpoints/steal.csv`) });
    expect(s.log.puts).toEqual([`micro-imports/${TENANT_A}/breakpoints/${r.body.id}.csv`]);
    expect(s.log.puts[0]).not.toContain(TENANT_B);
    expect(s.log.puts[0]).not.toContain('steal');
  }, T);
});

// ------------------------------------------------------------------ permission + MFA (AC-12.5, S-10, T-B1)
describe('AC-12.5 / S-10 privileged: permission and aal2 are asserted FIRST, before any body validation, storage or SQL', () => {
  it('M42 at aal1 -> 403 auth.mfa_required; nothing stored, no row, no job, no access row (AC-12.5)', async () => {
    const s = setup({ aal: 1 });
    await expectErr(upload(s), 'auth.mfa_required');
    expect(s.identity.calls).toEqual([PERM]);
    untouched(s);
  }, T);

  it('M42 without micro.breakpoint.manage (even with culture.read, at aal2) -> 403 auth.forbidden; nothing written', async () => {
    const s = setup({ grants: ['micro.culture.read', 'micro.culture.work', 'micro.config.manage'] });
    await expectErr(upload(s), 'auth.forbidden');
    untouched(s);
  }, T);

  it('permission check precedes validation: an invalid body at aal1 / without permission still answers mfa_required / forbidden, never 400 or 422', async () => {
    const a = setup({ aal: 1 });
    await expectErr(upload(a, { metadata: { standard: 'FOO' }, file: fileOf(Buffer.from([0])) }), 'auth.mfa_required');
    const b = setup({ grants: [] });
    await expectErr(upload(b, { metadata: { standard: 'FOO' }, file: fileOf(Buffer.from([0])) }), 'auth.forbidden');
    expect(a.db.calls).toHaveLength(0);
    expect(b.db.calls).toHaveLength(0);
  }, T);

  it('a membership revoked after token issue (assertRole rejects) -> the rejection passes through, nothing written (S-10)', async () => {
    const s = setup();
    s.ctx.ports.IdentityPort.assertRole = async () => { throw new LimsError('auth.forbidden'); };
    await expectErr(upload(s), 'auth.forbidden');
    untouched(s);
  }, T);

  it('a missing IdentityPort fails closed (no way to ask, so no)', async () => {
    const s = setup();
    s.ctx.ports = {};
    const e = await errOf(upload(s));
    expect(e?.code).toBe('auth.forbidden');
    untouched(s);
  }, T);

  it.each([
    ['listBreakpointImportIssues', { params: { set_id: '01950c10-0000-7000-8000-000000000001' } }],
    ['listBreakpointRows', { params: { set_id: '01950c10-0000-7000-8000-000000000001' } }],
    ['downloadBreakpointTemplate', {}],
  ])('%s (micro.breakpoint.manage, privileged): aal1 -> auth.mfa_required, no permission -> auth.forbidden, asserted before any SQL', async (op, req) => {
    const a = setup({ aal: 1 });
    await expectErr(call(a, op, req), 'auth.mfa_required');
    expect(a.identity.calls).toEqual([PERM]);
    expect(a.db.calls).toHaveLength(0);
    const b = setup({ grants: ['micro.culture.read'] });
    await expectErr(call(b, op, req), 'auth.forbidden');
    expect(b.db.calls).toHaveLength(0);
  }, T);

  it.each([
    ['listBreakpointSets', {}],
    ['getBreakpointSet', { params: { set_id: '01950c10-0000-7000-8000-000000000001' } }],
  ])('%s needs micro.culture.read ONLY (no aal2, no breakpoint.manage): works at aal1 for a technologist; forbidden without it', async (op, req) => {
    const s = setup({ grants: ['micro.culture.read'], aal: 1 });
    s.db.seed({ id: '01950c10-0000-7000-8000-000000000001', status: 'active', effective_from: new Date('2026-01-01T00:00:00Z') });
    const r = await call(s, op, req);
    expect(r.status).toBe(200);
    expect(s.identity.calls).toEqual(['micro.culture.read']);
    const n = setup({ grants: [PERM] });
    await expectErr(call(n, op, req), 'auth.forbidden');
  }, T);
});

// ------------------------------------------------------------------ M41 / M43 / M44 / M45 reads
describe('M41 listBreakpointSets / M43 getBreakpointSet / M44 / M45', () => {
  const A1 = '01950c10-0000-7000-8000-0000000000a1';
  const B1 = '01950c10-0000-7000-8000-0000000000b1';
  const withData = () => {
    const db = makeDb();
    db.seed({ id: A1, tenant_id: TENANT_A, status: 'validated', intended_effective_from: new Date('2026-02-01T00:00:00Z') });
    db.seed({ id: '01950c10-0000-7000-8000-0000000000a2', tenant_id: TENANT_A, status: 'active', effective_from: new Date('2026-01-01T00:00:00Z') });
    db.seed({ id: B1, tenant_id: TENANT_B, status: 'validated', title: 'TENANT-B-SECRET-TITLE' });
    return db;
  };

  it('M41 returns only the caller tenant\'s sets as {data:[BreakpointSetDto], page}; no tenant B row, no storage path, SQL carries the tenant id', async () => {
    const s = setup({ db: withData() });
    const r: any = await call(s, 'listBreakpointSets', { query: { standard: 'CLSI', status: 'validated,active', limit: '50' } });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data.map((d: any) => d.id).sort()).toEqual([A1, '01950c10-0000-7000-8000-0000000000a2']);
    for (const d of r.body.data) expect(Object.keys(d).every((k) => DTO_KEYS.includes(k)), Object.keys(d).join()).toBe(true);
    expect(r.body.page).toBeDefined();
    expect(JSON.stringify(r.body)).not.toContain('TENANT-B-SECRET-TITLE');
    expect(JSON.stringify(r.body)).not.toContain('micro-imports');
    const sel = s.db.calls.filter((c) => /breakpoint_sets/i.test(c.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const c of sel) expect(c.params, c.text).toContain(TENANT_A);
  }, T);

  it('M43 returns the DTO of an own set with an ETag-able version', async () => {
    const s = setup({ db: withData() });
    const r: any = await call(s, 'getBreakpointSet', { params: { set_id: A1 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: A1, status: 'validated', version: 1, standard: 'CLSI' });
    expect(r.body.intended_effective_from).toBe('2026-02-01T00:00:00.000Z');
    expect(r.body.created_at).toMatch(ISO);
  }, T);

  it.each([
    ['getBreakpointSet', 'micro.culture.read'],
    ['listBreakpointImportIssues', PERM],
    ['listBreakpointRows', PERM],
  ])('S-01 %s: tenant B set id as tenant A -> 404 common.not_found, no tenant B data in the error', async (op, perm) => {
    const s = setup({ db: withData(), grants: [perm] });
    const e = await expectErr(call(s, op, { params: { set_id: B1 } }), 'common.not_found');
    expect(JSON.stringify([e.message, e.detail, e.extra])).not.toContain('TENANT-B-SECRET-TITLE');
    expect(JSON.stringify(s.db.writes())).toBe('[]');
  }, T);

  it('S-01 a set id that does not exist -> 404 common.not_found (identical to the cross-tenant case)', async () => {
    const s = setup({ db: withData() });
    await expectErr(call(s, 'getBreakpointSet', { params: { set_id: '01950c10-0000-7000-8000-00000000ffff' } }), 'common.not_found');
  }, T);

  it.each(['listBreakpointImportIssues', 'listBreakpointRows'])('%s on an own set with no issues/rows answers 200 with an empty data page (no side effect)', async (op) => {
    const s = setup({ db: withData() });
    const r: any = await call(s, op, { params: { set_id: A1 } });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(s.db.writes()).toEqual([]);
  }, T);
});

// ------------------------------------------------------------------ M49 template
describe('M49 downloadBreakpointTemplate (§9.1): header + two comment lines, NO values (S-13, S-14)', () => {
  const text = (b: unknown) => (typeof b === 'string' ? b : Buffer.from(b as Uint8Array).toString('utf8'));
  it('200 text/csv attachment, no-store; exactly the header and the two comment lines', async () => {
    const s = setup();
    const r: any = await call(s, 'downloadBreakpointTemplate');
    expect(r.status).toBe(200);
    const h = Object.fromEntries(Object.entries<string>(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['content-type']).toMatch(/^text\/csv/);
    expect(h['content-disposition']).toBe('attachment; filename="breakpoint-template.csv"');
    expect(h['cache-control']).toBe('no-store');
    const lines = text(r.body).split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toEqual([HEADER, '# One line per interpretive band; see the user manual.', '# This file must contain only breakpoint data your laboratory is licensed to use.']);
    expect(s.db.calls).toHaveLength(0);
    expect(s.access).toHaveLength(0);
  }, T);
});
