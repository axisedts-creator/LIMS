// C10 T-14 — instrument records end to end against the migrated database: consumer instruments.result.received.v1 + M19–M22 + M33–M38
// (06-IMPLEMENTATION-PLAN row T-14; 02-TRD §4.8 steps 1–8, §5.3, §13; 03-APP-FLOW §2.4 IR1–IR6; 05-SCHEMA instrument_records (+ checks), ast_results, isolates, specimen_isolate_counters,
//  instrument_vocab_maps, instrument_ast_defaults; PRD AC-08.1–08.12; 07-SECURITY BOLA/RLS, S-05).
// Needs the micro DDL + RLS applied: LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under
// LIMS_T14_REQUIRE_DB=1 where "database is provided" fails. (Same harness status as T-05..T-10.)
// SEAMS: as instrument-record.consumer.test.ts (consumer, ctx.tx = ONE tx per delivery under RLS with system claims; ports LabPort.lookupSpecimens + IdentityPort.getTenantSettings are hand fakes
//   over the seeded world) and instrument-record.handlers.test.ts (handlers via handlers/index.ts, ctx.tx = request tx under RLS with user claims; IdentityPort etc. from helpers/cultureReads.ts).
//   LIMS_MICRO_SPECIMEN_LOOKUP_PORT is set per delivery. Parent rows are seeded by `seedRow` (admin, replica role, type-based filler) exactly as in T-06/T-09.
// ASSUMED (spec silent; flagged so a ruling can overrule): match_reason codes `no_culture`, `multiple_cultures`, `isolate_missing`, `manual_value_exists`, `organism_differs`, `unknown_barcode`,
//   `lookup_unavailable`, `isolate_seq_out_of_range`, `unmapped_organism`/`unmapped_antibiotic` are NOT asserted except the ones the spec names (TRD §4.8: isolate_seq_out_of_range, isolate_missing,
//   manual_value_exists, organism_differs, lookup_unavailable, unknown_barcode); apply on a `conflict` record without `resolution` = 409 micro.instrument_record_conflict (IR3 has no conflict row);
//   "audited" (use_instrument replace) = the audit.audit_log trigger row for micro.ast_results / micro.isolates UPDATE; expires_at is compared with the DB clock (TRD: now() + years), ±5 min.
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { onInstrumentResult } from '../../../../../../worker/src/jobs/micro/consumers/instruments.result.received.v1.js';
import { mkCtx, responseErrors, run, MANAGE, READ, WORK, type Row } from '../../handlers/__tests__/helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T14_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60f-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const TYPE = 'instruments.result.received.v1';
const T0 = '2026-11-05T03:51:02.000Z';
const T1 = '2026-11-05T04:10:00.000Z';
const NOWISO = '2026-11-05T05:00:00.000Z';
const CODE = { ecoli: `syn_t14_ecoli_${RUN}`, staph: `syn_t14_staph_${RUN}`, amp: `syn_t14_amp_${RUN}`, cip: `syn_t14_cip_${RUN}` };

let api: pg.Pool;
let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

