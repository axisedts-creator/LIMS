// C10 T-14 — consumer instruments.result.received.v1, NO database (06-IMPLEMENTATION-PLAN row T-14; 02-TRD §4.8 steps 1–4, §8.1/§8.2, §6 LIMS_MICRO_SPECIMEN_LOOKUP_PORT, §11 metrics;
// 03-APP-FLOW §2.4 IR1; PRD AC-08.1, 08.2, 08.4 (flag off / 0 cultures), 08.10, 08.11; 07-SECURITY: barcode never logged). State-dependent paths (applied, needs_mapping, conflict,
// late_after_final, rerun, expiry) are in instrument-record.integration.test.ts (live DB).
// Fails now: the consumer file does not exist; manifest.subscriptions['instruments.result.received.v1'] is the T-01 fail-closed stub.
// SEAMS (spec fixes behaviour, not signatures; same convention as culture.consumer.test.ts):
//   services/worker/src/jobs/micro/consumers/instruments.result.received.v1.ts exports `onInstrumentResult: ConsumerHandler` (TRD §8.1 name), delegating to
//   service/instrument-record.service.ts `onInstrumentResult(ctx, envelope)` + repository/instrument-records.repo.ts. jobs/micro/index.ts registers it under the event type.
//   The C0 wrapper did inbox dedupe + schema validation and opened the tx: handler gets (envelope, ctx), opens NO transaction.
//   ctx: tenantId, actor{type:'system'}, requestId, tx (pg-like .query(text, values) -> {rows,rowCount}), now(), log, metrics.inc(name, labels), audit, events,
//   ports { LabPort.lookupSpecimens(ctx, { barcode }), IdentityPort.getTenantSettings(ctx, { keys: ['retention'] }) }.
//   LIMS_MICRO_SPECIMEN_LOOKUP_PORT is read at call time through loadMicroConfig() (process.env); default false => LabPort.lookupSpecimens is NEVER called.
//   This file's tx is scripted: INSERT INTO micro.instrument_records returns rowCount 1 (or 0 when `dupe`), SELECT FROM micro.cultures returns `cultures`, every other SELECT returns no rows,
//   every other write returns one row {id}. Which SQL shape the writer uses is free; assertions look at statement text + bound values only.
// ASSUMED (spec silent): a LabPort.lookupSpecimens that THROWS stores the record pending_match / lookup_unavailable and the consumer resolves (no dead letter): "else pending_match (lookup_unavailable, unknown_barcode)" (TRD §4.8 step 2).
//   0 non-cancelled cultures for the specimen -> match_reason `no_culture`, >1 -> `multiple_cultures` (04-UI-UX §match_reason codes).
// Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifest } from '../../../../../../worker/src/jobs/micro/index.js';
import { onInstrumentResult } from '../../../../../../worker/src/jobs/micro/consumers/instruments.result.received.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const u = (n: number) => `0190c60c-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE = u(0x20), INSTR = u(0xd1), MSG = u(0xd2), SPEC = u(0x91), SPEC2 = u(0x92), CULT = u(0xc1), CULT2 = u(0xc2);
const TYPE = 'instruments.result.received.v1';
const BARCODE = 'SENTINEL-BC-9071';
const RESULT_TIME = '2026-11-05T03:51:02.000Z';
const RECEIVED = '2026-11-05T03:51:05.410Z';
const NOW = '2026-11-05T03:52:00.000Z';

interface World { dupe?: boolean; cultures?: Record<string, unknown>[]; lookup?: 'one' | 'none' | 'two' | 'throws'; years?: number }
const culture = (id: string, status = 'incubating') => ({ id, status, specimen_id: SPEC, centre_id: CENTRE, version: 3 });

