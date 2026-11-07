// API-T14 — catalog.changed.v1 consumer + instruments.refresh_observed_code_mapping (02-TRD §9.2, §10; AC-17.3).
// Consumer: run through the REAL worker core wrapper (inbox, envelope, known-fields validation) with the core fake world. Refresh task: own fake (helpers.ts).
import { describe, expect, it } from 'vitest';
import { setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { INSTR, T_A, T_B, catalogChanged, makeWorld, rejects, uid, type World } from './helpers.js';

const EVT = 'evt.instruments.catalog.changed.v1';
const REFRESH = 'instruments.refresh_observed_code_mapping';
const payloadOf = (e: any) => ({ event_id: e.event_id, tenant_id: e.tenant_id, event_type: e.event_type });

async function deliver(entityType: string, eventId = uid(0xe1000), over: Record<string, unknown> = {}) {
  const s = await setup([manifest]);
  const e = catalogChanged(entityType, over, eventId);
  s.world.seedEvent(e);
  await s.run(EVT, payloadOf(e));
  return { s, e };
}

describe('consumer: which catalog.changed.v1 entity types enqueue a refresh (AC-17.3)', () => {
  it.each(['instrument_code_map', 'global_reference'])('%s -> one refresh job for the tenant, job_key instruments.refresh:<tenant_id>', async (t) => {
    const { s } = await deliver(t);
    expect(s.world.jobs).toHaveLength(1);
    expect(s.world.jobs[0]).toMatchObject({ identifier: REFRESH, jobKey: `instruments.refresh:${T_A}` });
    expect(s.world.jobs[0]!.payload).toMatchObject({ tenant_id: T_A });
  });

  it('an UNKNOWN (x-extensible) entity_type invalidates everything: refresh enqueued (08 R13)', async () => {
    const { s } = await deliver('future_catalog_kind');
    expect(s.world.jobs.map((j) => j.identifier)).toEqual([REFRESH]);
  });

  it.each(['test', 'analyte', 'panel', 'unit', 'department', 'price_list', 'method', 'catalog_import'])('known other entity type %s is a no-op', async (t) => {
    const { s } = await deliver(t);
    expect(s.world.jobs).toHaveLength(0);
    expect(s.world.inbox).toHaveLength(1);                                   // the event is still recorded as processed
  });

  it('unknown extra payload fields are tolerated (known-fields-only validation)', async () => {
    const e = catalogChanged('instrument_code_map', {}, uid(0xe1001)); e.payload.future_field = 'x'; e.future_envelope_field = 1;
    const s = await setup([manifest]); s.world.seedEvent(e);
    await s.run(EVT, payloadOf(e));
    expect(s.world.jobs).toHaveLength(1);
  });
});

describe('consumer: duplicate delivery and burst coalescing', () => {
  it('the same event delivered twice enqueues once and the second delivery succeeds', async () => {
    const s = await setup([manifest]); const e = catalogChanged('instrument_code_map', {}, uid(0xe1002)); s.world.seedEvent(e);
    await s.run(EVT, payloadOf(e));
    await expect(s.run(EVT, payloadOf(e), { attempts: 2 })).resolves.toBeUndefined();
    expect(s.world.jobs).toHaveLength(1);
    expect(s.world.inbox).toEqual([{ module: 'instruments', tenant_id: T_A, event_id: e.event_id }]);
  });

  it('a burst of different events coalesces into ONE pending refresh job per tenant (same job_key)', async () => {
    const s = await setup([manifest]);
    for (let i = 0; i < 5; i++) { const e = catalogChanged(i % 2 ? 'global_reference' : 'instrument_code_map', {}, uid(0xe1100 + i)); s.world.seedEvent(e); await s.run(EVT, payloadOf(e)); }
    expect(s.world.jobs).toHaveLength(1);
    expect(s.world.inbox).toHaveLength(5);
  });

  it('runs under the instruments system actor and the event tenant only (cross-tenant event is not visible)', async () => {
    const s = await setup([manifest]); const e = catalogChanged('instrument_code_map', { tenant_id: T_B }, uid(0xe1003)); s.world.seedEvent(e);
    await rejects(s.run(EVT, { event_id: e.event_id, tenant_id: T_A, event_type: e.event_type }));
    expect(s.world.jobs).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ refresh task
const obs = (n: number, code: string, over: Record<string, unknown> = {}) => ({
  tenant_id: T_A, instrument_id: INSTR(n), centre_id: uid(0xc001), record_class: 'patient', instrument_analyte_code: code, seen_count: 3,
  last_mapping_status: 'unmapped', last_analyte_id: null, ...over,
});
const ANALYTE = uid(0xa11);
const unmapped = () => Object.assign(new Error('catalog.instrument_code_unmapped'), { code: 'catalog.instrument_code_unmapped' });
const mappingOf = (code: string, instrumentId: string) => ({ mappingId: uid(0x7001), instrumentId, instrumentCode: code, analyteId: ANALYTE, testId: uid(0x7002) });
async function runRefresh(w: World) { await manifest.tasks![REFRESH]!({ tenant_id: T_A }, w.makeCtx()); }
const updates = (w: World) => w.writes().filter((s) => /UPDATE\s+instruments\.observed_codes/i.test(s.text));

describe('AC-17.3 refresh task', () => {
  it('maps every observed code inbound through CatalogPort and updates last_mapping_status / last_analyte_id', async () => {
    const w = makeWorld();
    w.observed.push(obs(1, 'HGB'), obs(1, 'XYZ', { last_mapping_status: 'mapped', last_analyte_id: ANALYTE }));
    w.mapping = async (i: any) => { if (i.instrumentCode === 'XYZ') throw unmapped(); return mappingOf(i.instrumentCode, i.instrumentId); };
    await runRefresh(w);
    expect(w.mapCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ instrumentId: INSTR(1), direction: 'inbound', instrumentCode: 'HGB' }),
      expect.objectContaining({ instrumentId: INSTR(1), direction: 'inbound', instrumentCode: 'XYZ' }),
    ]));
    const u = updates(w);
    const hgb = u.find((s) => w.touches(s, 'HGB'))!, xyz = u.find((s) => w.touches(s, 'XYZ'))!;
    expect(w.touches(hgb, 'mapped', ANALYTE)).toBe(true);
    expect(w.touches(hgb, 'unmapped')).toBe(false);
    expect(w.touches(xyz, 'unmapped')).toBe(true);
    expect(w.touches(xyz, ANALYTE)).toBe(false);                                        // last_analyte_id cleared (null), not kept
    expect(u.every((s) => /last_mapping_checked_at/i.test(s.text))).toBe(true);
  });

  it('a transient catalog failure (not catalog.instrument_code_unmapped) fails the job and never marks a code unmapped', async () => {
    const w = makeWorld();
    w.observed.push(obs(1, 'HGB', { last_mapping_status: 'mapped', last_analyte_id: ANALYTE }));
    w.mapping = async () => { throw Object.assign(new Error('common.dependency_unavailable'), { code: 'common.dependency_unavailable' }); };
    await rejects(runRefresh(w));
    expect(updates(w).filter((s) => w.touches(s, 'unmapped'))).toHaveLength(0);
  });

  it('only the current tenant is read or written: statements bind tenant_id and carry the job claims', async () => {
    const w = makeWorld(); w.observed.push(obs(1, 'HGB')); w.mapping = async (i: any) => mappingOf(i.instrumentCode, i.instrumentId);
    await runRefresh(w);
    for (const s of w.stmts.filter((x) => /instruments\.observed_codes/i.test(x.text))) { expect(s.text).toMatch(/tenant_id/); expect(s.claims).toMatchObject({ tenant_id: T_A }); }
    expect(w.stmts.some((s) => s.values.includes(T_B))).toBe(false);
  });

  it('no observed codes -> no catalog call, no write', async () => {
    const w = makeWorld(); await runRefresh(w);
    expect(w.mapCalls).toHaveLength(0); expect(w.writes()).toHaveLength(0);
  });

  it('never logs the instrument codes beyond counts (codes are instrument metadata, but values/barcodes must not appear)', async () => {
    const w = makeWorld(); w.observed.push(obs(1, 'HGB')); w.mapping = async (i: any) => mappingOf(i.instrumentCode, i.instrumentId);
    await runRefresh(w);
    expect(w.logs.text()).not.toMatch(/barcode|value_raw/i);
  });
});
