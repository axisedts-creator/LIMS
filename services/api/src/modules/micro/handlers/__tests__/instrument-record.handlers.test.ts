// C10 T-14 — instrument-record handlers M19–M22 and vocabulary maps / AST defaults M33–M38 WITHOUT a database: contract pins on micro.yaml + permission, If-Match, strict-body and
// state-guard behaviour (06-IMPLEMENTATION-PLAN row T-14; 02-TRD §5.3 rows M19–M22, M33–M38, §5 intro If-Match list, §12/§13; 03-APP-FLOW §2.4 IR2–IR6; PRD AC-08.4–08.6;
// 07-SECURITY S-05 forged fields, S-23/S-24 permissions, barcode P2). DB behaviour (apply/assign outcomes, expiry, conflicts, RLS, dedupe) is in instrument-record.integration.test.ts.
// Fails now: M19–M22, M33–M38 are T-01 stubs and reject common.internal.
// SEAMS (same as T-05/T-09): handlers in handlers/index.ts REAL map over service/instrument-record.service.ts + service/config.service.ts.
//   M19/M33/M37 (reads) and M34–M36/M38 (config): ctx.ports.IdentityPort.assertRole(ctx, { permission: <x-permission> }) is the FIRST step (config has no centre).
//   M20–M22: the record is loaded FIRST (RLS + tenant filter), THEN assertRole(ctx, { permission: 'micro.culture.work', centreId: <record.centre_id> }) (02-CV §10.1) — so an unknown id is
//   404 for everyone and a viewer without the permission gets 403, never a different centre's data. Scripted tx: SELECT ... FROM micro.instrument_records returns `record`; all else empty.
//   M20/M21/M22 take If-Match `"<record version>"` (missing = 428 common.precondition_required, stale = 409 common.version_conflict).
// ASSUMED (spec silent): an unknown / inactive ignore reason = 400 common.validation_failed path /reason_code (same convention as T-09 withdraw reason); a record already applied/ignored on
//   M20/M21/M22 = 409 micro.instrument_record_conflict (TRD M22 "already applied"; IR table has no transition out of applied/ignored); check order: 404 -> 403 -> 400 body -> 428 -> 409 version -> 409 state.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { failure, mkCtx, MANAGE, READ, run, specOps, WORK, type Row } from './helpers/cultureReads.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const u = (n: number) => `0190c60d-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const REC = u(0x1), CENTRE = u(0x2), CULT = u(0x3), INSTR = u(0x4), MAP = u(0x5);
const BARCODE = 'SENTINEL-BC-5521';

const OPS = {
  listMicroInstrumentRecords: { perm: READ, idem: 'none' }, assignMicroInstrumentRecord: { perm: WORK, idem: 'required' }, applyMicroInstrumentRecord: { perm: WORK, idem: 'required' },
  ignoreMicroInstrumentRecord: { perm: WORK, idem: 'optional' }, listInstrumentVocabMaps: { perm: READ, idem: 'none' }, createInstrumentVocabMap: { perm: MANAGE, idem: 'required' },
  updateInstrumentVocabMap: { perm: MANAGE, idem: 'optional' }, deactivateInstrumentVocabMap: { perm: MANAGE, idem: 'optional' }, listInstrumentAstDefaults: { perm: READ, idem: 'none' },
  putInstrumentAstDefault: { perm: MANAGE, idem: 'optional' },
} as const;
type Op = keyof typeof OPS;
const ids = Object.keys(OPS) as Op[];

describe('C10-T14 contract pins (micro.yaml)', () => {
  it.each(ids)('%s: single x-permission and idempotency class of TRD §5.3 (D-64: GETs = micro.culture.read only)', (id) => {
    const op = specOps()[id];
    expect(op, id).toBeDefined();
    expect(op['x-permission']).toBe(OPS[id].perm);
    expect(op['x-idempotency']).toBe(OPS[id].idem);
    expect(Object.keys(op)).not.toContain('x-permissions');
  });
  it('M20–M22 declare micro.instrument_record_conflict + the If-Match errors; M20/M21 also micro.report_final_locked', () => {
    const o = specOps();
    for (const id of ['assignMicroInstrumentRecord', 'applyMicroInstrumentRecord', 'ignoreMicroInstrumentRecord']) {
      expect(o[id]['x-error-codes'], id).toContain('micro.instrument_record_conflict');
      expect(o[id]['x-error-codes'], id).toContain('common.precondition_required');
      expect(o[id]['x-error-codes'], id).toContain('common.version_conflict');
    }
    for (const id of ['assignMicroInstrumentRecord', 'applyMicroInstrumentRecord']) expect(o[id]['x-error-codes'], id).toContain('micro.report_final_locked');
  });
  it('M34 declares micro.code_duplicate; M35/M36/M38 take If-Match (M38 only when the row exists)', () => {
    const o = specOps();
    expect(o['createInstrumentVocabMap']['x-error-codes']).toContain('micro.code_duplicate');
    for (const id of ['updateInstrumentVocabMap', 'deactivateInstrumentVocabMap']) expect(o[id]['x-error-codes'], id).toContain('common.version_conflict');
  });
});

