// C7 API-T05 — E32 listObservedInstrumentCodes (AC-17.1 server half: the codes observed from an instrument with their current mapping status; review #32).
// Seams: instruments.helpers.ts header. The C3 maps themselves (listInstrumentCodeMaps) are read by the web BFF, not by this endpoint.
import { describe, expect, it } from 'vitest';
import { createObservedCodesService } from '../service/observedCodes.service.js';
import { responseViolations } from './agents.contract.js';
import { onlyCentre } from './agents.helpers.js';
import { CENTRE_A1, CENTRE_A2, INS, TENANT_A, TENANT_B, idN, insRow, makeCtx, makeRepo, obsRow, readOnly, rejection, type FakeSeed } from './instruments.helpers.js';

function world(seed: FakeSeed = {}, ctxOver: Parameters<typeof makeCtx>[0] = {}) {
  const r = makeRepo({ instruments: [insRow(1, { state: 'live' }), insRow(2, { centre_id: CENTRE_A2, agent_id: idN(0x1001) }), insRow(3, { tenant_id: TENANT_B })], ...seed });
  const c = makeCtx(ctxOver);
  const svc: any = createObservedCodesService({ repo: r.repo });
  return { ...r, ...c, svc };
}
const code = (e: any) => e?.code;
const OBS = () => [
  obsRow('GLU'), obsRow('NA', { last_mapping_status: 'unmapped', last_analyte_id: undefined }), obsRow('QCGLU', { record_class: 'qc' }),
  obsRow('CAL1', { record_class: 'calibrator', last_mapping_status: 'unmapped', last_analyte_id: undefined }),
  obsRow('OTHER-INS', { instrument_id: INS(2), centre_id: CENTRE_A2 }), obsRow('OTHER-TENANT', { tenant_id: TENANT_B, instrument_id: INS(3) }),
];
const list = (w: any, q: Record<string, unknown> = {}) => w.svc.listObservedInstrumentCodes(w.ctx, { instrumentId: INS(1), ...q });

