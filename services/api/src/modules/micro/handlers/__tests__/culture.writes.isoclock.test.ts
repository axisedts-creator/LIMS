// T0D-FIX-6 (LD-448): micro culture WRITE paths (M3 setupCulture, M4 addCulturePlate, M6 recordCultureObservation) with ctx.now() returning an ISO STRING, as core/pipeline/index.ts:169 does.
// culture.service.ts nowOf() types the clock as a Date and calls .getTime() / .toISOString() on it. Each scenario runs with a Date clock (control) and with the string; before the fix the string
// rows fail with `... is not a function`. In-memory world of helpers/cultureWrites.ts, no database, synthetic data only.
import { describe, expect, it } from 'vitest';
import { failure, mkCtx, run, WORK, READ } from './helpers/cultureReads.js';
import { fakeTx, iso, NOW, type Row, type World } from './helpers/cultureWrites.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c608-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE = u(0xa1), CENTRE_B = u(0xb1);
const USER = '01a1b34e-1000-7eee-9d29-d7ca59a10001', MEMBER = '01a1a98a-ac40-7000-8000-00000000a500';
const C_SETUP = u(0x1001), C_INC = u(0x1002), C_B = u(0x1008), P_INC = u(0x2001), MISSING = u(0x10ff);
const ISO_NOW = NOW.toISOString();
const CLOCKS: [string, () => unknown][] = [['Date clock', () => NOW], ['ISO string clock (the pipeline)', () => ISO_NOW]];
const PLANTED = '2026-11-04T05:00:00.000Z';