// ------------------------------------------------------------------ driving a handler with a scripted tx (no database)
const record = (o: Row = {}): Row => ({ id: REC, tenant_id: A, centre_id: CENTRE, version: 4, is_active: true, record_kind: 'organism_id', instrument_id: INSTR, instrument_message_id: u(0x6), sample_barcode: BARCODE,
  instrument_analyte_code: 'ORG:1', isolate_seq: 1, organism_code_raw: 'ESCCOL', match_status: 'pending_match', match_reason: 'lookup_unavailable', received_at: new Date('2026-11-05T03:51:05.410Z'), is_rerun: false,
  culture_id: null, isolate_id: null, ast_result_id: null, ignore_reason_code: null, ignore_comment: null, expires_at: null, created_by: u(0x7), updated_by: u(0x7), ...o });
const vmap = (o: Row = {}): Row => ({ id: MAP, tenant_id: A, instrument_id: INSTR, kind: 'organism', code_raw: 'ESCCOL', local_code: 'syn_ecoli', is_active: true, version: 2, ...o });

function setup(grants: readonly string[], world: { record?: Row; vmap?: Row } = {}) {
  const stmts: { text: string; values: unknown[] }[] = [];
  const logged: unknown[] = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    stmts.push({ text, values });
    if (/^\s*select\b[\s\S]*\bfrom\s+micro\.instrument_records\b/i.test(text) && world.record) return { rows: [world.record], rowCount: 1 };
    if (/^\s*select\b[\s\S]*\bfrom\s+micro\.instrument_vocab_maps\b/i.test(text) && world.vmap) return { rows: [world.vmap], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const { ctx, calls } = mkCtx({ tenantId: A, tx, grants });
  const sink = (...a: unknown[]) => { logged.push(a); };
  ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return ctx.log; } };
  const writes = () => stmts.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.text));
  return { ctx, calls, stmts, logged, writes };
}
const ifm = (v: number | string) => ({ 'if-match': `"${v}"` });
const idem = { 'idempotency-key': 'k-t14-0001' };
const code = (e: any) => (isLimsError(e) ? (e as any).code : String(e));

describe('permissions are the FIRST gate (M19, M33–M38) — a viewer without the permission is 403 and nothing is read or written', () => {
  const calls: [Op, Row][] = [
    ['listMicroInstrumentRecords', {}], ['listInstrumentVocabMaps', {}], ['listInstrumentAstDefaults', {}],
    ['createInstrumentVocabMap', { headers: idem, body: { instrument_id: INSTR, kind: 'organism', code_raw: 'ESCCOL', local_code: 'syn_ecoli' } }],
    ['updateInstrumentVocabMap', { params: { map_id: MAP }, headers: ifm(2), body: { local_code: 'syn_ecoli' } }],
    ['deactivateInstrumentVocabMap', { params: { map_id: MAP }, headers: ifm(2), body: {} }],
    ['putInstrumentAstDefault', { params: { instrument_id: INSTR }, body: { standard: 'CLSI', standard_version: 'M100-2026' } }],
  ];
  it.each(calls)('%s without the permission -> auth.forbidden, zero statements; with it, assertRole saw exactly its x-permission', async (op, req) => {
    const none = setup([]);
    const e = await failure(run(op, req, none.ctx));
    expect(code(e)).toBe('auth.forbidden');
    expect(none.stmts).toHaveLength(0);
    const ok = setup([OPS[op].perm]);
    await run(op, req, ok.ctx).catch(() => undefined);
    expect(ok.calls.assertRole[0]).toMatchObject({ permission: OPS[op].perm });
  });
  it.each([['micro.culture.read', 'createInstrumentVocabMap'], ['micro.culture.work', 'putInstrumentAstDefault'], ['micro.culture.work', 'deactivateInstrumentVocabMap']] as [string, Op][])(
    'holder of %s only cannot manage config (%s) — S-23', async (g, op) => {
      const h = setup([g]);
      const req = op === 'createInstrumentVocabMap' ? { headers: idem, body: { instrument_id: INSTR, kind: 'organism', code_raw: 'X', local_code: 'syn_x' } }
        : op === 'putInstrumentAstDefault' ? { params: { instrument_id: INSTR }, body: { standard: 'CLSI', standard_version: '1' } } : { params: { map_id: MAP }, headers: ifm(2), body: {} };
      expect(code(await failure(run(op, req, h.ctx)))).toBe('auth.forbidden');
      expect(h.writes()).toHaveLength(0);
    });
});