describe('E32 — AC-17.1', () => {
  it('lists the instrument\'s observed codes with mapping status, 200, schema-valid ObservedCode rows (no tenant/centre/updated_* leak), page.limit 50; asserts read at the instrument\'s centre', async () => {
    const w = world({ observed: OBS() });
    const r = await list(w);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.instrument_analyte_code).sort()).toEqual(['CAL1', 'GLU', 'NA', 'QCGLU']);
    expect(r.body.page).toMatchObject({ limit: 50 });
    expect(responseViolations('listObservedInstrumentCodes', '200', r.body)).toEqual([]);
    expect(r.body.data.find((x: any) => x.instrument_analyte_code === 'GLU')).toEqual({
      instrument_id: INS(1), record_class: 'patient', instrument_analyte_code: 'GLU', first_seen_at: '2026-11-06T04:00:00.000Z', last_seen_at: '2026-11-06T04:05:00.000Z', seen_count: 12,
      last_mapping_status: 'mapped', last_analyte_id: idN(0xb001), last_mapping_checked_at: '2026-11-06T04:05:00.000Z',
    });
    const na = r.body.data.find((x: any) => x.instrument_analyte_code === 'NA');
    expect(na.last_mapping_status).toBe('unmapped'); expect('last_analyte_id' in na).toBe(false);          // unmapped: analyte omitted, never null
    const s = JSON.stringify(r.body); for (const f of ['tenant_id', 'centre_id', 'updated_by', 'updated_at']) expect(s, f).not.toContain(`"${f}"`);
    expect(w.asserted).toEqual([{ permission: 'instruments.instrument.read', centreId: CENTRE_A1 }]);
  });
  it('another instrument\'s (same tenant) and another tenant\'s codes never appear', async () => {
    const w = world({ observed: OBS() });
    const s = JSON.stringify((await list(w)).body);
    expect(s).not.toContain('OTHER-INS'); expect(s).not.toContain('OTHER-TENANT');
    expect(w.callsOf('listObservedCodes')[0]!.tenantId).toBe(TENANT_A);
  });
  it('filters record_class and mapping_status are passed to the repo (unmapped codes are what the mappings panel needs first)', async () => {
    const w = world({ observed: OBS() });
    expect((await list(w, { mappingStatus: 'unmapped' })).body.data.map((x: any) => x.instrument_analyte_code).sort()).toEqual(['CAL1', 'NA']);
    expect((await list(w, { recordClass: 'qc' })).body.data.map((x: any) => x.instrument_analyte_code)).toEqual(['QCGLU']);
    expect(w.callsOf('listObservedCodes')[0]!.args[1]).toMatchObject({ mappingStatus: 'unmapped' });
    expect(w.callsOf('listObservedCodes')[1]!.args[1]).toMatchObject({ recordClass: 'qc' });
  });
  it('an instrument with no observed codes -> 200 { data: [], page }', async () => {
    const w = world({ observed: [] });
    const r = await list(w);
    expect(r.status).toBe(200); expect(r.body.data).toEqual([]); expect(responseViolations('listObservedInstrumentCodes', '200', r.body)).toEqual([]);
  });
  it('repo next cursor is surfaced as page.next_cursor; limit is passed through', async () => {
    const w = world({ observed: OBS() });
    w.repo.listObservedCodes = async () => ({ rows: [obsRow('GLU')], nextCursor: 'opaque-cursor' });
    const r = await list(w, { limit: 1 });
    expect(r.body.page).toEqual({ limit: 1, next_cursor: 'opaque-cursor' });
    expect(responseViolations('listObservedInstrumentCodes', '200', r.body)).toEqual([]);
  });
  it.each([[{ recordClass: 'other' }, '/record_class'], [{ recordClass: 'host_query' }, '/record_class'], [{ mappingStatus: 'maybe' }, '/mapping_status'], [{ limit: 0 }, '/limit'], [{ limit: 201 }, '/limit'], [{ limit: 1.5 }, '/limit']])(
    'invalid query %j -> 400 common.validation_failed at %s, repo not queried', async (q, path) => {
      const w = world({ observed: OBS() }); const e = await rejection(list(w, q));
      expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe(path);
      expect(w.callsOf('listObservedCodes')).toHaveLength(0);
    });
  it('malformed cursor -> common.invalid_cursor', async () => {
    const w = world({ observed: OBS() });
    expect(code(await rejection(list(w, { cursor: 'x'.repeat(513) })))).toBe('common.invalid_cursor');
    expect(code(await rejection(list(w, { cursor: '' })))).toBe('common.invalid_cursor');
  });
  it('S-01/S-02: unknown / non-uuid / foreign-tenant instrument -> 404 and the codes are never read; other-centre principal -> 403; user without instrument.read -> 403', async () => {
    const w = world({ observed: OBS() });
    for (const instrumentId of [idN(0xdead), 'not-a-uuid', INS(3)]) expect(code(await rejection(w.svc.listObservedInstrumentCodes(w.ctx, { instrumentId })))).toBe('common.not_found');
    const b = world({ observed: OBS() }, { roles: onlyCentre(CENTRE_A2) });
    expect(code(await rejection(list(b)))).toBe('auth.forbidden');
    const c = world({ observed: OBS() }, { roles: () => { throw Object.assign(new Error('x'), { code: 'auth.forbidden' }); } });
    expect(code(await rejection(list(c)))).toBe('auth.forbidden');
    expect(w.callsOf('listObservedCodes').length + b.callsOf('listObservedCodes').length + c.callsOf('listObservedCodes').length).toBe(0);
  });
  it('read-only: a technologist-level principal (instrument.read) CAN list; no catalog permission is required for E32; no write happens', async () => {
    const w = world({ observed: OBS() }, { roles: readOnly });
    expect((await list(w)).status).toBe(200);
    expect(w.asserted.every((a) => a.permission === 'instruments.instrument.read')).toBe(true);
    expect(w.mutations()).toHaveLength(0);
  });
  it('fail closed without tenant / actor / tx -> auth.unauthenticated, repo untouched', async () => {
    const w = world({ observed: OBS() });
    for (const bad of [{}, { tenantId: 'x' }, { ...w.ctx, tx: undefined }]) expect(code(await rejection(w.svc.listObservedInstrumentCodes(bad, { instrumentId: INS(1) })))).toBe('auth.unauthenticated');
    expect(w.calls).toHaveLength(0);
  });
});