function harness(w: World = {}) {
  const stmts: { text: string; values: unknown[] }[] = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    stmts.push({ text, values });
    if (/^\s*insert\s+into\s+micro\.instrument_records\b/i.test(text)) return w.dupe ? { rows: [], rowCount: 0 } : { rows: [{ id: u(0xaa) }], rowCount: 1 };
    if (/^\s*select\b[\s\S]*\bfrom\s+micro\.cultures\b/i.test(text)) return { rows: w.cultures ?? [], rowCount: (w.cultures ?? []).length };
    if (/^\s*(insert|update|delete)/i.test(text)) return { rows: [{ id: u(0xab) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const lookupSpecimens = vi.fn(async (_c: unknown, _i: { barcode: string }) => {
    if (w.lookup === 'throws') throw new Error('lab down');
    if (w.lookup === 'none') return [];
    const ref = (id: string) => ({ specimenId: id, barcode: BARCODE, orderId: u(0x50), patientId: u(0x40), centreId: CENTRE, specimenTypeCode: 'urine', status: 'received', isActive: true, version: 1 });
    return w.lookup === 'two' ? [ref(SPEC), ref(SPEC2)] : [ref(SPEC)];
  });
  const getTenantSettings = vi.fn(async () => ({ retention: { rawInstrumentYears: w.years ?? 1 } }));
  const logged: unknown[] = [];
  const sink = (...a: unknown[]) => { logged.push(a); };
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child() { return log; } };
  const metrics = { inc: vi.fn() };
  const ctx = { tenantId: A, actor: { type: 'system', id: SYS }, requestId: u(0x9), tx, metrics, log, now: () => NOW, events: { publish: vi.fn() }, audit: { access: vi.fn() },
    ports: { LabPort: { lookupSpecimens }, IdentityPort: { getTenantSettings } } };
  const writes = () => stmts.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.text));
  const recordWrites = () => writes().filter((s) => /\bmicro\.instrument_records\b/i.test(s.text));
  const clinicalWrites = () => writes().filter((s) => /\bmicro\.(cultures|isolates|ast_results|specimen_isolate_counters|culture_transitions)\b/i.test(s.text));
  const inserts = () => stmts.filter((s) => /^\s*insert\s+into\s+micro\.instrument_records\b/i.test(s.text));
  return { ctx, stmts, lookupSpecimens, getTenantSettings, logged, metrics, writes, recordWrites, clinicalWrites, inserts };
}

type Body = Record<string, unknown>;
const orgPayload = (o: Body = {}, org: Body = {}): Body => ({ instrument_message_id: MSG, instrument_id: INSTR, agent_id: u(0xd3), centre_id: CENTRE, protocol: 'hl7v2', sample_barcode: BARCODE,
  record_kind: 'organism_id', instrument_analyte_code: 'ORG:1', mapping_status: 'mapped', instrument_result_time: RESULT_TIME, received_at: RECEIVED, is_rerun: false,
  organism: { organism_code_raw: 'ESCCOL', organism_code: 'syn_ecoli', isolate_seq: 1, ...org }, ...o });
const astPayload = (o: Body = {}, ast: Body = {}): Body => ({ instrument_message_id: MSG, instrument_id: INSTR, agent_id: u(0xd3), centre_id: CENTRE, protocol: 'hl7v2', sample_barcode: BARCODE,
  record_kind: 'ast', instrument_analyte_code: 'AST:2:AMP:mic', mapping_status: 'mapped', instrument_result_time: RESULT_TIME, received_at: RECEIVED, is_rerun: true,
  instrument_flags: ['A'], processing_kind: 'live',
  ast: { antibiotic_code_raw: 'AMP', antibiotic_code: 'syn_amp', isolate_seq: 2, method: 'mic', raw_value: '<=2', interpretation_raw: 's', standard: 'CLSI', standard_version: 'M100-2026', ...ast }, ...o });
const envelope = (p: Body, eventId = u(0xe1)) => ({ event_id: eventId, event_type: TYPE, tenant_id: A, occurred_at: RECEIVED, actor: { type: 'system', id: u(0xa1) },
  idempotency_key: `${p['instrument_id']}:${p['sample_barcode']}:${p['instrument_analyte_code']}:${p['instrument_result_time'] ?? 'none'}`, producer: 'instruments',
  aggregate: { type: 'instrument_message', id: p['instrument_message_id'], seq: 1 }, request_id: u(0xb1), payload: p });
const run = (h: ReturnType<typeof harness>, env: unknown) => (onInstrumentResult as (e: unknown, c: unknown) => Promise<void>)(env, h.ctx);

const same = (v: unknown, x: unknown) => v === x || (v instanceof Date && typeof x === 'string' && v.getTime() === Date.parse(x))
  || (typeof v === 'string' && typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) && Date.parse(v) === Date.parse(x));
const hasValue = (s: { text: string; values: unknown[] }, x: unknown) => s.values.some((v) => same(v, x)) || (typeof x === 'string' && s.text.includes(`'${x}'`));
const anyHas = (ss: { text: string; values: unknown[] }[], x: unknown) => ss.some((s) => hasValue(s, x));
const withFlag = async (v: string | undefined, f: () => Promise<void>) => {
  const old = process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT'];
  if (v === undefined) delete process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT']; else process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT'] = v;
  try { await f(); } finally { if (old === undefined) delete process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT']; else process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT'] = old; }
};
afterEach(() => { delete process.env['LIMS_MICRO_SPECIMEN_LOOKUP_PORT']; });

