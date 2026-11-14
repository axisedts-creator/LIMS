// C10 T-18 — the three cron tasks against the migrated database (06-IMPLEMENTATION-PLAN row T-18; 02-TRD §9; 05-SCHEMA §8 purge policy + cultures_guard + checks;
// 01-PRD AC-17.1, AC-08.12; 07-SECURITY P-6, RLS; 08 A13 P-6, A17 D-65). Proves the filters the recording-tx test cannot: active + older than 24 h, status, chain_cancelled idempotence,
// batch progress, expires_at < now() under the DELETE policy, the AST-reference skip, tenant isolation, batches of 1,000.
// Needs the micro DDL + RLS applied: LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under
// LIMS_T18_REQUIRE_DB=1 where "database is provided" fails. (Same harness status as T-05..T-16.)
// SEAMS: as chainJobs.test.ts (handlers `reconcileChainStatus` / `refreshMetrics` / `purgeInstrumentRecords`; ctx.tx = ONE transaction per job under the SYSTEM claims of the tenant;
//   ctx.ports.LabPort = hand fake over the seeded world; ctx.metrics.inc / .set recorded). Parent rows are seeded by `seedRow` (admin, replica role, type-based filler) exactly as in T-14/T-16.
// ASSUMED (flagged so a ruling can overrule): "older than 24 h" is measured on received_at (the seeded rows move created_at with it); "active" = status <> 'cancelled' (submitted-version cultures are
//   examined, they are only flagged); a culture already flagged chain_cancelled = true is no longer selected (otherwise a batch of flagged cultures would starve the rest);
//   the cancel also sets cancelled_at and writes a culture_transitions row; the cancel closes the culture's open instrument records like M18 does (C9 effect: pending_match / culture_cancelled),
//   applied / ignored records stay; refresh_metrics "reads overdue" = status IN (incubating, growth_detected) AND next_read_due_at < now() (TRD §4.1).
// Synthetic data only.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileChainStatus } from '../../tasks/micro.reconcile_chain_status.js';
import { refreshMetrics } from '../../tasks/micro.refresh_metrics.js';
import { purgeInstrumentRecords } from '../../tasks/micro.purge_instrument_records.js';

// `pg` is a dependency of services/api, not of the worker: resolve it from there (same trick as the other worker tests).
const pg = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../../../../../api/package.json'))('pg') as typeof import('pg');
const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T18_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a018';
const B = '01a1a98a-ac40-7000-8000-00000000b018';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a10218';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60f-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const HOURS = 3600 * 1000;
const ago = (h: number) => new Date(Date.now() - h * HOURS).toISOString();
const ahead = (h: number) => new Date(Date.now() + h * HOURS).toISOString();

let api: pg.Pool;
let admin: pg.Pool;
type Row = Record<string, any>;
const q = async (text: string, values: unknown[] = []): Promise<Row[]> => (await admin.query(text, values)).rows;