async function seedRow(table: string, given: Record<string, unknown>, onConflict = ''): Promise<void> {
  const [schema, name] = table.split('.') as [string, string];
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
    const row: Record<string, unknown> = { ...given };
    for (const { column_name, udt_name } of cols) {
      if (column_name in row) continue;
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? NOWISO
        : udt_name === 'date' ? '2026-11-01' : udt_name === 'jsonb' || udt_name === 'json' ? '[]' : `syn-${seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : row[k])));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const W = { order: uid(), centre: uid(), centre2: uid(), centreB: uid(), patient: uid(), test: uid(), instr: uid(), instr2: uid(), instrB: uid(), memHub: uid(), memC2: uid(), memB: uid(), user: uid() };

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 12 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centre], [A, W.centre2], [B, W.centreB]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  for (const [t, id, c] of [[A, W.instr, W.centre], [A, W.instr2, W.centre], [B, W.instrB, W.centreB]] as const) await seedRow('instruments.instruments', { tenant_id: t, id, centre_id: c });
  await seedRow('core.users', { tenant_id: A, id: W.user, display_name: 'Synthetic Tech T14' });
  for (const [t, id, all] of [[A, W.memHub, true], [A, W.memC2, false], [B, W.memB, true]] as const)
    await seedRow('core.memberships', { tenant_id: t, id, user_id: W.user, actor_type: 'user', status: 'active', is_active: true, all_centres: all });
  await seedRow('core.membership_centres', { tenant_id: A, membership_id: W.memC2, centre_id: W.centre2 });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient });
  await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  for (const [c, d] of [[CODE.ecoli, 'Synthetic E. coli'], [CODE.staph, 'Synthetic S. aureus']] as const) await seedRow('micro.cs_organisms', { tenant_id: A, code: c, display: d, is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
  for (const [c, d] of [[CODE.amp, 'Synthetic ampicillin'], [CODE.cip, 'Synthetic ciprofloxacin']] as const) await seedRow('micro.cs_antibiotics', { tenant_id: A, code: c, display: d, is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
});
afterAll(async () => { await api?.end(); await admin?.end(); });

// ------------------------------------------------------------------ world builders
async function newCulture(o: { status?: string; centre?: string } = {}): Promise<{ id: string; specimen: string; barcode: string }> {
  const id = uid(); const specimen = uid(); const status = o.status ?? 'incubating'; const barcode = `SYN-T14-${RUN}-${seqN}`;
  await seedRow('lab.specimens', { tenant_id: A, id: specimen });
  await seedRow('micro.cultures', { id, tenant_id: A, centre_id: o.centre ?? W.centre, order_id: W.order, order_item_id: uid(), specimen_id: specimen, patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
    status, received_at: '2026-11-04T04:00:00.000Z', planted_at: status === 'awaiting_setup' ? null : '2026-11-04T05:00:00.000Z', last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1,
    ...(status === 'final_submitted' ? { outcome_code: 'no_growth' } : {}) });
  return { id, specimen, barcode };
}
async function newIsolate(c: { id: string; specimen: string }, seq: number, o: Row = {}): Promise<string> {
  const id = uid();
  await seedRow('micro.isolates', { id, tenant_id: A, centre_id: W.centre, culture_id: c.id, specimen_id: c.specimen, isolate_seq: seq, status: o['organism_code'] ? 'identified' : 'pending_id', is_reportable: true,
    created_by: SYS, updated_by: SYS, version: 2, ...(o['organism_code'] ? { organism_source: 'manual', identified_at: NOWISO } : {}), ...o });
  await seedRow('micro.specimen_isolate_counters', { tenant_id: A, specimen_id: c.specimen, last_seq: seq, created_by: SYS, updated_by: SYS }, 'ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = GREATEST(micro.specimen_isolate_counters.last_seq, EXCLUDED.last_seq)');
  return id;
}
async function newManualAst(c: { id: string }, isolateId: string, antibiotic: string, rawValue = '4', method = 'mic'): Promise<string> {
  const id = uid();
  await seedRow('micro.ast_results', { id, tenant_id: A, centre_id: W.centre, culture_id: c.id, isolate_id: isolateId, antibiotic_code: antibiotic, method, raw_value: rawValue, standard: 'CLSI', standard_version: 'M100-2026',
    standard_source: 'manual', source: 'manual', off_panel: true, is_reportable: true, report_visibility: 'shown', suggestion_overridden: false, created_by: SYS, updated_by: SYS, version: 1 });
  return id;
}
const recs = (key?: string) => q('SELECT * FROM micro.instrument_records WHERE tenant_id = $1' + (key ? ' AND idempotency_key = $2' : '') + ' ORDER BY created_at, id', key ? [A, key] : [A]);
const recById = async (id: string) => (await q('SELECT * FROM micro.instrument_records WHERE id = $1', [id]))[0]!;
const isolatesOf = (cid: string) => q('SELECT * FROM micro.isolates WHERE culture_id = $1 ORDER BY isolate_seq', [cid]);
const astOf = (isolateId: string) => q('SELECT * FROM micro.ast_results WHERE isolate_id = $1 ORDER BY antibiotic_code, method', [isolateId]);
const counterOf = async (sp: string) => (await q('SELECT last_seq FROM micro.specimen_isolate_counters WHERE specimen_id = $1', [sp]))[0]?.last_seq;
const auditOf = (table: string, id: string) => q(`SELECT action, changed_columns FROM audit.audit_log WHERE schema_name = 'micro' AND table_name = $1 AND row_id = $2 ORDER BY occurred_at, id`, [table, id]);
const dbNow = async () => new Date((await q('SELECT now() AS n'))[0]!.n).getTime();
const YEAR_MS = 365.2425 * 24 * 3600 * 1000;
const expectExpiry = async (rec: Row, years: number, before: number) => {
  const t = new Date(rec['expires_at']).getTime(); const after = await dbNow();
  expect(t).toBeGreaterThanOrEqual(before + years * YEAR_MS - 5 * 60_000 - 2 * 86_400_000);   // leap days
  expect(t).toBeLessThanOrEqual(after + years * YEAR_MS + 5 * 60_000 + 2 * 86_400_000);
};

// ------------------------------------------------------------------ events
type Body = Record<string, unknown>;
interface Ev { barcode: string; kind?: 'organism_id' | 'ast'; seq?: number | null; code?: string; org?: Body; ast?: Body; at?: string | null; rerun?: boolean; centre?: string; instr?: string; eventId?: string; code2?: string }
function event(e: Ev): { env: Body; key: string } {
  const kind = e.kind ?? 'organism_id'; const seq = e.seq === undefined ? 1 : e.seq; const at = e.at === undefined ? T0 : e.at;
  const base: Body = { instrument_message_id: uid(), instrument_id: e.instr ?? W.instr, agent_id: uid(), centre_id: e.centre ?? W.centre, protocol: 'hl7v2', sample_barcode: e.barcode, record_kind: kind,
    mapping_status: 'mapped', received_at: '2026-11-05T04:30:00.000Z', is_rerun: e.rerun ?? false, ...(at ? { instrument_result_time: at } : {}) };
  const payload: Body = kind === 'organism_id'
    ? { ...base, instrument_analyte_code: e.code ?? `ORG:${seq ?? 1}`, organism: { organism_code_raw: 'ESCCOL', organism_code: CODE.ecoli, ...(seq ? { isolate_seq: seq } : {}), ...e.org } }
    : { ...base, instrument_analyte_code: e.code ?? `AST:${seq ?? 1}:AMP:mic`, ast: { antibiotic_code_raw: 'AMP', antibiotic_code: CODE.amp, ...(seq ? { isolate_seq: seq } : {}), method: 'mic', raw_value: '8',
      interpretation_raw: 'R', standard: 'CLSI', standard_version: 'M100-2026', ...e.ast } };
  const key = `${payload['instrument_id']}:${payload['sample_barcode']}:${payload['instrument_analyte_code']}:${at ?? 'none'}`;
  return { key, env: { event_id: e.eventId ?? uid(), event_type: TYPE, tenant_id: A, occurred_at: base['received_at'], actor: { type: 'system', id: uid() }, idempotency_key: key, producer: 'instruments',
    aggregate: { type: 'instrument_message', id: payload['instrument_message_id'], seq: 1 }, request_id: uid(), payload } };
}
interface Dlv { flag?: boolean; refs?: Record<string, { specimenId: string }[]>; years?: number; metrics?: ReturnType<typeof vi.fn> }
/** One delivery = one committed tx under RLS (system claims), like the C0 consumer wrapper; a throw rolls back. */
async function deliver(e: Ev, d: Dlv = {}): Promise<{ key: string; rec: Row }> {
  const { env, key } = event(e);
  const old = process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT'];
  process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT'] = d.flag === false ? 'false' : 'true';
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'system' })]);
    const ref = (id: string) => ({ specimenId: id, barcode: e.barcode, orderId: W.order, patientId: W.patient, centreId: W.centre, specimenTypeCode: 'urine', status: 'received', isActive: true, version: 1 });
    const lookup = async (_c: unknown, i: { barcode: string }) => (d.refs?.[i.barcode] ?? []).map((r) => ref(r.specimenId));
    const ctx = { tenantId: A, actor: { type: 'system', id: SYS }, requestId: uid(), tx: client, metrics: { inc: d.metrics ?? vi.fn() }, now: () => NOWISO, events: { publish: vi.fn() }, audit: { access: async () => undefined },
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
      ports: { LabPort: { lookupSpecimens: lookup }, IdentityPort: { getTenantSettings: async () => ({ retention: { rawInstrumentYears: d.years ?? 1 } }) } } };
    await (onInstrumentResult as (x: unknown, c: unknown) => Promise<void>)(env, ctx);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); if (old === undefined) delete process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT']; else process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT'] = old; }
  return { key, rec: (await recs(key))[0]! };
}
const known = (c: { specimen: string; barcode: string }) => ({ [c.barcode]: [{ specimenId: c.specimen }] });

// ------------------------------------------------------------------ handlers
interface Who { tenant: string; membership: string; all?: boolean; centres?: string[] }
const HUB: Who = { tenant: A, get membership() { return W.memHub; }, all: true } as Who;
const C2: Who = { tenant: A, get membership() { return W.memC2; }, all: false, get centres() { return [W.centre2]; } } as Who;
const asB: Who = { tenant: B, get membership() { return W.memB; }, all: true } as Who;
async function call(who: Who, op: string, req: Row, o: { grants?: string[]; years?: number } = {}): Promise<{ res?: any; err?: any }> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: who.tenant, sub: SYS, actor_type: 'user', membership_id: who.membership })]);
    const { ctx } = mkCtx({ tenantId: who.tenant, tx: client, grants: o.grants ?? [READ, WORK, MANAGE], actor: { type: 'user', id: SYS, membershipId: who.membership }, centreScope: { all: who.all === true, centreIds: who.centres ?? [] },
      members: { [W.memHub]: 'Synthetic Tech T14', [W.memC2]: 'Synthetic Tech T14' }, users: { [W.user]: 'Synthetic Tech T14' } });
    ctx.ports.IdentityPort.getTenantSettings = async () => ({ retention: { rawInstrumentYears: o.years ?? 1 } });
    try { const res = await run(op, req, ctx); await client.query('COMMIT'); return { res }; } catch (err) { await client.query('ROLLBACK'); return { err }; }
  } finally { client.release(); }
}
const ok = async (p: Promise<{ res?: any; err?: any }>) => { const r = await p; if (r.err) throw r.err; return r.res; };
const bad = async (p: Promise<{ res?: any; err?: any }>, code: string) => { const r = await p; expect(r.err, `expected ${code}`).toBeDefined(); expect(isLimsError(r.err, code), `${r.err?.code ?? r.err}`).toBe(true); return r.err; };
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const idem = () => ({ 'idempotency-key': `k-${uid()}` });
const assign = (r: Row, body: Row, who = HUB) => call(who, 'assignMicroInstrumentRecord', { params: { record_id: r['id'] }, headers: { ...idem(), ...ifm(r['version']) }, body });
const apply = (r: Row, body: Row = {}, who = HUB, o: { years?: number } = {}) => call(who, 'applyMicroInstrumentRecord', { params: { record_id: r['id'] }, headers: { ...idem(), ...ifm(r['version']) }, body }, o);
const ignore = (r: Row, body: Row, who = HUB, o: { years?: number } = {}) => call(who, 'ignoreMicroInstrumentRecord', { params: { record_id: r['id'] }, headers: ifm(r['version']), body }, o);
const mkMap = (body: Row) => call(HUB, 'createInstrumentVocabMap', { headers: idem(), body });

describe.skipIf(!live && !REQUIRE)('T-14 instrument records (live DB)', () => {
  it('database is provided', () => { expect(live).toBe(true); });

  describe('AC-08.1 / 08.2 store + dedupe', () => {
    it('non organism/ast kinds never reach micro.instrument_records (the C0 inbox row is the only trace)', async () => {
      const c = await newCulture(); const before = (await recs()).length;
      const { env } = event({ barcode: c.barcode });
      (env['payload'] as Body)['record_kind'] = 'quantitative'; delete (env['payload'] as Body)['organism']; (env['payload'] as Body)['instrument_analyte_code'] = 'HGB';
      const client = await api.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'system' })]);
        await (onInstrumentResult as any)(env, { tenantId: A, actor: { type: 'system', id: SYS }, requestId: uid(), tx: client, metrics: { inc() {} }, now: () => NOWISO, events: { publish() {} }, audit: { access() {} },
          log: { info() {}, warn() {}, error() {}, child() { return this; } }, ports: { LabPort: { lookupSpecimens: async () => [] }, IdentityPort: { getTenantSettings: async () => ({ retention: { rawInstrumentYears: 1 } }) } } });
        await client.query('COMMIT');
      } finally { client.release(); }
      expect((await recs()).length).toBe(before);
    });
    it('one row per idempotency key with exactly the stored columns; a re-delivery (new event_id, same key) and 6 parallel deliveries leave ONE row', async () => {
      const c = await newCulture();
      const first = await deliver({ barcode: c.barcode, kind: 'ast', seq: 2, rerun: true, ast: { raw_value: '<=2', interpretation_raw: 's' } }, { flag: false });
      expect(first.rec).toMatchObject({ tenant_id: A, centre_id: W.centre, instrument_id: W.instr, sample_barcode: c.barcode, record_kind: 'ast', isolate_seq: 2, antibiotic_code_raw: 'AMP', antibiotic_code: CODE.amp,
        method: 'mic', raw_value: '<=2', interpretation_raw: 's', standard: 'CLSI', standard_version: 'M100-2026', is_rerun: true, organism_code_raw: null, organism_code: null, match_status: 'pending_match', expires_at: null });
      expect(first.rec['event_id']).toBeTruthy(); expect(first.rec['instrument_message_id']).toBeTruthy(); expect(first.rec['received_at']).toBeTruthy();
      const again = await deliver({ barcode: c.barcode, kind: 'ast', seq: 2, rerun: true, ast: { raw_value: '<=2', interpretation_raw: 's' } }, { flag: false });
      expect(again.key).toBe(first.key);
      expect(await recs(first.key)).toHaveLength(1);
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => deliver({ barcode: c.barcode, kind: 'ast', seq: 3 }, { flag: false })));
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);   // a lost insert race is success (ON CONFLICT DO NOTHING), never a dead letter
      expect(await recs(`${W.instr}:${c.barcode}:AST:3:AMP:mic:${T0}`)).toHaveLength(1);
    });
    it('the same 04 N10 key delivered twice (different event_id) -> still ONE row, first one wins, no second metric', async () => {
      const c = await newCulture(); const e1 = event({ barcode: c.barcode, at: '2026-11-05T06:00:00.000Z' }); const metrics = vi.fn();
      const run1 = async (env: Body) => {
        const client = await api.connect();
        try {
          await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'system' })]);
          await (onInstrumentResult as any)(env, { tenantId: A, actor: { type: 'system', id: SYS }, requestId: uid(), tx: client, metrics: { inc: metrics }, now: () => NOWISO, events: { publish() {} }, audit: { access() {} },
            log: { info() {}, warn() {}, error() {}, child() { return this; } }, ports: { LabPort: { lookupSpecimens: async () => [] }, IdentityPort: { getTenantSettings: async () => ({ retention: { rawInstrumentYears: 1 } }) } } });
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      };
      await run1(e1.env); const m1 = metrics.mock.calls.length;
      await run1({ ...e1.env, event_id: uid() });
      expect(await recs(e1.key)).toHaveLength(1);
      expect(metrics.mock.calls.length).toBe(m1);
    });
  });

  describe('AC-08.3 resolved + mapped -> applied', () => {
    it('organism, isolate absent: isolate is created WITH that seq (counter advanced to >= seq), identified as instrument, record applied with isolate/culture ids and expires_at = now + 1 year', async () => {
      const c = await newCulture(); const t0 = await dbNow();
      const { rec } = await deliver({ barcode: c.barcode, seq: 3 }, { refs: known(c) });
      expect(rec).toMatchObject({ match_status: 'applied', culture_id: c.id, specimen_id: c.specimen, ignore_reason_code: null });
      const iso = await isolatesOf(c.id);
      expect(iso).toHaveLength(1);
      expect(iso[0]).toMatchObject({ isolate_seq: 3, organism_code: CODE.ecoli, organism_source: 'instrument', status: 'identified' });
      expect(rec['isolate_id']).toBe(iso[0]!.id);
      expect(Number(await counterOf(c.specimen))).toBeGreaterThanOrEqual(3);
      await expectExpiry(rec, 1, t0);
    });
    it('organism on an existing pending_id isolate identifies it (organism_source instrument); the same organism again is a no-op that is still applied', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1);
      const a = await deliver({ barcode: c.barcode, seq: 1 }, { refs: known(c) });
      expect(a.rec['match_status']).toBe('applied');
      expect(await isolatesOf(c.id)).toHaveLength(1);
      expect((await isolatesOf(c.id))[0]).toMatchObject({ id: i1, organism_code: CODE.ecoli, organism_source: 'instrument', status: 'identified' });
      const v = (await isolatesOf(c.id))[0]!['version'];
      const b = await deliver({ barcode: c.barcode, seq: 1, at: T1 }, { refs: known(c) });
      expect(b.rec['match_status']).toBe('applied');
      expect((await isolatesOf(c.id))[0]!['version']).toBe(v);
    });
    it('organism without an isolate number and a culture with <= 1 isolate uses that isolate (or creates #1)', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1);
      const r = await deliver({ barcode: c.barcode, seq: null, code: 'ORG' }, { refs: known(c) });
      expect(r.rec['match_status']).toBe('applied');
      expect(r.rec['isolate_id']).toBe(i1);
    });
    it('review #2: no isolate number, live culture has no isolates, but a cancelled culture of the SAME specimen owns isolate 1 -> pending_match / isolate_number_in_use (no 23505, no dead letter), nothing created', async () => {
      const dead = await newCulture({ status: 'cancelled' }); await newIsolate(dead, 1);
      const live = { id: uid(), specimen: dead.specimen, barcode: dead.barcode };
      await seedRow('micro.cultures', { id: live.id, tenant_id: A, centre_id: W.centre, order_id: W.order, order_item_id: uid(), specimen_id: live.specimen, patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
        status: 'incubating', received_at: '2026-11-04T04:00:00.000Z', planted_at: '2026-11-04T05:00:00.000Z', last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1 });
      const r = await deliver({ barcode: live.barcode, seq: null, code: 'ORG' }, { refs: known(live) });
      expect(r.rec).toMatchObject({ match_status: 'pending_match', match_reason: 'isolate_number_in_use', expires_at: null });
      expect(await isolatesOf(live.id)).toHaveLength(0);
      expect(await isolatesOf(dead.id)).toHaveLength(1);
    });
    it('AST: upsert (isolate, antibiotic, method) with source = instrument, interpretation_source = instrument, instrument ids/time, category from interpretation_raw (upper-cased), standard_source = instrument_payload', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli });
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, ast: { interpretation_raw: 'r', raw_value: '8' } }, { refs: known(c) });
      expect(rec).toMatchObject({ match_status: 'applied', isolate_id: i1, culture_id: c.id });
      const rows = await astOf(i1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ antibiotic_code: CODE.amp, method: 'mic', raw_value: '8', source: 'instrument', interpretation_source: 'instrument', category_code: 'R', standard: 'CLSI', standard_version: 'M100-2026',
        standard_source: 'instrument_payload', instrument_id: W.instr, instrument_record_id: rec['id'], off_panel: true });
      expect(new Date(rows[0]!['instrument_result_time']).toISOString()).toBe(T0);
      expect(rec['ast_result_id']).toBe(rows[0]!.id);
    });
    it('AST with no isolate of that number -> pending_match / isolate_missing, nothing written to ast_results', async () => {
      const c = await newCulture();
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) });
      expect(rec).toMatchObject({ match_status: 'pending_match', match_reason: 'isolate_missing', expires_at: null });
      expect(await q('SELECT 1 FROM micro.ast_results WHERE culture_id = $1', [c.id])).toHaveLength(0);
    });
    it('two isolates, same antibiotic, same time (CR-C10-007): distinct records, each applied to its own isolate', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli }); const i2 = await newIsolate(c, 2, { organism_code: CODE.staph });
      const r1 = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) }); const r2 = await deliver({ barcode: c.barcode, kind: 'ast', seq: 2 }, { refs: known(c) });
      expect(r1.key).not.toBe(r2.key);
      expect((await astOf(i1)).length + (await astOf(i2)).length).toBe(2);
      expect(r1.rec['isolate_id']).toBe(i1); expect(r2.rec['isolate_id']).toBe(i2);
    });
    it('instrument rerun ordering: a NEWER result replaces the stored instrument value; an OLDER rerun is ignored with reason duplicate and leaves the value (expires_at set)', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli });
      await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, at: T1, ast: { raw_value: '16' } }, { refs: known(c) });
      const old = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, at: T0, rerun: true, ast: { raw_value: '2' } }, { refs: known(c) });
      expect(old.rec).toMatchObject({ match_status: 'ignored', ignore_reason_code: 'duplicate' });
      expect(old.rec['expires_at']).not.toBeNull();
      expect((await astOf(i1))[0]!['raw_value']).toBe('16');
      const newer = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, at: '2026-11-05T09:00:00.000Z', rerun: true, ast: { raw_value: '32' } }, { refs: known(c) });
      expect(newer.rec['match_status']).toBe('applied');
      const rows = await astOf(i1);
      expect(rows).toHaveLength(1); expect(rows[0]!['raw_value']).toBe('32');
    });
  });

  describe('AC-08.4 pending_match and assign', () => {
    it('flag off (default): no automatic matching — pending_match / lookup_unavailable, nothing applied, expires_at NULL', async () => {
      const c = await newCulture();
      const { rec } = await deliver({ barcode: c.barcode, seq: 1 }, { flag: false, refs: known(c) });
      expect(rec).toMatchObject({ match_status: 'pending_match', match_reason: 'lookup_unavailable', culture_id: null, expires_at: null });
      expect(await isolatesOf(c.id)).toHaveLength(0);
    });
    it('flag on + unknown barcode -> pending_match / unknown_barcode', async () => {
      const { rec } = await deliver({ barcode: `SYN-NOPE-${RUN}-${seqN}`, seq: 1 }, {});
      expect(rec).toMatchObject({ match_status: 'pending_match', match_reason: 'unknown_barcode' });
    });
    it('assign (M20) applies like AC-08.3: organism -> isolate with that seq (created, counter advanced), record applied with resolved_by/at, culture_id, expires_at', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 2 }, { flag: false });
      const t0 = await dbNow();
      const out = await ok(assign(rec, { culture_id: c.id }));
      expect(out).toMatchObject({ id: rec['id'], match_status: 'applied', culture_id: c.id });
      expect(responseErrors('assignMicroInstrumentRecord', out)).toEqual([]);
      const r = await recById(rec['id']);
      expect(r).toMatchObject({ match_status: 'applied', culture_id: c.id, resolved_by_membership_id: W.memHub }); expect(r['resolved_at']).not.toBeNull(); expect(r['version']).toBeGreaterThan(rec['version']);
      expect((await isolatesOf(c.id))[0]).toMatchObject({ isolate_seq: 2, organism_code: CODE.ecoli, organism_source: 'instrument' });
      expect(Number(await counterOf(c.specimen))).toBeGreaterThanOrEqual(2);
      await expectExpiry(r, 1, t0);
    });
    it('assign with isolate_seq chooses the isolate number for this record (create new #5)', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 1 }, { flag: false });
      await ok(assign(rec, { culture_id: c.id, isolate_seq: 5 }));
      expect((await isolatesOf(c.id)).map((i) => i['isolate_seq'])).toEqual([5]);
    });
    it('assign to a cancelled culture is refused and writes nothing; assign to a culture of another tenant is 404 (BOLA)', async () => {
      const cc = await newCulture({ status: 'cancelled' }); const { rec } = await deliver({ barcode: cc.barcode, seq: 1 }, { flag: false });
      const r = await assign(rec, { culture_id: cc.id }); expect(r.err).toBeDefined();
      expect((await recById(rec['id']))['match_status']).toBe('pending_match');
      await bad(assign(rec, { culture_id: uid() }), 'common.not_found');
    });
    it('record of another tenant / a centre the caller cannot see: 404 on M21 and absent from M19', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 1 }, { flag: false });
      await bad(apply(rec, {}, asB), 'common.not_found');
      const outsider = await call(C2, 'applyMicroInstrumentRecord', { params: { record_id: rec['id'] }, headers: { ...idem(), ...ifm(rec['version']) }, body: {} });
      expect(outsider.err).toBeDefined(); expect(['common.not_found', 'auth.forbidden']).toContain((outsider.err as any).code);
      const listB = await ok(call(asB, 'listMicroInstrumentRecords', { query: {} }));
      expect(listB.data.find((d: Row) => d['id'] === rec['id'])).toBeUndefined();
      expect((await recById(rec['id']))['match_status']).toBe('pending_match');
    });
  });

  describe('AC-08.5 needs_mapping / vocabulary maps / stored mapped codes', () => {
    it('unmapped organism (no mapped code in the event, no vocab map) -> needs_mapping; after M34 creates the map, apply (M21) applies with local_code', async () => {
      const c = await newCulture(); const raw = `ESC${RUN}${seqN}`;
      const { rec } = await deliver({ barcode: c.barcode, seq: 1, org: { organism_code_raw: raw, organism_code: undefined } }, { refs: known(c) });
      expect(rec).toMatchObject({ match_status: 'needs_mapping', expires_at: null });
      expect(await isolatesOf(c.id)).toHaveLength(0);
      const m = await ok(mkMap({ instrument_id: W.instr, kind: 'organism', code_raw: raw, local_code: CODE.staph }));
      expect(m).toMatchObject({ instrument_id: W.instr, kind: 'organism', code_raw: raw, local_code: CODE.staph, is_active: true });
      const out = await ok(apply(rec));
      expect(out['match_status']).toBe('applied');
      expect((await isolatesOf(c.id))[0]).toMatchObject({ organism_code: CODE.staph, organism_source: 'instrument' });
    });
    it('apply while the code is STILL unmapped stays needs_mapping (IR3) and writes nothing', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 1, org: { organism_code_raw: `UNK${RUN}${seqN}`, organism_code: undefined } }, { refs: known(c) });
      const out = await ok(apply(rec));
      expect(out['match_status']).toBe('needs_mapping');
      expect(await isolatesOf(c.id)).toHaveLength(0);
    });
    it('unmapped antibiotic -> needs_mapping; map kind=antibiotic then apply -> AST row with the mapped antibiotic', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli }); const raw = `CIP${RUN}${seqN}`;
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, code: `AST:1:${raw}:mic`, ast: { antibiotic_code_raw: raw, antibiotic_code: undefined } }, { refs: known(c) });
      expect(rec['match_status']).toBe('needs_mapping');
      await ok(mkMap({ instrument_id: W.instr, kind: 'antibiotic', code_raw: raw, local_code: CODE.cip }));
      expect((await ok(apply(rec)))['match_status']).toBe('applied');
      expect((await astOf(i1))[0]).toMatchObject({ antibiotic_code: CODE.cip });
    });
    it('review m#24: the MAPPED code carried by the event is stored and wins over (and survives without) a vocab map — deferred assign gives the same outcome as an immediate apply', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 1, org: { organism_code_raw: `NOMAP${RUN}`, organism_code: CODE.staph } }, { flag: false });
      expect(rec).toMatchObject({ organism_code: CODE.staph, organism_code_raw: `NOMAP${RUN}` });
      await ok(assign(rec, { culture_id: c.id }));
      expect((await isolatesOf(c.id))[0]).toMatchObject({ organism_code: CODE.staph });
    });
    it('a mapped code that is NOT in v_organisms falls back to the vocab map, else needs_mapping', async () => {
      const c = await newCulture(); const raw = `FALL${RUN}${seqN}`;
      const none = await deliver({ barcode: c.barcode, seq: 1, org: { organism_code_raw: raw, organism_code: 'syn_not_in_catalogue' } }, { refs: known(c) });
      expect(none.rec['match_status']).toBe('needs_mapping');
      await ok(mkMap({ instrument_id: W.instr, kind: 'organism', code_raw: raw, local_code: CODE.ecoli }));
      expect((await ok(apply(none.rec)))['match_status']).toBe('applied');
    });
  });

  describe('AC-08.6 conflicts and resolution', () => {
    it('manual AST value exists -> conflict (manual_value_exists), manual row untouched, expires_at NULL', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli }); const manual = await newManualAst(c, i1, CODE.amp, '4');
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, ast: { raw_value: '64', interpretation_raw: 'R' } }, { refs: known(c) });
      expect(rec).toMatchObject({ match_status: 'conflict', match_reason: 'manual_value_exists', expires_at: null });
      expect((await astOf(i1))[0]).toMatchObject({ id: manual, raw_value: '4', source: 'manual' });
    });
    it('apply on a conflict WITHOUT resolution -> 409 micro.instrument_record_conflict, nothing changes', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli }); await newManualAst(c, i1, CODE.amp, '4');
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) });
      await bad(apply(rec, {}), 'micro.instrument_record_conflict');
      expect((await recById(rec['id']))['match_status']).toBe('conflict');
    });
    it('use_instrument (IR4): the manual value is replaced (source instrument, audited), record applied with expires_at', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli }); const manual = await newManualAst(c, i1, CODE.amp, '4');
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, ast: { raw_value: '64', interpretation_raw: 'R' } }, { refs: known(c) }); const t0 = await dbNow();
      const out = await ok(apply(rec, { resolution: 'use_instrument' }));
      expect(out['match_status']).toBe('applied');
      expect((await astOf(i1))[0]).toMatchObject({ id: manual, raw_value: '64', source: 'instrument', category_code: 'R', interpretation_source: 'instrument' });
      expect((await auditOf('ast_results', manual)).some((a) => a['action'] === 'UPDATE')).toBe(true);
      await expectExpiry(await recById(rec['id']), 1, t0);
    });
    it('keep_existing (IR5): record closes as ignored / kept_manual, manual value untouched, expires_at set', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli }); await newManualAst(c, i1, CODE.amp, '4');
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, ast: { raw_value: '64' } }, { refs: known(c) });
      const out = await ok(apply(rec, { resolution: 'keep_existing' }));
      expect(out).toMatchObject({ match_status: 'ignored', ignore_reason_code: 'kept_manual' });
      expect((await recById(rec['id']))['expires_at']).not.toBeNull();
      expect((await astOf(i1))[0]).toMatchObject({ raw_value: '4', source: 'manual' });
    });
    it('different manually identified organism -> conflict (organism_differs); use_instrument re-identifies as instrument; keep_existing keeps the manual organism', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.staph });
      const a = await deliver({ barcode: c.barcode, seq: 1 }, { refs: known(c) });
      expect(a.rec).toMatchObject({ match_status: 'conflict', match_reason: 'organism_differs' });
      expect((await isolatesOf(c.id))[0]).toMatchObject({ organism_code: CODE.staph, organism_source: 'manual' });
      await ok(apply(a.rec, { resolution: 'use_instrument' }));
      expect((await isolatesOf(c.id))[0]).toMatchObject({ organism_code: CODE.ecoli, organism_source: 'instrument' });
      expect((await auditOf('isolates', i1)).some((x) => x['action'] === 'UPDATE')).toBe(true);
      const c2 = await newCulture(); await newIsolate(c2, 1, { organism_code: CODE.staph });
      const b = await deliver({ barcode: c2.barcode, seq: 1 }, { refs: known(c2) });
      expect((await ok(apply(b.rec, { resolution: 'keep_existing' })))).toMatchObject({ match_status: 'ignored', ignore_reason_code: 'kept_manual' });
      expect((await isolatesOf(c2.id))[0]).toMatchObject({ organism_code: CODE.staph, organism_source: 'manual' });
    });
    it('use_instrument / keep_existing on a record WITHOUT a conflict are accepted as plain apply / refused: keep_existing on a pending record -> 409 micro.instrument_record_conflict', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 1 }, { flag: false });
      await bad(apply(rec, { resolution: 'keep_existing' }, HUB), 'micro.instrument_record_conflict');
    });
  });

  describe('AC-08.7 / 08.8 standard and interpretation', () => {
    it('standard unknown + per-instrument default (M38) -> the row stores the default with standard_source = instrument_default; no default -> standard unknown', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli });
      const put = await ok(call(HUB, 'putInstrumentAstDefault', { params: { instrument_id: W.instr2 }, headers: {}, body: { standard: 'EUCAST', standard_version: 'v14.0' } }));
      expect(put).toMatchObject({ instrument_id: W.instr2, standard: 'EUCAST', standard_version: 'v14.0' });
      const withDef = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, instr: W.instr2, ast: { standard: 'unknown', standard_version: undefined, interpretation_raw: 'S' } }, { refs: known(c) });
      expect(withDef.rec['match_status']).toBe('applied');
      expect((await astOf(i1))[0]).toMatchObject({ standard: 'EUCAST', standard_version: 'v14.0', standard_source: 'instrument_default' });
      const c2 = await newCulture(); const j1 = await newIsolate(c2, 1, { organism_code: CODE.ecoli });
      const noDef = await deliver({ barcode: c2.barcode, kind: 'ast', seq: 1, instr: W.instr, ast: { standard: undefined, standard_version: undefined } }, { refs: known(c2) });
      expect(noDef.rec['match_status']).toBe('applied');
      expect((await astOf(j1))[0]).toMatchObject({ standard: 'unknown' });
    });
    it('M37/M38: list shows the default; replace needs If-Match, create does not; wrong version -> 409; unknown instrument -> 400 /instrument_id', async () => {
      const list = await ok(call(HUB, 'listInstrumentAstDefaults', {}));
      const row = list.data.find((d: Row) => d['instrument_id'] === W.instr2); expect(row).toBeDefined();
      expect(responseErrors('listInstrumentAstDefaults', list)).toEqual([]);
      await bad(call(HUB, 'putInstrumentAstDefault', { params: { instrument_id: W.instr2 }, headers: {}, body: { standard: 'CLSI', standard_version: 'M100-2026' } }), 'common.precondition_required');
      await bad(call(HUB, 'putInstrumentAstDefault', { params: { instrument_id: W.instr2 }, headers: ifm(row.version + 7), body: { standard: 'CLSI', standard_version: 'M100-2026' } }), 'common.version_conflict');
      const upd = await ok(call(HUB, 'putInstrumentAstDefault', { params: { instrument_id: W.instr2 }, headers: ifm(row.version), body: { standard: 'CLSI', standard_version: 'M100-2026' } }));
      expect(upd).toMatchObject({ standard: 'CLSI', version: row.version + 1 });
      const e = await bad(call(HUB, 'putInstrumentAstDefault', { params: { instrument_id: uid() }, headers: {}, body: { standard: 'CLSI', standard_version: '1' } }), 'common.validation_failed');
      expect(JSON.stringify(e)).toContain('/instrument_id');
      expect((await ok(call(asB, 'listInstrumentAstDefaults', {}))).data.find((d: Row) => d['instrument_id'] === W.instr2)).toBeUndefined();
    });
    it('interpretation_raw that is not a code of the standard -> category_code stays empty (row still stored, needs manual review); a valid one (any case) sets it', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli });
      await deliver({ barcode: c.barcode, kind: 'ast', seq: 1, ast: { interpretation_raw: 'ZZZ' } }, { refs: known(c) });
      expect((await astOf(i1))[0]).toMatchObject({ category_code: null, interpretation_raw: 'ZZZ' });
      const c2 = await newCulture(); const j1 = await newIsolate(c2, 1, { organism_code: CODE.ecoli });
      await deliver({ barcode: c2.barcode, kind: 'ast', seq: 1, ast: { interpretation_raw: 's' } }, { refs: known(c2) });
      expect((await astOf(j1))[0]).toMatchObject({ category_code: 'S', interpretation_source: 'instrument' });
    });
  });

  describe('AC-08.9 late after final', () => {
    it('culture final_submitted -> late_after_final, nothing applied; after the culture is reopened (amending) apply (IR3) applies', async () => {
      const c = await newCulture({ status: 'final_submitted' }); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli });
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) });
      expect(rec).toMatchObject({ match_status: 'late_after_final', expires_at: null, culture_id: c.id });
      expect(await astOf(i1)).toHaveLength(0);
      const still = await ok(apply(rec));
      expect(still['match_status']).toBe('late_after_final');
      expect(await astOf(i1)).toHaveLength(0);
      await q("UPDATE micro.cultures SET status = 'amending' WHERE id = $1", [c.id]);
      const cur = await recById(rec['id']);
      expect((await ok(apply(cur)))['match_status']).toBe('applied');
      expect(await astOf(i1)).toHaveLength(1);
    });
    it('M19 summary exposes open late records of the culture (banner source): filter culture_id + match_status=late_after_final', async () => {
      const c = await newCulture({ status: 'final_submitted' }); await newIsolate(c, 1, { organism_code: CODE.ecoli });
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) });
      const list = await ok(call(HUB, 'listMicroInstrumentRecords', { query: { culture_id: c.id, match_status: 'late_after_final' } }));
      expect(list.data.map((d: Row) => d['id'])).toEqual([rec['id']]);
      expect(responseErrors('listMicroInstrumentRecords', list)).toEqual([]);
    });
  });

  describe('AC-08.11 isolate_seq_out_of_range', () => {
    it('seq 100 (payload and composite code) -> stored pending_match / isolate_seq_out_of_range, consumer resolves (no dead letter), no isolate/counter change; 99 is accepted', async () => {
      const c = await newCulture();
      const r = await deliver({ barcode: c.barcode, seq: 100 }, { refs: known(c) });
      expect(r.rec).toMatchObject({ match_status: 'pending_match', match_reason: 'isolate_seq_out_of_range', isolate_seq: 100, expires_at: null });
      expect(await isolatesOf(c.id)).toHaveLength(0);
      expect(await counterOf(c.specimen)).toBeUndefined();
      const ok99 = await deliver({ barcode: c.barcode, seq: 99, at: T1 }, { refs: known(c) });
      expect(ok99.rec['match_status']).toBe('applied');
      expect((await isolatesOf(c.id))[0]!['isolate_seq']).toBe(99);
    });
    it('assign of an out-of-range record without a valid isolate_seq keeps it pending_match; with isolate_seq 1 it applies to isolate 1', async () => {
      const c = await newCulture(); const r = await deliver({ barcode: c.barcode, seq: 100 }, { flag: false });
      const out = await ok(assign(r.rec, { culture_id: c.id }));
      expect(out['match_status']).toBe('pending_match');
      const cur = await recById(r.rec['id']);
      expect((await ok(assign(cur, { culture_id: c.id, isolate_seq: 1 })))['match_status']).toBe('applied');
      expect((await isolatesOf(c.id))[0]!['isolate_seq']).toBe(1);
    });
  });

  describe('AC-08.12 / M22 ignore, ignore_comment, expires_at (D-65)', () => {
    it.each(['pending_match', 'needs_mapping', 'conflict', 'late_after_final'])('IR6: ignore from %s stores reason + comment, sets expires_at = now + rawInstrumentYears (3), resolved_by/at', async (from) => {
      const c = await newCulture({ status: from === 'late_after_final' ? 'final_submitted' : 'incubating' }); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli });
      let rec: Row;
      if (from === 'pending_match') rec = (await deliver({ barcode: c.barcode, seq: 1 }, { flag: false })).rec;
      else if (from === 'needs_mapping') rec = (await deliver({ barcode: c.barcode, seq: 1, org: { organism_code_raw: `IGN${RUN}${seqN}`, organism_code: undefined } }, { refs: known(c) })).rec;
      else if (from === 'conflict') { await newManualAst(c, i1, CODE.amp); rec = (await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) })).rec; }
      else rec = (await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) })).rec;
      expect(rec['match_status']).toBe(from);
      const t0 = await dbNow();
      const out = await ok(ignore(rec, { reason_code: 'wrong_sample', comment: `Synthetic note ${from}` }, HUB, { years: 3 }));
      expect(out).toMatchObject({ match_status: 'ignored', ignore_reason_code: 'wrong_sample', ignore_comment: `Synthetic note ${from}` });
      expect(responseErrors('ignoreMicroInstrumentRecord', out)).toEqual([]);
      const r = await recById(rec['id']);
      expect(r).toMatchObject({ match_status: 'ignored', ignore_reason_code: 'wrong_sample', ignore_comment: `Synthetic note ${from}`, resolved_by_membership_id: W.memHub });
      await expectExpiry(r, 3, t0);
    });
    it('comment of exactly 300 chars is stored; comment optional (NULL); ignored record cannot be ignored/applied/assigned again (409 micro.instrument_record_conflict)', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 1 }, { flag: false });
      await ok(ignore(rec, { reason_code: 'other', comment: 'c'.repeat(300) }));
      const r = await recById(rec['id']);
      expect(r['ignore_comment']).toHaveLength(300);
      await bad(ignore(r, { reason_code: 'duplicate' }), 'micro.instrument_record_conflict');
      await bad(apply(r), 'micro.instrument_record_conflict');
      await bad(assign(r, { culture_id: c.id }), 'micro.instrument_record_conflict');
      const c2 = await newCulture(); const r2 = (await deliver({ barcode: c2.barcode, seq: 1 }, { flag: false })).rec;
      await ok(ignore(r2, { reason_code: 'qc_or_test_run' }));
      expect((await recById(r2['id']))['ignore_comment']).toBeNull();
    });
    it('ignoring an APPLIED record is refused; applied rows carry expires_at, open rows never do (CHECK instrument_records__expires__ck holds for the whole table)', async () => {
      const c = await newCulture(); const a = (await deliver({ barcode: c.barcode, seq: 1 }, { refs: known(c) })).rec;
      expect(a['match_status']).toBe('applied');
      await bad(ignore(a, { reason_code: 'wrong_sample' }), 'micro.instrument_record_conflict');
      const bad_rows = await q(`SELECT id FROM micro.instrument_records WHERE (match_status IN ('applied','ignored')) <> (expires_at IS NOT NULL)`);
      expect(bad_rows).toEqual([]);
    });
    it('applied/ignored records are retained until expires_at: an AST row keeps its record (FK) — a referenced record has expires_at but the purge (T-18) must skip it', async () => {
      const c = await newCulture(); const i1 = await newIsolate(c, 1, { organism_code: CODE.ecoli });
      const { rec } = await deliver({ barcode: c.barcode, kind: 'ast', seq: 1 }, { refs: known(c) });
      expect((await astOf(i1))[0]!['instrument_record_id']).toBe(rec['id']);
    });
  });

  describe('M19 list + M33–M36 maps', () => {
    it('default = open statuses only; match_status csv filter; instrument filter; stable cursor paging; barcode only in the DTO field sample_barcode', async () => {
      const c = await newCulture(); const o1 = (await deliver({ barcode: c.barcode, seq: 7, instr: W.instr2 }, { flag: false })).rec; const ap = (await deliver({ barcode: c.barcode, seq: 8, instr: W.instr2 }, { refs: known(c) })).rec;
      const def = await ok(call(HUB, 'listMicroInstrumentRecords', { query: { instrument_id: W.instr2 } }));
      const idsDef = def.data.map((d: Row) => d['id']);
      expect(idsDef).toContain(o1['id']); expect(idsDef).not.toContain(ap['id']);
      expect(responseErrors('listMicroInstrumentRecords', def)).toEqual([]);
      const both = await ok(call(HUB, 'listMicroInstrumentRecords', { query: { instrument_id: W.instr2, match_status: 'pending_match,applied' } }));
      expect(both.data.map((d: Row) => d['id'])).toEqual(expect.arrayContaining([o1['id'], ap['id']]));
      const p1 = await ok(call(HUB, 'listMicroInstrumentRecords', { query: { instrument_id: W.instr2, match_status: 'pending_match,applied', limit: 1, sort: 'received_at' } }));
      expect(p1.data).toHaveLength(1); expect(p1.page.next_cursor ?? p1.page.nextCursor).toBeTruthy();
      await bad(call(HUB, 'listMicroInstrumentRecords', { query: { cursor: 'garbage' } }), 'common.invalid_cursor');
      await bad(call(HUB, 'listMicroInstrumentRecords', { query: {} }, { grants: [] }), 'auth.forbidden');
    });
    it('M34 create + duplicate active key -> 409 micro.code_duplicate; deactivate (M36) frees the key; M35 changes local_code with If-Match; M33 lists with filters; other tenant sees none', async () => {
      const raw = `MAP${RUN}${seqN}`;
      const m = await ok(mkMap({ instrument_id: W.instr, kind: 'organism', code_raw: raw, local_code: CODE.ecoli }));
      expect(responseErrors('createInstrumentVocabMap', m)).toEqual([]);
      await bad(mkMap({ instrument_id: W.instr, kind: 'organism', code_raw: raw, local_code: CODE.staph }), 'micro.code_duplicate');
      const upd = await ok(call(HUB, 'updateInstrumentVocabMap', { params: { map_id: m.id }, headers: ifm(m.version), body: { local_code: CODE.staph } }));
      expect(upd).toMatchObject({ local_code: CODE.staph, version: m.version + 1 });
      await bad(call(HUB, 'updateInstrumentVocabMap', { params: { map_id: m.id }, headers: ifm(m.version), body: { local_code: CODE.ecoli } }), 'common.version_conflict');
      const off = await ok(call(HUB, 'deactivateInstrumentVocabMap', { params: { map_id: m.id }, headers: ifm(upd.version), body: {} }));
      expect(off.is_active).toBe(false);
      await ok(mkMap({ instrument_id: W.instr, kind: 'organism', code_raw: raw, local_code: CODE.ecoli }));
      const list = await ok(call(HUB, 'listInstrumentVocabMaps', { query: { instrument_id: W.instr, kind: 'organism', is_active: true } }));
      expect(list.data.filter((d: Row) => d['code_raw'] === raw)).toHaveLength(1);
      expect((await ok(call(asB, 'listInstrumentVocabMaps', { query: {} }))).data.find((d: Row) => d['code_raw'] === raw)).toBeUndefined();
      await bad(call(asB, 'updateInstrumentVocabMap', { params: { map_id: m.id }, headers: ifm(1), body: { local_code: CODE.ecoli } }), 'common.not_found');
    });
    it('M34 with an unknown instrument id -> 400 common.validation_failed path /instrument_id; with an instrument of another tenant -> same', async () => {
      const e = await bad(mkMap({ instrument_id: uid(), kind: 'organism', code_raw: 'X1', local_code: CODE.ecoli }), 'common.validation_failed');
      expect(JSON.stringify(e)).toContain('/instrument_id');
      await bad(mkMap({ instrument_id: W.instrB, kind: 'organism', code_raw: 'X2', local_code: CODE.ecoli }), 'common.validation_failed');
    });
    it('a deactivated map is not used: a record that depended on it goes back to needs_mapping on apply', async () => {
      const c = await newCulture(); const raw = `DEAC${RUN}${seqN}`;
      const m = await ok(mkMap({ instrument_id: W.instr, kind: 'organism', code_raw: raw, local_code: CODE.ecoli }));
      const { rec } = await deliver({ barcode: c.barcode, seq: 1, org: { organism_code_raw: raw, organism_code: undefined } }, { refs: known(c) });
      expect(rec['match_status']).toBe('applied');
      const c2 = await newCulture(); await ok(call(HUB, 'deactivateInstrumentVocabMap', { params: { map_id: m.id }, headers: ifm(m.version), body: {} }));
      const r2 = await deliver({ barcode: c2.barcode, seq: 1, org: { organism_code_raw: raw, organism_code: undefined } }, { refs: known(c2) });
      expect(r2.rec['match_status']).toBe('needs_mapping');
    });
  });

  describe('concurrency + security', () => {
    it('two users applying the same record with the same If-Match: exactly one wins, the other gets 409 (version_conflict or instrument_record_conflict); one isolate, one AST row', async () => {
      const c3 = await newCulture(); await newIsolate(c3, 1, { organism_code: CODE.ecoli });
      const p = (await deliver({ barcode: c3.barcode, kind: 'ast', seq: 1 }, { flag: false })).rec;
      const res = await Promise.all([assign(p, { culture_id: c3.id }), assign(p, { culture_id: c3.id })]);
      expect(res.filter((r) => !r.err)).toHaveLength(1);
      const lost = res.find((r) => r.err)!.err;
      expect(['common.version_conflict', 'micro.instrument_record_conflict']).toContain(lost.code);
      expect(await q('SELECT 1 FROM micro.ast_results WHERE culture_id = $1', [c3.id])).toHaveLength(1);
    });
    it('forged server-owned fields never reach the row: expires_at / match_status in a body are 400; the barcode is absent from audit new_values of ast_results/isolates', async () => {
      const c = await newCulture(); const { rec } = await deliver({ barcode: c.barcode, seq: 1 }, { flag: false });
      await bad(assign(rec, { culture_id: c.id, expires_at: '2099-01-01T00:00:00Z' }), 'common.validation_failed');
      await bad(ignore(rec, { reason_code: 'other', match_status: 'applied' }), 'common.validation_failed');
      await ok(assign(rec, { culture_id: c.id }));
      const aud = await q(`SELECT new_values FROM audit.audit_log WHERE schema_name = 'micro' AND table_name IN ('isolates','ast_results') AND new_values::text LIKE $1`, [`%${c.barcode}%`]);
      expect(aud).toEqual([]);
    });
  });
});