describe('T-14 wiring', () => {
  it('manifest.subscriptions[instruments.result.received.v1] is the real handler, not the T-01 fail-closed stub', () => {
    expect(typeof onInstrumentResult).toBe('function');
    expect(manifest.subscriptions?.[TYPE]).toBe(onInstrumentResult);
  });
  it('lab.specimen.status_changed.v1 stays registered (T-06) — T-14 must not drop it', () => {
    expect(typeof manifest.subscriptions?.['lab.specimen.status_changed.v1']).toBe('function');
  });
});

describe('AC-08.1 other record kinds write only the inbox row (done by the C0 wrapper)', () => {
  it.each(['quantitative', 'qualitative', 'ordinal', 'text', 'attachment'])('record_kind %s: no micro write, no port call, no metric', async (kind) => {
    const h = harness();
    const p: Body = { ...orgPayload({ record_kind: kind, instrument_analyte_code: 'HGB' }) };
    delete p['organism'];
    await withFlag('true', () => run(h, envelope(p)));
    expect(h.writes()).toHaveLength(0);
    expect(h.lookupSpecimens).not.toHaveBeenCalled();
    expect(h.metrics.inc).not.toHaveBeenCalled();
  });
});

describe('AC-08.2 store: exactly one instrument_records row per idempotency key, exactly the 05-SCHEMA §8 columns', () => {
  it('organism_id: ONE insert, ON CONFLICT (tenant_id, idempotency_key) DO NOTHING, carrying every stored field', async () => {
    const h = harness();
    const env = envelope(orgPayload());
    await run(h, env);
    expect(h.inserts()).toHaveLength(1);
    const ins = h.inserts()[0]!;
    expect(ins.text).toMatch(/on\s+conflict\s*\(\s*tenant_id\s*,\s*idempotency_key\s*\)\s*do\s+nothing/i);
    for (const x of [A, CENTRE, env.event_id, env.idempotency_key, MSG, INSTR, BARCODE, 'organism_id', 'ORG:1', 1, 'ESCCOL', 'syn_ecoli', RESULT_TIME, RECEIVED, false, SYS])
      expect(hasValue(ins, x), `insert must carry ${String(x)}`).toBe(true);
  });
  it('ast: carries antibiotic raw + mapped code, method, raw_value, interpretation_raw, standard, standard_version, is_rerun=true, isolate_seq from payload', async () => {
    const h = harness();
    await run(h, envelope(astPayload()));
    const ins = h.inserts()[0]!;
    for (const x of ['ast', 'AST:2:AMP:mic', 2, 'AMP', 'syn_amp', 'mic', '<=2', 's', 'CLSI', 'M100-2026', true]) expect(hasValue(ins, x), `insert must carry ${String(x)}`).toBe(true);
  });
  it('NOT stored (TRD §4.8 step 1): mapping_status, processing_kind, instrument_flags, protocol, agent_id', async () => {
    const h = harness();
    await run(h, envelope(astPayload()));
    const ins = h.inserts()[0]!;
    expect(ins.text).not.toMatch(/\b(mapping_status|processing_kind|instrument_flags|protocol|agent_id)\b/i);
    for (const x of ['mapped', 'live', 'hl7v2', u(0xd3)]) expect(hasValue(ins, x), `must not store ${String(x)}`).toBe(false);
  });
  it('mapped code absent in the event -> the mapped column is NULL (the raw code is never copied into it)', async () => {
    const h = harness();
    await run(h, envelope(orgPayload({}, { organism_code: undefined })));
    const ins = h.inserts()[0]!;
    const i = ins.text.replace(/\s+/g, ' ').match(/insert\s+into\s+micro\.instrument_records\s*\(([^)]*)\)/i)?.[1]?.split(',').map((c) => c.trim().replace(/"/g, ''));
    if (i) { const k = i.indexOf('organism_code'); if (k >= 0 && ins.values.length === i.length) expect(ins.values[k] ?? null).toBeNull(); }
    expect(hasValue(ins, 'syn_ecoli')).toBe(false);
  });
  it('isolate_seq: composite code wins when the payload has none (ORG:3, AST:4:AMP:mic); neither -> NULL', async () => {
    const a = harness(); await run(a, envelope(orgPayload({ instrument_analyte_code: 'ORG:3' }, { isolate_seq: undefined })));
    expect(hasValue(a.inserts()[0]!, 3)).toBe(true);
    const b = harness(); await run(b, envelope(astPayload({ instrument_analyte_code: 'AST:4:AMP:mic' }, { isolate_seq: undefined })));
    expect(hasValue(b.inserts()[0]!, 4)).toBe(true);
    const c = harness(); await run(c, envelope(orgPayload({ instrument_analyte_code: 'HGB-ORG' }, { isolate_seq: undefined })));
    expect(c.inserts()).toHaveLength(1);
    expect(c.inserts()[0]!.values.filter((v) => typeof v === 'number')).toEqual([]);
  });
  it('tenant comes from ctx.tenantId only; a foreign tenant_id in the envelope is never bound', async () => {
    const h = harness();
    const B = '01a1a98a-ac40-7000-8000-00000000b001';
    await run(h, { ...envelope(orgPayload()), tenant_id: B });
    expect(hasValue(h.inserts()[0]!, A)).toBe(true);
    expect(anyHas(h.stmts, B)).toBe(false);
  });
  it('extra payload fields (future additive fields, PHI-looking noise) are tolerated and never persisted', async () => {
    const h = harness();
    await run(h, envelope(orgPayload({ patient_name: 'SENTINEL-PHI-Sita-Karki', future_field: { a: 1 } })));
    expect(h.inserts()).toHaveLength(1);
    expect(JSON.stringify(h.stmts)).not.toMatch(/SENTINEL-PHI/);
  });
});

describe('AC-08.2 dedupe on the 04 N10 key', () => {
  it('conflict (rowCount 0) = success: resolves, no further write, no port call, no metric', async () => {
    const h = harness({ dupe: true, lookup: 'one', cultures: [culture(CULT)] });
    await withFlag('true', () => run(h, envelope(orgPayload())));
    expect(h.inserts()).toHaveLength(1);
    expect(h.writes()).toHaveLength(1);
    expect(h.clinicalWrites()).toHaveLength(0);
    expect(h.metrics.inc).not.toHaveBeenCalled();
  });
});

describe('AC-08.4 behind LIMS_MICRO_SPECIMEN_LOOKUP_PORT (default false): matching is manual', () => {
  it.each([[undefined], ['false']])('flag %s: LabPort.lookupSpecimens is never called; record stored pending_match / lookup_unavailable; no clinical write', async (v) => {
    const h = harness({ lookup: 'one', cultures: [culture(CULT)] });
    await withFlag(v, () => run(h, envelope(orgPayload())));
    expect(h.lookupSpecimens).not.toHaveBeenCalled();
    expect(anyHas(h.recordWrites(), 'pending_match')).toBe(true);
    expect(anyHas(h.recordWrites(), 'lookup_unavailable')).toBe(true);
    expect(h.clinicalWrites()).toHaveLength(0);
    expect(h.recordWrites().some((s) => s.values.some((x) => same(x, NOW)) && /expires_at/i.test(s.text) && !/expires_at\s*=\s*NULL/i.test(s.text))).toBe(false);
  });
  it('flag on + unknown barcode (0 refs): pending_match / unknown_barcode', async () => {
    const h = harness({ lookup: 'none' });
    await withFlag('true', () => run(h, envelope(orgPayload())));
    expect(h.lookupSpecimens).toHaveBeenCalledTimes(1);
    expect(h.lookupSpecimens.mock.calls[0]![1]).toEqual({ barcode: BARCODE });
    expect(anyHas(h.recordWrites(), 'pending_match') && anyHas(h.recordWrites(), 'unknown_barcode')).toBe(true);
    expect(h.clinicalWrites()).toHaveLength(0);
  });
  it('flag on + LabPort throws: pending_match / lookup_unavailable and the consumer RESOLVES (no dead letter)', async () => {
    const h = harness({ lookup: 'throws' });
    await withFlag('true', () => run(h, envelope(orgPayload())));
    expect(anyHas(h.recordWrites(), 'lookup_unavailable')).toBe(true);
    expect(h.clinicalWrites()).toHaveLength(0);
  });
  it('flag on + specimen without a non-cancelled culture: pending_match / no_culture', async () => {
    const h = harness({ lookup: 'one', cultures: [] });
    await withFlag('true', () => run(h, envelope(orgPayload())));
    expect(anyHas(h.recordWrites(), 'no_culture')).toBe(true);
    expect(h.clinicalWrites()).toHaveLength(0);
  });
  it('flag on + more than one candidate (2 specimens, or 2 cultures): pending_match / multiple_cultures, nothing applied', async () => {
    const a = harness({ lookup: 'two', cultures: [culture(CULT)] });
    await withFlag('true', () => run(a, envelope(orgPayload())));
    expect(anyHas(a.recordWrites(), 'multiple_cultures')).toBe(true);
    expect(a.clinicalWrites()).toHaveLength(0);
    const b = harness({ lookup: 'one', cultures: [culture(CULT), culture(CULT2)] });
    await withFlag('true', () => run(b, envelope(orgPayload({ instrument_message_id: u(0xd9) }))));
    expect(anyHas(b.recordWrites(), 'multiple_cultures')).toBe(true);
    expect(b.clinicalWrites()).toHaveLength(0);
  });
  it('a flag value other than true/false fails fast (TRD §6) — the consumer rejects, it does not guess', async () => {
    const h = harness({ lookup: 'one', cultures: [culture(CULT)] });
    await expect(withFlag('yes', () => run(h, envelope(orgPayload())))).rejects.toThrow(/LIMS_MICRO_SPECIMEN_LOOKUP_PORT/);
  });
});

describe('AC-08.11 isolate number > 99: pending_match / isolate_seq_out_of_range (no retry, no dead letter)', () => {
  it.each([['organism', () => orgPayload({ instrument_analyte_code: 'ORG:100' }, { isolate_seq: 100 })], ['ast', () => astPayload({ instrument_analyte_code: 'AST:100:AMP:mic' }, { isolate_seq: 100 })],
    ['composite code only', () => orgPayload({ instrument_analyte_code: 'ORG:100' }, { isolate_seq: undefined })]])('%s: record stored, consumer resolves, no isolate/AST/counter write', async (_n, mk) => {
    const h = harness({ lookup: 'one', cultures: [culture(CULT)] });
    await withFlag('true', () => run(h, envelope(mk() as Body)));
    expect(h.inserts()).toHaveLength(1);
    expect(anyHas(h.recordWrites(), 'pending_match') && anyHas(h.recordWrites(), 'isolate_seq_out_of_range')).toBe(true);
    expect(h.clinicalWrites()).toHaveLength(0);
  });
  it('99 is in range (no isolate_seq_out_of_range)', async () => {
    const h = harness({ lookup: 'one', cultures: [culture(CULT)] });
    await withFlag('true', () => run(h, envelope(orgPayload({ instrument_analyte_code: 'ORG:99' }, { isolate_seq: 99 }))));
    expect(anyHas(h.recordWrites(), 'isolate_seq_out_of_range')).toBe(false);
  });
});

describe('AC-08.10 / 07-SECURITY: barcodes are never logged and never leave the row', () => {
  it.each([['organism', () => orgPayload()], ['ast', () => astPayload()]])('%s: no log call, metric label or event carries the barcode or the raw result values', async (_n, mk) => {
    const h = harness({ lookup: 'one', cultures: [culture(CULT)] });
    await withFlag('true', () => run(h, envelope(mk() as Body)));
    const seen = JSON.stringify([h.logged, h.metrics.inc.mock.calls, (h.ctx.events.publish as any).mock.calls, (h.ctx.audit.access as any).mock.calls]);
    expect(seen).not.toContain(BARCODE);
    expect(seen).not.toContain('<=2');
  });
  it('metric lims_micro_instrument_records_total{tenant_id, record_kind, match_status} counted once at first evaluation', async () => {
    const h = harness();
    await run(h, envelope(orgPayload()));
    const calls = h.metrics.inc.mock.calls.filter((c) => c[0] === 'lims_micro_instrument_records_total');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ tenant_id: A, record_kind: 'organism_id', match_status: 'pending_match' });
  });
});

describe('AC-08.12 expiry is set only on applied/ignored', () => {
  it('pending_match insert leaves expires_at NULL (CHECK instrument_records__expires__ck) and does not read retention settings', async () => {
    const h = harness();
    await run(h, envelope(orgPayload()));
    expect(h.getTenantSettings).not.toHaveBeenCalled();
    const ins = h.inserts()[0]!;
    expect(ins.values.some((v) => v instanceof Date && v.getUTCFullYear() > 2026)).toBe(false);
  });
});