describe('M20–M22: record loaded first (404), then centre-scoped permission (403)', () => {
  const reqs: [Op, Row][] = [
    ['assignMicroInstrumentRecord', { params: { record_id: REC }, headers: { ...idem, ...ifm(4) }, body: { culture_id: CULT } }],
    ['applyMicroInstrumentRecord', { params: { record_id: REC }, headers: { ...idem, ...ifm(4) }, body: {} }],
    ['ignoreMicroInstrumentRecord', { params: { record_id: REC }, headers: ifm(4), body: { reason_code: 'wrong_sample' } }],
  ];
  it.each(reqs)('%s: unknown / invisible id -> common.not_found, no write', async (op, req) => {
    const h = setup([WORK]);
    expect(code(await failure(run(op, req, h.ctx)))).toBe('common.not_found');
    expect(h.writes()).toHaveLength(0);
  });
  it.each(reqs)('%s: without micro.culture.work -> auth.forbidden, assertRole carries the record centre_id, no write', async (op, req) => {
    const h = setup([READ], { record: record() });
    expect(code(await failure(run(op, req, h.ctx)))).toBe('auth.forbidden');
    expect(h.calls.assertRole.at(-1)).toMatchObject({ permission: WORK, centreId: CENTRE });
    expect(h.writes()).toHaveLength(0);
  });
  it.each(reqs)('%s: missing If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing written', async (op, req) => {
    const h = setup([WORK], { record: record() });
    const { 'if-match': _drop, ...noMatch } = req['headers'] as Row;
    expect(code(await failure(run(op, { ...req, headers: noMatch }, h.ctx)))).toBe('common.precondition_required');
    expect(code(await failure(run(op, { ...req, headers: { ...(req['headers'] as Row), ...ifm(3) } }, h.ctx)))).toBe('common.version_conflict');
    expect(h.writes()).toHaveLength(0);
  });
  it.each(reqs)('%s on an already applied / ignored record -> 409 micro.instrument_record_conflict, nothing written (no IR transition out of applied/ignored)', async (op, req) => {
    for (const st of ['applied', 'ignored']) {
      const h = setup([WORK], { record: record({ match_status: st, expires_at: new Date('2027-11-05T00:00:00Z'), ignore_reason_code: st === 'ignored' ? 'duplicate' : null }) });
      expect(code(await failure(run(op, req, h.ctx))), st).toBe('micro.instrument_record_conflict');
      expect(h.writes()).toHaveLength(0);
    }
  });
});

