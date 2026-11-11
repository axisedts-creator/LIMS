// FD-T10 live-DB behaviour of frontdesk.trf_scan and frontdesk.trf_draft_purge (02-TRD §10; 05-SCHEMA §3 trf_attachments lifecycle guard + DEFINER purge_trf_drafts; 07-SECURITY REQ-SEC-024/083/084;
// 08 A13 P-2 no Storage URL, P-12 a E-class delete). Needs LIMS_TEST_DATABASE_URL (superuser URL of a migrated + seeded DB; tests/frontdesk/FD-T10.pg.sh exports it): missing = HARD FAILURE, never a skip.
// Tasks run through a hand-built JobContext whose tx is a pg client in a transaction with system claims (FD-T07 / BL-T13 pattern). Superuser bypasses RLS, so tenant isolation here can only come from
// the task's own explicit tenant_id predicates. ctx.storage is an in-memory fake with the REAL core bucket-owner + tenant-path rules; ctx.files is a fake scanner (EICAR => infected).
// ASSUMED (spec silent): see trf.wiring.test.ts. Scan: a row that is not `pending` is final (redelivery = no-op); an unreadable object / unavailable scanner throws until the last attempt, then `failed`;
// a clean PDF/PNG is moved to {tenant}/{yyyy}/{mm}/{id}[.ext] (no `q/`), sha256 = hash of the stored bytes; infected stays under q/ and is never moved or deleted.
// Metric `lims_frontdesk_trf_scans_total{outcome}` (02-TRD §15). Purge: drafts = order_id IS NULL older than the 24 h TTL, ≤ 1000 per run, objects deleted BEFORE the DEFINER removes the rows.
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertOwned, assertTenantPath } from '../../../../../api/src/core/storage/index.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'];
const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001', TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
const CENTRE = { a: '01a1a98a-ac40-7000-8000-00000000a201', b: '01a1a98a-ac40-7000-8000-00000000b201' } as const;
const BRANCH_A = '01a1a98a-ac40-7000-8000-00000000a101';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const SCAN = 'frontdesk.trf_scan', PURGE = 'frontdesk.trf_draft_purge';
const METRIC = 'lims_frontdesk_trf_scans_total';
const TAG = 'FDT10LIVE';                                              // file-name prefix of every fixture row (cleanup + P2 log probe)
const BUCKET = 'frontdesk-trf';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const pdf = (x = '') => Buffer.from(`%PDF-1.4\n% synthetic ${x}\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGNgGAWjYBSMglEAAAQAAAEswKmyAAAAAElFTkSuQmCC', 'base64');
const uid = () => randomUUID();
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function makeStore(tenant = TENANT_A) {
  const objects = new Map<string, Buffer>(); const calls: Array<{ op: string; path: string }> = []; const failDelete = new Set<string>();
  const adapter = {
    async read(bucket: any, path: string) { assertTenantPath(tenant, path); calls.push({ op: 'read', path }); const v = objects.get(path); if (!v) throw new Error('missing'); return new Uint8Array(v); },
    async put(bucket: any, path: string, bytes: Uint8Array) { assertOwned('frontdesk', bucket); assertTenantPath(tenant, path); calls.push({ op: 'put', path }); objects.set(path, Buffer.from(bytes)); return { sha256: sha(bytes), byteSize: bytes.length }; },
    async move(bucket: any, from: string, to: string) { assertOwned('frontdesk', bucket); assertTenantPath(tenant, from); assertTenantPath(tenant, to); calls.push({ op: 'move', path: `${from} -> ${to}` }); const v = objects.get(from); if (!v) throw new Error('missing'); objects.delete(from); objects.set(to, v); },
    async delete(bucket: any, path: string) { assertOwned('frontdesk', bucket); assertTenantPath(tenant, path); if (failDelete.has(path)) throw new Error('storage down'); calls.push({ op: 'delete', path }); objects.delete(path); },
    async signedUrl() { calls.push({ op: 'signedUrl', path: '' }); return 'https://storage.invalid/SECRET'; },
  };
  return { adapter, objects, calls, failDelete, of: (op: string) => calls.filter((c) => c.op === op) };
}
type Store = ReturnType<typeof makeStore>;
function makeScanner() {
  const s = { mode: 'auto' as 'auto' | 'clean' | 'infected' | 'unavailable' | 'throw', calls: 0, seen: [] as Buffer[] };
  const scan = async (bytes: Uint8Array) => {
    s.calls++; s.seen.push(Buffer.from(bytes)); if (s.mode === 'throw') throw new Error('clamd down'); if (s.mode !== 'auto') return s.mode;
    return Buffer.from(bytes).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'infected' as const : 'clean' as const;
  };
  return Object.assign(s, { scan });
}

describe('FD-T10 frontdesk.trf_scan + trf_draft_purge over a real DB', () => {
  let su: any; let manifest: any;
  const claims = (tenant: string) => JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'system' });
  async function inTx<T>(tenant: string, fn: (c: any) => Promise<T>): Promise<T> {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims(tenant)]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  /** Lists only the given columns so column defaults apply to the rest. */
  async function seed(table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row).map((c) => `"${c}"`).join(',');
    await inTx(String(row['tenant_id']), (c) => c.query(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]));
  }
  async function trf(o: { id?: string; tenant?: string; state?: string; orderId?: string | null; path?: string; mime?: string; ageH?: number; name?: string; bytes?: Uint8Array } = {}) {
    const tenant = o.tenant ?? TENANT_A; const id = o.id ?? uid(); const ext = (o.mime ?? 'application/pdf') === 'image/png' ? 'png' : 'pdf';
    const row = { id, tenant_id: tenant, centre_id: tenant === TENANT_A ? CENTRE.a : CENTRE.b, order_id: o.orderId ?? null, object_path: o.path ?? `${tenant}/q/2026/11/${id}.${ext}`,
      original_filename: `${TAG}-${o.name ?? id}.${ext}`, mime_type: o.mime ?? 'application/pdf', size_bytes: o.bytes?.length ?? 100, sha256: sha(o.bytes ?? id), scan_state: o.state ?? 'pending',
      ...(o.ageH !== undefined ? { created_at: ago(o.ageH), updated_at: ago(o.ageH) } : {}), created_by: SYS, updated_by: SYS };
    await seed('frontdesk.trf_attachments', row);
    return row;
  }
  /** pending row + its object in the store. */
  async function pending(store: Store, bytes: Buffer, o: { mime?: string; tenant?: string; state?: string } = {}) {
    const row = await trf({ ...o, bytes });
    store.objects.set(row.object_path, bytes);
    return row;
  }
  const get = async (id: string) => (await su.query('SELECT * FROM frontdesk.trf_attachments WHERE id = $1', [id])).rows[0];
  async function run(task: string, tenantCtx: string, payload: Record<string, unknown>, o: { store?: Store; scanner?: ReturnType<typeof makeScanner>; attempt?: number; maxAttempts?: number } = {}) {
    const store = o.store ?? makeStore(); const scanner = o.scanner ?? makeScanner();
    const logs: string[] = []; const metrics: Array<[string, any]> = [];
    let threw: any;
    try {
      await inTx(tenantCtx, async (c) => {
        const ctx: any = {
          tenantId: tenantCtx, tx: c, actor: { type: 'system', id: SYS }, requestId: uid(), attempt: o.attempt ?? 1, maxAttempts: o.maxAttempts ?? 5, jobId: '1', now: () => new Date().toISOString(), isNewer: () => true,
          events: {}, core: {}, audit: {}, storage: store.adapter, files: { scan: scanner.scan },
          log: { info: (x: object) => logs.push(JSON.stringify(x)), warn: (x: object) => logs.push(JSON.stringify(x)), error: (x: object) => logs.push(JSON.stringify(x)), debug() {}, child() { return this; } },
          metrics: { inc: (n: string, l: any) => metrics.push([n, l]), set() {}, observe() {} },
        };
        ctx.db = { tx: async (fn: any) => fn(ctx) };
        await manifest.tasks[task](payload, ctx);
      });
    } catch (e) { threw = e; }
    return { store, scanner, logs, metrics, threw };
  }
  async function cleanup() {
    for (const t of [TENANT_A, TENANT_B]) await inTx(t, (c) => c.query(`DELETE FROM frontdesk.trf_attachments WHERE tenant_id = $1 AND original_filename LIKE '${TAG}%'`, [t]));
  }

  beforeAll(async () => {
    if (!SU) throw new Error('LIMS_TEST_DATABASE_URL is not set: run .orchestra\\notes\\FD-T10-verify.cmd (boots PG17 via docker) or export the superuser URL of a migrated + seeded DB');
    const pg: any = createRequire(join(import.meta.dirname, '../../../../../api/package.json'))('pg');   // pg lives in services/api (the worker has no pg dependency)
    su = new (pg.default ?? pg).Pool({ connectionString: SU, max: 4 });
    manifest = (await import('../index.js')).manifest;
    await cleanup();
  });
  afterAll(async () => { if (su) { await cleanup(); await su.end(); } });

  describe('trf_scan', () => {
    it('clean PDF: scanner sees the STORED bytes; row -> clean (+scanned_at); object moved out of q/ to {tenant}/{yyyy}/{mm}/{id}; old key gone; sha256 = hash of the stored bytes; metric clean; no URL', async () => {
      const store = makeStore(); const bytes = pdf('clean'); const row = await pending(store, bytes);
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store });
      expect(r.threw).toBeUndefined();
      expect(r.scanner.calls).toBe(1);
      expect(r.scanner.seen[0]!.equals(bytes)).toBe(true);
      const after = await get(row.id);
      expect(after.scan_state).toBe('clean');
      expect(after.scanned_at).not.toBeNull();
      expect(after.updated_by).toBe(SYS);
      expect(after.object_path).toMatch(new RegExp(`^${TENANT_A}/\\d{4}/\\d{2}/${row.id}(\\.pdf)?$`));
      expect(after.object_path).not.toContain('/q/');
      expect(store.objects.has(row.object_path), 'old quarantine key removed').toBe(false);
      const stored = store.objects.get(after.object_path)!;
      expect(stored, 'object at the final key').toBeDefined();
      expect(stored.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(after.sha256).toBe(sha(stored));
      expect(r.metrics).toContainEqual([METRIC, { outcome: 'clean' }]);
      expect(store.of('signedUrl')).toEqual([]);
      expect(r.logs.join('\n')).not.toContain(TAG);
    }, 60_000);

    it('clean PNG: moved unchanged (images were already re-encoded at upload)', async () => {
      const store = makeStore(); const bytes = png(); const row = await pending(store, bytes, { mime: 'image/png' });
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store });
      expect(r.threw).toBeUndefined();
      const after = await get(row.id);
      expect(after.scan_state).toBe('clean');
      expect(store.objects.get(after.object_path)!.equals(bytes)).toBe(true);
      expect(after.sha256).toBe(sha(bytes));
    }, 60_000);

    it.each([
      ['EICAR test file', () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(EICAR, 'latin1'), Buffer.from('\n%%EOF\n')])],
      ['polyglot PDF + script + EICAR', () => Buffer.concat([pdf('poly'), Buffer.from(`\n<script>${EICAR}</script>`, 'latin1')])],
    ])('%s: row -> quarantined; object stays under {tenant}/q/ untouched (never moved, never deleted, never served); metric quarantined; warn log without file name', async (_n, make) => {
      const store = makeStore(); const bytes = make(); const row = await pending(store, bytes);
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store });
      expect(r.threw).toBeUndefined();
      const after = await get(row.id);
      expect(after.scan_state).toBe('quarantined');
      expect(after.scanned_at).not.toBeNull();
      expect(after.object_path).toBe(row.object_path);
      expect(after.object_path).toContain(`${TENANT_A}/q/`);
      expect(store.objects.get(row.object_path)!.equals(bytes)).toBe(true);
      expect(store.of('move')).toEqual([]); expect(store.of('delete')).toEqual([]);
      expect(r.metrics).toContainEqual([METRIC, { outcome: 'quarantined' }]);
      expect(r.metrics.some(([, l]) => l.outcome === 'clean')).toBe(false);
      expect(r.logs.join('\n')).not.toContain(TAG);
    }, 60_000);

    it.each([['unavailable' as const], ['throw' as const]])('scanner %s on a non-final attempt: the task THROWS (graphile retries), the row stays pending, nothing moved (fail closed, never clean)', async (mode) => {
      const store = makeStore(); const scanner = makeScanner(); scanner.mode = mode; const row = await pending(store, pdf('retry'));
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store, scanner, attempt: 2, maxAttempts: 5 });
      expect(r.threw).toBeDefined();
      expect((await get(row.id)).scan_state).toBe('pending');
      expect(store.of('move')).toEqual([]);
      expect(store.objects.has(row.object_path)).toBe(true);
    }, 60_000);

    it('scanner unavailable on the LAST attempt: row -> failed (UI offers re-upload), metric failed, object untouched, task resolves', async () => {
      const store = makeStore(); const scanner = makeScanner(); scanner.mode = 'unavailable'; const row = await pending(store, pdf('last'));
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store, scanner, attempt: 5, maxAttempts: 5 });
      expect(r.threw).toBeUndefined();
      const after = await get(row.id);
      expect(after.scan_state).toBe('failed');
      expect(after.object_path).toBe(row.object_path);
      expect(store.of('move')).toEqual([]);
      expect(r.metrics).toContainEqual([METRIC, { outcome: 'failed' }]);
    }, 60_000);

    it('object missing from the store: throws on a non-final attempt, row -> failed on the last; never clean', async () => {
      const store = makeStore(); const row = await trf({});
      const a = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store, attempt: 1, maxAttempts: 5 });
      expect(a.threw).toBeDefined();
      expect((await get(row.id)).scan_state).toBe('pending');
      const b = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store, attempt: 5, maxAttempts: 5 });
      expect(b.threw).toBeUndefined();
      expect((await get(row.id)).scan_state).toBe('failed');
    }, 60_000);

    it.each(['clean', 'quarantined', 'failed'])('redelivery for a row already %s: no scan, no storage call, row unchanged (final states stay final)', async (state) => {
      const store = makeStore(); const row = await trf({ state, path: state === 'clean' ? `${TENANT_A}/2026/11/${uid()}.pdf` : undefined });
      await inTx(TENANT_A, (c) => c.query('UPDATE frontdesk.trf_attachments SET scanned_at = now() WHERE id = $1', [row.id]));
      const before = await get(row.id);
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: row.id }, { store });
      expect(r.threw).toBeUndefined();
      expect(r.scanner.calls).toBe(0); expect(store.calls).toEqual([]);
      const after = await get(row.id);
      expect([after.scan_state, after.object_path, after.sha256, after.version]).toEqual([before.scan_state, before.object_path, before.sha256, before.version]);
    }, 60_000);

    it('REQ-SEC-024: a job of tenant A naming a tenant B attachment touches nothing (superuser bypasses RLS: only the task\'s tenant predicate protects B)', async () => {
      const store = makeStore(); const theirs = await pending(store, pdf('theirs'), { tenant: TENANT_B });
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: theirs.id }, { store });
      expect(r.scanner.calls).toBe(0);
      expect(store.of('move')).toEqual([]);
      const after = await get(theirs.id);
      expect(after.scan_state).toBe('pending');
      expect(after.object_path).toBe(theirs.object_path);
      expect(store.objects.has(theirs.object_path)).toBe(true);
    }, 60_000);

    it('an unknown attachment id changes nothing (no scan, no storage call, no new row)', async () => {
      const store = makeStore(); const before = (await su.query(`SELECT count(*)::int AS n FROM frontdesk.trf_attachments WHERE tenant_id = $1`, [TENANT_A])).rows[0].n;
      const r = await run(SCAN, TENANT_A, { tenant_id: TENANT_A, attachment_id: uid() }, { store });
      expect(r.scanner.calls).toBe(0); expect(store.calls).toEqual([]);
      expect((await su.query(`SELECT count(*)::int AS n FROM frontdesk.trf_attachments WHERE tenant_id = $1`, [TENANT_A])).rows[0].n).toBe(before);
    }, 60_000);
  });

  describe('trf_draft_purge', () => {
    const rowsLeft = async (ids: string[]) => (await su.query('SELECT id FROM frontdesk.trf_attachments WHERE id = ANY($1::uuid[])', [ids])).rows.map((r: any) => r.id);
    async function order(): Promise<string> {
      const p = { id: uid(), tenant_id: TENANT_A, patient_code: `FDT10-${Date.now() % 1e8}-${Math.floor(Math.random() * 1e6)}`, full_name: 'Fdt Ten Synthetic', name_search: 'fdt ten synthetic', sex: 'female',
        birth_on: '1990-01-01', phone_e164: '+9779800000010', source: 'front_desk', registered_centre_id: CENTRE.a, created_by: SYS, updated_by: SYS };
      await seed('frontdesk.patients', p);
      const o = { id: uid(), tenant_id: TENANT_A, branch_id: BRANCH_A, centre_id: CENTRE.a, patient_id: p.id, registration_no: `FDT10-${Date.now() % 1e8}-${Math.floor(Math.random() * 1e6)}`, status: 'registered',
        visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: true, catalog_revision: 1, registered_at: ago(100), created_by: SYS, updated_by: SYS };
      await seed('frontdesk.orders', o);
      return o.id;
    }

    it('purges only drafts (order_id IS NULL) older than the 24 h TTL of the job tenant: objects deleted first, rows removed; recent drafts, linked TRFs and other tenants survive', async () => {
      const store = makeStore(); const orderId = await order();
      const mk = async (o: Parameters<typeof trf>[0]) => { const r = await trf(o); store.objects.set(r.object_path, pdf(r.id)); return r; };
      const old30 = await mk({ ageH: 30 }), old72 = await mk({ ageH: 72, state: 'clean', path: `${TENANT_A}/2026/11/${uid()}.pdf` }), oldQ = await mk({ ageH: 50, state: 'quarantined' });
      const recent1 = await mk({ ageH: 1 }), recent12 = await mk({ ageH: 12 });
      const linkedOld = await mk({ ageH: 72, orderId, state: 'clean', path: `${TENANT_A}/2026/11/${uid()}.pdf` });
      const otherTenant = await mk({ ageH: 72, tenant: TENANT_B });
      const r = await run(PURGE, TENANT_A, { tenant_id: TENANT_A }, { store });
      expect(r.threw).toBeUndefined();
      const gone = [old30, old72, oldQ], kept = [recent1, recent12, linkedOld, otherTenant];
      expect(await rowsLeft(gone.map((x) => x.id))).toEqual([]);
      expect((await rowsLeft(kept.map((x) => x.id))).sort()).toEqual(kept.map((x) => x.id).sort());
      expect(store.of('delete').map((c) => c.path).sort()).toEqual(gone.map((x) => x.object_path).sort());
      for (const g of gone) expect(store.objects.has(g.object_path), `object of purged draft ${g.id}`).toBe(false);
      for (const k of kept) expect(store.objects.has(k.object_path), `object of kept row ${k.id}`).toBe(true);
      expect(store.of('signedUrl')).toEqual([]);
      expect(r.logs.join('\n')).not.toContain(TAG);
      const again = await run(PURGE, TENANT_A, { tenant_id: TENANT_A }, { store });      // idempotent: a second run deletes nothing more
      expect(again.threw).toBeUndefined();
      expect(store.of('delete')).toHaveLength(gone.length);
    }, 60_000);

    it('a failed object delete keeps its ROW (object and row never diverge: the next run retries); the other drafts are still purged', async () => {
      const store = makeStore(); const a = await trf({ ageH: 40 }), b = await trf({ ageH: 41 }), c = await trf({ ageH: 42 });
      for (const x of [a, b, c]) store.objects.set(x.object_path, pdf(x.id));
      store.failDelete.add(b.object_path);
      await run(PURGE, TENANT_A, { tenant_id: TENANT_A }, { store });
      expect(await rowsLeft([a.id, b.id, c.id])).toEqual([b.id]);
      expect(store.objects.has(b.object_path)).toBe(true);
      store.failDelete.clear();
      const retry = await run(PURGE, TENANT_A, { tenant_id: TENANT_A }, { store });
      expect(retry.threw).toBeUndefined();
      expect(await rowsLeft([b.id])).toEqual([]);
      expect(store.objects.has(b.object_path)).toBe(false);
    }, 60_000);

    it('≤ 1000 drafts per run (the DEFINER refuses more): 1005 expired drafts -> first run purges at most 1000 without error, the next run drains the rest', async () => {
      const store = makeStore(); const name = `${TAG}-bulk`;
      await inTx(TENANT_A, (c) => c.query(
        `INSERT INTO frontdesk.trf_attachments (id, tenant_id, centre_id, object_path, original_filename, mime_type, size_bytes, sha256, scan_state, created_at, updated_at, created_by, updated_by)
         SELECT g.id, $1::uuid, $2::uuid, $5::text || '/' || g.id::text, $3::text || '-' || g.id::text || '.pdf', 'application/pdf', 100, repeat('a', 64), 'pending', now() - interval '60 hours', now() - interval '60 hours', $4::uuid, $4::uuid
           FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 1005)) g`, [TENANT_A, CENTRE.a, name, SYS, TENANT_A]));
      const count = async () => (await su.query(`SELECT count(*)::int AS n FROM frontdesk.trf_attachments WHERE tenant_id = $1 AND original_filename LIKE $2`, [TENANT_A, `${name}%`])).rows[0].n;
      expect(await count()).toBe(1005);
      const r1 = await run(PURGE, TENANT_A, { tenant_id: TENANT_A }, { store });
      expect(r1.threw, 'a batch over 1000 would raise purge_trf_drafts_invalid_input').toBeUndefined();
      const left = await count();
      expect(left).toBeGreaterThanOrEqual(5); expect(left).toBeLessThan(1005);
      const r2 = await run(PURGE, TENANT_A, { tenant_id: TENANT_A }, { store });
      expect(r2.threw).toBeUndefined();
      expect(await count()).toBe(0);
    }, 120_000);

    it('REQ-SEC-024: the purge of tenant A never selects or deletes tenant B drafts (nor their objects), even with B\'s id in the payload', async () => {
      const store = makeStore(); const theirs = await trf({ ageH: 100, tenant: TENANT_B }); store.objects.set(theirs.object_path, pdf('b'));
      await run(PURGE, TENANT_A, { tenant_id: TENANT_A }, { store });
      await run(PURGE, TENANT_A, { tenant_id: TENANT_B }, { store });
      expect(await rowsLeft([theirs.id])).toEqual([theirs.id]);
      expect(store.objects.has(theirs.object_path)).toBe(true);
      expect(store.of('delete').map((c) => c.path)).not.toContain(theirs.object_path);
    }, 60_000);
  });
});