async function seedRow(table: string, given: Row, onConflict = ''): Promise<void> {
  const [schema, name] = table.split('.') as [string, string];
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
    const row: Row = { ...given };
    for (const { column_name, udt_name } of cols) {
      if (column_name in row) continue;
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? ago(1)
        : udt_name === 'date' ? '2026-11-01' : udt_name === 'jsonb' || udt_name === 'json' ? '[]' : `syn-${++seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : row[k])));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const W = { centre: uid(), centreB: uid(), patient: uid(), test: uid(), instr: uid(), instrB: uid() };
const CENTRE_OF: Record<string, string> = { [A]: W.centre, [B]: W.centreB };
/** A tenant of its own (own centre): a test that counts rows or batches is not disturbed by the leftovers of the others. */
async function freshTenant(n: number): Promise<string> {
  const t = `01a1a98a-ac40-7000-8000-0000000c${n.toString(16).padStart(4, '0')}`; const centre = uid();
  await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  await seedRow('core.collection_centres', { tenant_id: t, id: centre });
  CENTRE_OF[t] = centre;
  return t;
}
beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 6 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centre], [B, W.centreB]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  for (const [t, id, c] of [[A, W.instr, W.centre], [B, W.instrB, W.centreB]] as const) await seedRow('instruments.instruments', { tenant_id: t, id, centre_id: c });
});
afterAll(async () => { await api?.end(); await admin?.end(); });

// ------------------------------------------------------------------ world builders
interface Cul { id: string; order: string; item: string }
async function newCulture(o: { tenant?: string; status?: string; ageH?: number; versions?: number; chain?: boolean; nextRead?: string | null; order?: string } = {}): Promise<Cul> {
  const tenant = o.tenant ?? A; const centre = CENTRE_OF[tenant] ?? W.centre;
  const id = uid(); const order = o.order ?? uid(); const item = uid(); const status = o.status ?? 'incubating'; const versions = o.versions ?? 0;
  await seedRow('micro.cultures', { id, tenant_id: tenant, centre_id: centre, order_id: order, order_item_id: item, specimen_id: uid(), patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
    status, received_at: ago(o.ageH ?? 48), created_at: ago(o.ageH ?? 48), planted_at: status === 'awaiting_setup' ? null : ago((o.ageH ?? 48) - 1), last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1,
    current_report_version_no: versions, chain_cancelled: o.chain ?? false, next_read_due_at: o.nextRead ?? null,
    ...(versions > 0 ? { last_report_phase: status === 'final_submitted' ? 'final' : 'preliminary' } : {}),
    ...(status === 'final_submitted' || status === 'amending' ? { outcome_code: 'no_growth' } : {}),
    ...(status === 'amending' ? { amendment_reason_code: 'syn_amend' } : {}),
    ...(status === 'cancelled' ? { cancel_reason_code: 'syn_other', cancelled_at: ago(30) } : {}) });
  for (let n = 1; n <= versions; n++) {
    await seedRow('micro.report_versions', { id: uid(), tenant_id: tenant, centre_id: centre, culture_id: id, order_item_id: item, version_no: n, report_phase: n === versions && status === 'final_submitted' ? 'final' : 'preliminary',
      version_kind: n === 1 ? 'initial' : 'update', submission_kind: 'structured', ...(n === versions && status === 'final_submitted' ? { outcome_code: 'no_growth' } : {}),
      culture_summary_text: 'Synthetic summary', isolates: [], ast: [], is_critical: false, flag: 'N', signed_by_membership_id: uid(), signed_at: ago(40), lab_result_id: uid(), lab_result_version_no: n,
      lab_status_at_submit: 'approved', lab_replayed: false, created_by: SYS });
  }
  return { id, order, item };
}
async function newRecord(o: { tenant?: string; status: string; expires?: string | null; culture?: string }): Promise<string> {
  const tenant = o.tenant ?? A; const id = uid();
  const applied = o.status === 'applied' || o.status === 'ignored';
  await seedRow('micro.instrument_records', { id, tenant_id: tenant, centre_id: tenant === A ? W.centre : W.centreB, event_id: uid(), idempotency_key: `syn-t18-${RUN}-${id}`, instrument_message_id: uid(), instrument_id: tenant === A ? W.instr : W.instrB,
    sample_barcode: `SYN-T18-${seqN}`, record_kind: 'ast', instrument_analyte_code: 'AMP', antibiotic_code_raw: 'AMP', method: 'mic', raw_value: '4', received_at: ago(100), match_status: o.status,
    ...(o.culture ? { culture_id: o.culture } : {}), expires_at: o.expires === undefined ? (applied ? ago(24) : null) : o.expires,
    ...(o.status === 'ignored' ? { ignore_reason_code: 'syn_ignore' } : {}), created_by: SYS, updated_by: SYS });
  return id;
}
async function newAstRef(record: string, culture?: string): Promise<void> {
  await seedRow('micro.ast_results', { id: uid(), tenant_id: A, centre_id: W.centre, culture_id: culture ?? uid(), isolate_id: uid(), antibiotic_code: `syn_t18_${seqN}`, method: 'mic', raw_value: '4', standard: 'CLSI', standard_version: 'M100-2026',
    standard_source: 'instrument_payload', source: 'instrument', instrument_record_id: record, instrument_id: W.instr, created_by: SYS, updated_by: SYS, version: 1 });
}
const cult = async (id: string) => (await q('SELECT * FROM micro.cultures WHERE id = $1', [id]))[0]!;
const trans = (id: string) => q('SELECT * FROM micro.culture_transitions WHERE culture_id = $1 ORDER BY occurred_at, id', [id]);
const recExists = async (id: string) => (await q('SELECT 1 FROM micro.instrument_records WHERE id = $1', [id])).length === 1;
const recRow = async (id: string) => (await q('SELECT * FROM micro.instrument_records WHERE id = $1', [id]))[0]!;

// ------------------------------------------------------------------ job runner
type Lines = Record<string, string>;     // order_item_id -> C5 line status
async function job(handler: (p: any, c: any) => Promise<void>, o: { tenant?: string; actor?: 'system' | 'user'; lines?: Lines; refs?: Record<string, string> } = {}) {
  const tenant = o.tenant ?? A;
  const labCalls: Row[] = []; const incs: Row[] = []; const sets: Row[] = [];
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: o.actor ?? 'system' })]);
    const lab = { async getOrderResults(_c: unknown, i: Row) {
      labCalls.push(i);
      const items = Object.entries(o.lines ?? {}).filter(([, s]) => s !== undefined).map(([orderItemId, status]) => ({ orderItemId, testId: W.test, departmentId: uid(), results: [{ status, ...(o.refs?.[orderItemId] ? { moduleRef: { module: 'micro', entityId: o.refs[orderItemId], versionNo: 1 } } : {}) }] }));
      return { orderId: i['orderId'], items, specimens: [], approvedSetHash: 'h' };
    } };
    const ctx = { tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: uid(), tx: client, now: () => new Date().toISOString(), isNewer: () => true,
      metrics: { inc: (name: string, labels: Row = {}, n = 1) => incs.push({ name, labels, n }), set: (name: string, value: number, labels: Row = {}) => sets.push({ name, value, labels }), observe() {} },
      events: { publish() {} }, audit: { access: async () => undefined }, log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
      ports: { LabPort: lab }, attempt: 1, maxAttempts: 5, jobId: 'job-t18' };
    await handler({ tenant_id: tenant }, ctx);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return { labCalls, incs, sets };
}
const cancelledLines = (...cs: Cul[]): Lines => Object.fromEntries(cs.map((c) => [c.item, 'cancelled']));
const gaugeOf = (sets: Row[], name: string) => sets.filter((s) => s.name === name);

describe.skipIf(!live && !REQUIRE)('C10-T18 reconcile_chain_status (AC-17.1)', () => {
  it('active culture older than 24 h whose C5 line is cancelled -> cancelled / order_item_cancelled, cancelled_at, version + 1, one transition (from -> cancelled); its open records wait again, history stays', async () => {
    const c = await newCulture({ status: 'incubating' });
    const open = await newRecord({ status: 'conflict', culture: c.id });
    const done = await newRecord({ status: 'applied', culture: c.id, expires: ahead(24) });
    const r = await job(reconcileChainStatus, { lines: cancelledLines(c) });
    expect(r.labCalls).toEqual([{ orderId: c.order, scope: 'all_visible' }]);
    expect(await cult(c.id)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'order_item_cancelled', chain_cancelled: false, version: 2 });
    expect((await cult(c.id)).cancelled_at).toBeTruthy();
    const t = await trans(c.id);
    expect(t.map((x) => [x.from_status, x.to_status, x.reason_code, x.created_by])).toEqual([['incubating', 'cancelled', 'order_item_cancelled', SYS]]);
    expect(await recRow(open)).toMatchObject({ match_status: 'pending_match', match_reason: 'culture_cancelled' });
    expect(await recRow(done)).toMatchObject({ match_status: 'applied' });
  });

  it('awaiting_setup and growth_detected (no submitted version) are cancelled too', async () => {
    const a = await newCulture({ status: 'awaiting_setup' }); const g = await newCulture({ status: 'growth_detected' });
    await job(reconcileChainStatus, { lines: cancelledLines(a, g) });
    expect((await cult(a.id)).status).toBe('cancelled');
    expect((await cult(g.id)).status).toBe('cancelled');
  });

  it('a submitted version -> only chain_cancelled = true (status, report numbers and reason untouched, no transition); a second run changes nothing', async () => {
    const fin = await newCulture({ status: 'final_submitted', versions: 2 }); const pre = await newCulture({ status: 'growth_detected', versions: 1 }); const amd = await newCulture({ status: 'amending', versions: 1 });
    await job(reconcileChainStatus, { lines: cancelledLines(fin, pre, amd) });
    for (const [c, status, v] of [[fin, 'final_submitted', 2], [pre, 'growth_detected', 1], [amd, 'amending', 1]] as const) {
      const row = await cult(c.id);
      expect(row, status).toMatchObject({ status, chain_cancelled: true, current_report_version_no: v, cancel_reason_code: null, cancelled_at: null });
      expect(await trans(c.id), status).toEqual([]);
    }
    const before = (await cult(fin.id)).version;
    const second = await job(reconcileChainStatus, { lines: cancelledLines(fin, pre, amd) });
    expect((await cult(fin.id)).version).toBe(before);
    expect(second.labCalls.map((l) => l['orderId'])).not.toContain(fin.order);   // a flagged culture is not asked about again
  });

  it('not examined: younger than 24 h, already cancelled, another tenant; their order is not even requested from C5', async () => {
    const young = await newCulture({ ageH: 2 }); const done = await newCulture({ status: 'cancelled' });
    const foreign = await newCulture({ tenant: B });
    const r = await job(reconcileChainStatus, { lines: cancelledLines(young, done, foreign) });
    expect((await cult(young.id)).status).toBe('incubating');
    expect((await cult(done.id)).cancel_reason_code).toBe('syn_other');
    expect(await cult(foreign.id)).toMatchObject({ status: 'incubating', version: 1 });
    expect(r.labCalls.map((l) => l['orderId'])).not.toEqual(expect.arrayContaining([young.order]));
    expect(r.labCalls.map((l) => l['orderId'])).not.toContain(foreign.order);
    expect(r.labCalls.map((l) => l['orderId'])).not.toContain(done.order);
  });

  it('only the cancelled line changes its culture: a sibling culture of the same order with an approved line stays; one C5 read per order', async () => {
    const order = uid();
    const c1 = await newCulture({ order }); const c2 = await newCulture({ order });
    const r = await job(reconcileChainStatus, { lines: { [c1.item]: 'cancelled', [c2.item]: 'approved' } });
    expect(r.labCalls.filter((l) => l['orderId'] === order)).toHaveLength(1);
    expect((await cult(c1.id)).status).toBe('cancelled');
    expect((await cult(c2.id)).status).toBe('incubating');
  });

  it('batch bound: LIMS_MICRO_RECONCILE_BATCH caps one run; flagged cultures leave the selection, so repeated runs finish a backlog larger than the batch', async () => {
    const T = await freshTenant(0x181);
    const pool = await Promise.all([1, 2, 3].map(() => newCulture({ status: 'final_submitted', versions: 1, tenant: T })));
    const open = await Promise.all([1, 2].map(() => newCulture({ tenant: T })));
    const mine = [...pool, ...open];
    const lines = cancelledLines(...mine);
    process.env['LIMS_MICRO_RECONCILE_BATCH'] = '2';
    try {
      const touched = async () => (await Promise.all(mine.map(cult))).filter((r) => r.chain_cancelled || r.status === 'cancelled').length;
      await job(reconcileChainStatus, { tenant: T, lines });
      expect(await touched()).toBe(2);                                  // one run never goes beyond the batch
      await job(reconcileChainStatus, { tenant: T, lines });
      await job(reconcileChainStatus, { tenant: T, lines });
      expect(await touched()).toBe(5);                                  // 2 + 2 + 1: flagged / cancelled cultures drop out, so the backlog drains
    } finally { delete process.env['LIMS_MICRO_RECONCILE_BATCH']; }
  });

  it('the job runs under the tenant of its claims: tenant B cultures are untouched even when C5 would say cancelled for them', async () => {
    const b = await newCulture({ tenant: B });
    await job(reconcileChainStatus, { tenant: B, lines: cancelledLines(b) });
    expect((await cult(b.id)).status).toBe('cancelled');
    const a = await newCulture({ tenant: A });
    await job(reconcileChainStatus, { tenant: B, lines: cancelledLines(a) });
    expect(await cult(a.id)).toMatchObject({ status: 'incubating', version: 1 });
  });
});

describe.skipIf(!live && !REQUIRE)('C10-T18 refresh_metrics', () => {
  it('gauges equal the tenant\'s own counts (RLS + tenant bound): cultures by status, overdue reads, open records by match_status', async () => {
    // a fresh tenant keeps the counts independent of the other tests
    const T = '01a1a98a-ac40-7000-8000-0000000c0c18'; const centre = uid(); const instr = uid();
    await seedRow('core.tenants', { id: T }, 'ON CONFLICT DO NOTHING');
    await seedRow('core.collection_centres', { tenant_id: T, id: centre });
    await seedRow('instruments.instruments', { tenant_id: T, id: instr, centre_id: centre });
    const mk = async (status: string, extra: Row = {}) => { const id = uid(); await seedRow('micro.cultures', { id, tenant_id: T, centre_id: centre, order_id: uid(), order_item_id: uid(), specimen_id: uid(), patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine', status,
      received_at: ago(5), last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1, ...(status === 'cancelled' ? { cancel_reason_code: 'syn_other', cancelled_at: ago(1) } : {}), ...extra }); return id; };
    await mk('incubating', { next_read_due_at: ago(3) });                      // overdue
    await mk('growth_detected', { next_read_due_at: ago(1) });                 // overdue
    await mk('incubating', { next_read_due_at: ahead(5) });                    // not yet
    await mk('awaiting_setup');
    await mk('cancelled', { next_read_due_at: ago(9) });                       // terminal: never overdue
    const rec = async (status: string) => seedRow('micro.instrument_records', { id: uid(), tenant_id: T, centre_id: centre, event_id: uid(), idempotency_key: `syn-t18-${RUN}-${uid()}`, instrument_message_id: uid(), instrument_id: instr, sample_barcode: `SYN-M-${seqN}`,
      record_kind: 'ast', instrument_analyte_code: 'AMP', antibiotic_code_raw: 'AMP', method: 'mic', raw_value: '4', received_at: ago(3), match_status: status, expires_at: status === 'applied' ? ago(1) : null, created_by: SYS, updated_by: SYS });
    await rec('pending_match'); await rec('pending_match'); await rec('conflict'); await rec('applied');
    await mk('final_submitted', { outcome_code: 'no_growth', current_report_version_no: 1 });
    const r = await job(refreshMetrics, { tenant: T });
    const by = Object.fromEntries(gaugeOf(r.sets, 'lims_micro_cultures_by_status').map((g) => [g.labels.status, g.value]));
    expect(by).toEqual({ awaiting_setup: 1, incubating: 2, growth_detected: 1, final_submitted: 1, amending: 0, cancelled: 1 });
    expect(gaugeOf(r.sets, 'lims_micro_reads_overdue').map((g) => g.value)).toEqual([2]);
    expect(Object.fromEntries(gaugeOf(r.sets, 'lims_micro_instrument_records_open').map((g) => [g.labels.match_status, g.value]))).toEqual({ pending_match: 2, needs_mapping: 0, conflict: 1, late_after_final: 0 });
    expect(r.sets.every((g) => g.labels.tenant_id === T)).toBe(true);
  });
});

describe.skipIf(!live && !REQUIRE)('C10-T18 purge_instrument_records (AC-08.12, D-65)', () => {
  it('deletes only expired applied / ignored records that no AST row references; keeps unexpired, open, referenced and other tenants\' rows; counts what it deleted', async () => {
    const goneApplied = await newRecord({ status: 'applied', expires: ago(2) });
    const goneIgnored = await newRecord({ status: 'ignored', expires: ago(1) });
    const keepFuture = await newRecord({ status: 'applied', expires: ahead(48) });
    const keepOpen = await newRecord({ status: 'pending_match' });
    const keepRef = await newRecord({ status: 'applied', expires: ago(3) });
    await newAstRef(keepRef);
    const foreign = await newRecord({ tenant: B, status: 'applied', expires: ago(5) });
    const r = await job(purgeInstrumentRecords);
    expect(await recExists(goneApplied)).toBe(false);
    expect(await recExists(goneIgnored)).toBe(false);
    for (const [name, id] of [['unexpired', keepFuture], ['open', keepOpen], ['referenced by an AST row', keepRef], ['other tenant', foreign]] as const) expect(await recExists(id), name).toBe(true);
    const total = r.incs.filter((i) => i.name === 'lims_micro_instrument_records_purged_total');
    expect(total.reduce((a, i) => a + i.n, 0)).toBeGreaterThanOrEqual(2);
    expect(total.every((i) => i.labels.tenant_id === A)).toBe(true);
    const again = await job(purgeInstrumentRecords);                                           // idempotent
    expect(again.incs.filter((i) => i.name === 'lims_micro_instrument_records_purged_total').reduce((a, i) => a + i.n, 0)).toBe(0);
    expect(await recExists(keepRef)).toBe(true);
  });

  it('the AST row keeps its provenance link: after the purge the referenced record is unchanged (the DELETE would have failed on the FK, so the job must have skipped it, not erred)', async () => {
    const id = await newRecord({ status: 'ignored', expires: ago(10) });
    await newAstRef(id);
    const before = await recRow(id);
    await job(purgeInstrumentRecords);
    expect(await recRow(id)).toMatchObject({ id, match_status: 'ignored', version: before['version'] });
  });

  it('more than 1,000 expired rows are all removed in one run (batches); a foreign tenant\'s expired rows survive the same run', async () => {
    const tag = `SYN-T18-BULK-${RUN}`;
    await q(`INSERT INTO micro.instrument_records (id, tenant_id, centre_id, event_id, idempotency_key, instrument_message_id, instrument_id, sample_barcode, record_kind, instrument_analyte_code, antibiotic_code_raw,
               method, raw_value, received_at, match_status, expires_at, created_by, updated_by)
             SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), $3 || '-' || g, gen_random_uuid(), $4, 'SYN-B', 'ast', 'AMP', 'AMP', 'mic', '4', now() - interval '200 hours', 'applied', now() - interval '1 hour', $5, $5
               FROM generate_series(1, 1050) g`, [A, W.centre, tag, W.instr, SYS]);
    const f = await newRecord({ tenant: B, status: 'applied', expires: ago(1) });
    const r = await job(purgeInstrumentRecords);
    expect((await q('SELECT count(*)::int AS n FROM micro.instrument_records WHERE tenant_id = $1 AND idempotency_key LIKE $2', [A, `${tag}-%`]))[0]!['n']).toBe(0);
    expect(r.incs.filter((i) => i.name === 'lims_micro_instrument_records_purged_total').reduce((a, i) => a + i.n, 0)).toBeGreaterThanOrEqual(1050);
    expect(await recExists(f)).toBe(true);
  });

  it('under user claims the DELETE policy hides every row (system actor only): the job cannot be used to purge as a person', async () => {
    const id = await newRecord({ status: 'applied', expires: ago(4) });
    await job(purgeInstrumentRecords, { actor: 'user' }).catch(() => undefined);              // may resolve (0 rows) or reject; it must not delete
    expect(await recExists(id)).toBe(true);
    await job(purgeInstrumentRecords);
    expect(await recExists(id)).toBe(false);
  });
});