describe('strict bodies (S-05): unknown / forged fields and bad values are 400 common.validation_failed before any write', () => {
  const base = { params: { record_id: REC }, headers: { ...idem, ...ifm(4) } };
  const cases: [string, Op, Row][] = [
    ['assign: missing culture_id', 'assignMicroInstrumentRecord', { body: {} }],
    ['assign: forged match_status', 'assignMicroInstrumentRecord', { body: { culture_id: CULT, match_status: 'applied' } }],
    ['assign: forged expires_at', 'assignMicroInstrumentRecord', { body: { culture_id: CULT, expires_at: '2099-01-01T00:00:00Z' } }],
    ['assign: culture_id not a uuid', 'assignMicroInstrumentRecord', { body: { culture_id: 'nope' } }],
    ['assign: isolate_seq 0', 'assignMicroInstrumentRecord', { body: { culture_id: CULT, isolate_seq: 0 } }],
    ['assign: isolate_seq 100', 'assignMicroInstrumentRecord', { body: { culture_id: CULT, isolate_seq: 100 } }],
    ['assign: resolution outside enum', 'assignMicroInstrumentRecord', { body: { culture_id: CULT, resolution: 'overwrite' } }],
    ['apply: forged culture_id', 'applyMicroInstrumentRecord', { body: { culture_id: CULT } }],
    ['apply: forged ast_result_id', 'applyMicroInstrumentRecord', { body: { ast_result_id: u(0x99) } }],
    ['apply: resolution outside enum', 'applyMicroInstrumentRecord', { body: { resolution: 'merge' } }],
    ['ignore: missing reason_code', 'ignoreMicroInstrumentRecord', { body: {} }],
    ['ignore: comment 301 chars', 'ignoreMicroInstrumentRecord', { body: { reason_code: 'other', comment: 'x'.repeat(301) } }],
    ['ignore: forged match_status', 'ignoreMicroInstrumentRecord', { body: { reason_code: 'other', match_status: 'ignored' } }],
    ['ignore: unknown reason code (coded set micro.record_ignore_reasons)', 'ignoreMicroInstrumentRecord', { body: { reason_code: 'syn_no_such_reason' } }],
  ];
  it.each(cases)('%s', async (_n, op, req) => {
    const h = setup([WORK], { record: record({ match_status: 'pending_match' }) });
    const e = await failure(run(op, { ...base, ...req }, h.ctx));
    expect(code(e)).toBe('common.validation_failed');
    expect(h.writes()).toHaveLength(0);
  });
  const cfg: [string, Op, Row][] = [
    ['M34: kind outside {organism, antibiotic}', 'createInstrumentVocabMap', { headers: idem, body: { instrument_id: INSTR, kind: 'media', code_raw: 'X', local_code: 'syn_x' } }],
    ['M34: code_raw empty', 'createInstrumentVocabMap', { headers: idem, body: { instrument_id: INSTR, kind: 'organism', code_raw: '', local_code: 'syn_x' } }],
    ['M34: code_raw 65 chars', 'createInstrumentVocabMap', { headers: idem, body: { instrument_id: INSTR, kind: 'organism', code_raw: 'x'.repeat(65), local_code: 'syn_x' } }],
    ['M34: local_code not [a-z0-9_]{2,64}', 'createInstrumentVocabMap', { headers: idem, body: { instrument_id: INSTR, kind: 'organism', code_raw: 'X', local_code: 'Syn X' } }],
    ['M34: forged is_active', 'createInstrumentVocabMap', { headers: idem, body: { instrument_id: INSTR, kind: 'organism', code_raw: 'X', local_code: 'syn_x', is_active: false } }],
    ['M34: missing instrument_id', 'createInstrumentVocabMap', { headers: idem, body: { kind: 'organism', code_raw: 'X', local_code: 'syn_x' } }],
    ['M35: code_raw is immutable (not accepted)', 'updateInstrumentVocabMap', { params: { map_id: MAP }, headers: ifm(2), body: { local_code: 'syn_x', code_raw: 'Y' } }],
    ['M36: body must be {}', 'deactivateInstrumentVocabMap', { params: { map_id: MAP }, headers: ifm(2), body: { is_active: true } }],
    ['M38: standard unknown (not allowed as a default)', 'putInstrumentAstDefault', { params: { instrument_id: INSTR }, body: { standard: 'unknown', standard_version: '1' } }],
    ['M38: standard_version empty', 'putInstrumentAstDefault', { params: { instrument_id: INSTR }, body: { standard: 'CLSI', standard_version: '' } }],
    ['M38: standard_version 33 chars', 'putInstrumentAstDefault', { params: { instrument_id: INSTR }, body: { standard: 'CLSI', standard_version: 'v'.repeat(33) } }],
    ['M38: forged version', 'putInstrumentAstDefault', { params: { instrument_id: INSTR }, body: { standard: 'CLSI', standard_version: '1', version: 9 } }],
  ];
  it.each(cfg)('%s', async (_n, op, req) => {
    const h = setup([MANAGE], { vmap: vmap() });
    expect(code(await failure(run(op, req, h.ctx)))).toBe('common.validation_failed');
    expect(h.writes()).toHaveLength(0);
  });
});

describe('M35/M36/M38 If-Match', () => {
  it('M35 / M36 without If-Match -> 428; stale -> 409 common.version_conflict', async () => {
    for (const [op, body] of [['updateInstrumentVocabMap', { local_code: 'syn_ecoli' }], ['deactivateInstrumentVocabMap', {}]] as [Op, Row][]) {
      const h = setup([MANAGE], { vmap: vmap({ version: 2 }) });
      expect(code(await failure(run(op, { params: { map_id: MAP }, headers: {}, body }, h.ctx))), op).toBe('common.precondition_required');
      expect(code(await failure(run(op, { params: { map_id: MAP }, headers: ifm(1), body }, h.ctx))), op).toBe('common.version_conflict');
      expect(h.writes()).toHaveLength(0);
    }
  });
  it('M35 on an unknown map -> 404', async () => {
    const h = setup([MANAGE]);
    expect(code(await failure(run('updateInstrumentVocabMap', { params: { map_id: MAP }, headers: ifm(2), body: { local_code: 'syn_x' } }, h.ctx)))).toBe('common.not_found');
  });
});

describe('barcode (P2) is never logged by the handlers (AC-08.10)', () => {
  it('a failing M21 call logs no barcode', async () => {
    const h = setup([READ], { record: record() });
    await failure(run('applyMicroInstrumentRecord', { params: { record_id: REC }, headers: { ...idem, ...ifm(4) }, body: {} }, h.ctx));
    expect(JSON.stringify(h.logged)).not.toContain(BARCODE);
  });
});