const culture = (id: string, status: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE, order_id: u(0x801), order_item_id: u(0x802), specimen_id: u(0x900), patient_id: u(0xa00), test_id: u(0x701), specimen_type_code: 'urine', specimen_site_code: null,
  barcode_snapshot: null, plating_protocol_id: null, status, outcome_code: null, received_at: new Date('2026-11-04T04:00:00.000Z'), planted_at: status === 'awaiting_setup' ? null : new Date(PLANTED),
  next_read_due_at: null, final_due_at: null, last_specimen_seq: 1, current_report_version_no: 0, last_report_phase: null, chain_cancelled: false, amendment_reason_code: null, amendment_reason_text: null,
  cancel_reason_code: null, cancel_comment: null, cancelled_at: null, version: id === C_SETUP ? 3 : 5, is_active: true, created_at: new Date(PLANTED), created_by: USER, updated_at: new Date(PLANTED), updated_by: USER, ...over,
});
const world = (): World => ({
  cultures: [culture(C_SETUP, 'awaiting_setup'), culture(C_INC, 'incubating'), culture(C_B, 'awaiting_setup', { tenant_id: B, centre_id: CENTRE_B })],
  culture_plates: [{ id: P_INC, tenant_id: A, centre_id: CENTRE, culture_id: C_INC, plate_no: 1, media_code: 'syn_blood', incubation_text: null, parent_plate_id: null, source_isolate_id: null,
    planted_at: new Date(PLANTED), planted_by_membership_id: MEMBER, status: 'active', discarded_at: null, version: 2, is_active: true, created_at: new Date(PLANTED), created_by: USER, updated_at: new Date(PLANTED), updated_by: USER }],
  culture_observations: [], isolates: [], culture_transitions: [], instrument_records: [], report_versions: [], settings: [], plating_protocols: [], plating_protocol_media: [], plating_protocol_keys: [],
  v_media: [{ code: 'syn_blood', display: 'Synthetic blood agar', is_active: true }, { code: 'syn_mac', display: 'Synthetic MacConkey', is_active: true }],
  v_growth_codes: [{ code: 'syn_heavy', display: 'Heavy growth', is_active: true, indicates_growth: true }, { code: 'no_growth', display: 'No growth', is_active: true, indicates_growth: false }],
  v_specimen_sites: [], v_organisms: [], v_antibiotics: [],
});
function setup(clock: () => unknown, grants: readonly string[] = [WORK], tenantId = A) {
  const w = world();
  const { tx, log } = fakeTx(w);
  const { ctx, calls } = mkCtx({ tenantId, tx, grants, members: { [MEMBER]: 'Synthetic Tech' }, users: { [USER]: 'Synthetic User' }, tests: { [u(0x701)]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
  ctx.events = { publish: async () => ({ eventId: 'e', duplicate: false }) };
  ctx.now = clock;
  return { ctx, calls, log, w };
}
const KEY = { 'idempotency-key': 'syn-key-1' };
const rowOf = (w: World, table: string, id: string) => w[table]!.find((r) => r['id'] === id)!;

describe.each(CLOCKS)('micro culture writes, %s', (_n, clock) => {
  it('M3 setupCulture without planted_at: planted_at and the transition time are the clock instant, the culture moves to incubating', async () => {
    const s = setup(clock);
    const r = await run('setupCulture', { params: { culture_id: C_SETUP }, headers: { ...KEY, 'if-match': '"3"' }, body: { plates: [{ media_code: 'syn_blood' }, { media_code: 'syn_mac' }] } }, s.ctx);
    expect(r.status ?? 200).toBe(200);
    expect(rowOf(s.w, 'cultures', C_SETUP)['status']).toBe('incubating');
    expect(iso(rowOf(s.w, 'cultures', C_SETUP)['planted_at'])).toBe(ISO_NOW);
    expect(s.w['culture_plates']!.filter((p) => p['culture_id'] === C_SETUP).map((p) => iso(p['planted_at']))).toEqual([ISO_NOW, ISO_NOW]);
    expect(s.w['culture_transitions']!.map((t) => iso(t['occurred_at']))).toEqual([ISO_NOW]);
  });
  it('M3 with a planted_at 24 h ago is accepted; one in the future is a typed 400 (the window is measured against the clock instant)', async () => {
    const ok = setup(clock);
    await run('setupCulture', { params: { culture_id: C_SETUP }, headers: { ...KEY, 'if-match': '"3"' }, body: { plates: [{ media_code: 'syn_blood' }], planted_at: PLANTED } }, ok.ctx);
    expect(iso(rowOf(ok.w, 'cultures', C_SETUP)['planted_at'])).toBe(PLANTED);
    const bad = setup(clock);
    const e = await failure(run('setupCulture', { params: { culture_id: C_SETUP }, headers: { ...KEY, 'if-match': '"3"' }, body: { plates: [{ media_code: 'syn_blood' }], planted_at: '2026-11-05T06:00:00.000Z' } }, bad.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]);
  });
  it('M4 addCulturePlate without planted_at: the new plate is planted at the clock instant', async () => {
    const s = setup(clock);
    await run('addCulturePlate', { params: { culture_id: C_INC }, headers: KEY, body: { media_code: 'syn_mac' } }, s.ctx);
    const plates = s.w['culture_plates']!.filter((p) => p['culture_id'] === C_INC).sort((a, b) => a['plate_no'] - b['plate_no']);
    expect(plates).toHaveLength(2);
    expect(iso(plates[1]!['planted_at'])).toBe(ISO_NOW);
  });
  it('M6 recordCultureObservation without observed_at: observed_at is the clock instant, hours since planting computed from it (24 h)', async () => {
    const s = setup(clock);
    await run('recordCultureObservation', { params: { culture_id: C_INC }, headers: KEY, body: { kind: 'plate_read', plate_id: P_INC, growth_code: 'no_growth' } }, s.ctx);
    const [o] = s.w['culture_observations']!;
    expect(iso(o!['observed_at'])).toBe(ISO_NOW);
    expect(Number(o!['hours_since_planting'])).toBeCloseTo(24, 1);
  });
});

describe.each(CLOCKS)('micro culture writes, security and bad input with the %s', (_n, clock) => {
  it('forbidden: a read-only user gets 403 auth.forbidden and nothing is written', async () => {
    const s = setup(clock, [READ]);
    const e = await failure(run('setupCulture', { params: { culture_id: C_SETUP }, headers: { ...KEY, 'if-match': '"3"' }, body: { plates: [{ media_code: 'syn_blood' }] } }, s.ctx));
    expect(e.code).toBe('auth.forbidden');
    expect(s.w['culture_transitions']).toEqual([]);
  });
  it('other tenant: a culture of tenant B is the same 404 as a missing one', async () => {
    const s = setup(clock);
    const e1 = await failure(run('addCulturePlate', { params: { culture_id: C_B }, headers: KEY, body: { media_code: 'syn_mac' } }, s.ctx));
    const e2 = await failure(run('addCulturePlate', { params: { culture_id: MISSING }, headers: KEY, body: { media_code: 'syn_mac' } }, setup(clock).ctx));
    expect([e1.code, e1.statusCode]).toEqual(['common.not_found', 404]);
    expect(e2.code).toBe(e1.code);
  });
  it('empty data / bad input: a body with no plates and no protocol is a typed 400, not a 500', async () => {
    const s = setup(clock);
    const e = await failure(run('setupCulture', { params: { culture_id: C_SETUP }, headers: { ...KEY, 'if-match': '"3"' }, body: {} }, s.ctx));
    expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]);
  });
});

describe('micro culture writes: a clock value that is not a date', () => {
  it('ctx.now() returning garbage in setupCulture -> a typed LimsError (never a TypeError, nothing written)', async () => {
    const s = setup(() => 'garbage');
    const e = await failure(run('setupCulture', { params: { culture_id: C_SETUP }, headers: { ...KEY, 'if-match': '"3"' }, body: { plates: [{ media_code: 'syn_blood' }] } }, s.ctx));
    expect(e.name).toBe('LimsError');
    expect(s.w['culture_transitions']).toEqual([]);
  });
});
