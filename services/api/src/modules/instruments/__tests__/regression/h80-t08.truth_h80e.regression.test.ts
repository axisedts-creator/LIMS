// C7 H80-T08 (tester) — regression with the truth_h80e driver registered (08-ADDENDUM-TRUTH-H80E §11; LD-139, 2026-11-13).
// done_when: whole C7 suite green with truth_h80e registered; instrument list shows driver status `generic`; host query stays inert until verified;
// no existing test edited to make it pass. The whole suite is run by H80-T08-verify.cmd; this file adds the truth_h80e-specific regression guards.
// Drivers are seeded from the REAL db/migrations g_drivers rows (readRows, as CI reads them), not hand-made fixtures. Synthetic data only.
// Host-query toggle: the web toggle is H80-T06; here the server side of "disabled until verified" is asserted (go-live refused, host query inert).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRows } from '../ci/driver-registry-check.js';
import { getDriver, listDrivers } from '../../drivers/registry.js';
import { createInstrumentsService } from '../../service/instruments.service.js';
import { GOOD_CHECKLIST, INS, insRow, makeCtx, makePublisher, makeRepo, rejection } from '../instruments.helpers.js';

const REPO = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const MIG = join(REPO, 'db', 'migrations');
const TESTS = fileURLToPath(new URL('../', import.meta.url));
const H80_TCP = { kind: 'tcp_server', bind_address: '10.20.30.40', port: 5100, allowed_peers: ['10.20.30.41'] };
const realRows = () => [...readRows(MIG).values()].map((r) => ({ ...r }));
const h80 = (n: number, o: Record<string, unknown> = {}) => insRow(n, { protocol: 'hl7v2', driver_code: 'truth_h80e', transport: structuredClone(H80_TCP), ...o });

function world(instruments: Array<Record<string, unknown>>) {
  const r = makeRepo({ drivers: realRows(), instruments });
  const c = makeCtx();
  const svc: any = createInstrumentsService({ repo: r.repo, publish: makePublisher().publish, now: () => new Date('2026-11-14T12:00:00.000Z'), allowSketchDrivers: false });
  return { ...r, ...c, svc };
}

describe('H80-T08 registry: truth_h80e joins the drivers, nothing else moves', () => {
  it('the real g_drivers rows list truth_h80e as generic and keep every earlier driver code and status', () => {
    const byCode = new Map(realRows().map((r) => [r['code'], r['status']]));
    expect(byCode.get('truth_h80e')).toBe('generic');
    for (const c of ['astm_generic_e1394', 'hl7v2_generic_oru', 'file_drop_generic', 'getein_metis']) expect(byCode.get(c), c).toBe('generic');
    expect([...byCode.values()].filter((s) => s === 'verified')).toEqual([]);          // no driver is verified by this task (§9 item 9: later reviewed migration)
  });
  it('every code driver has exactly one migration row and the code registry lists truth_h80e', () => {
    const codes = listDrivers().map((d) => d.code);
    expect(codes).toContain('truth_h80e');
    expect(new Set(codes).size).toBe(codes.length);
    expect([...readRows(MIG).keys()].sort()).toEqual(expect.arrayContaining(codes));
    expect(getDriver('truth_h80e')?.status).toBe('generic');
  });
  it('E22 listDrivers (real rows) shows truth_h80e with status generic and host_query declared but not verified', async () => {
    const w = world([]);
    const r = await w.svc.listDrivers(w.ctx, {});
    expect(r.status).toBe(200);
    expect(r.body.data.find((d: any) => d.code === 'truth_h80e')).toMatchObject({ status: 'generic', protocol: 'hl7v2', driver_version: '0.1.0', is_active: true });
    expect((await w.svc.listDrivers(w.ctx, { status: 'verified' })).body.data.map((d: any) => d.code)).not.toContain('truth_h80e');
    expect((await w.svc.listDrivers(w.ctx, { status: 'generic' })).body.data.map((d: any) => d.code)).toContain('truth_h80e');
  });
});

describe('H80-T08 instrument list / detail: driver status generic (AC-04.2; LD-139)', () => {
  it('E23 listInstruments: a truth_h80e instrument reports driver_status generic whatever its state, never verified', async () => {
    const w = world([h80(1, { state: 'draft' }), h80(2, { state: 'commissioning' }), h80(3, { state: 'suspended', cap_host_query: true })]);
    const r = await w.svc.listInstruments(w.ctx, {});
    expect(r.status).toBe(200);
    const mine = r.body.data.filter((i: any) => i.driver_code === 'truth_h80e');
    expect(mine).toHaveLength(3);
    for (const i of mine) expect(i).toMatchObject({ driver_status: 'generic' });
  });
  it('E25 getInstrument: driver_status generic and driver_version 0.1.0', async () => {
    const w = world([h80(1, { state: 'commissioning' })]);
    expect((await w.svc.getInstrument(w.ctx, { instrumentId: INS(1) })).body).toMatchObject({ driver_code: 'truth_h80e', driver_status: 'generic', driver_version: '0.1.0' });
  });
  it('E27 a generic truth_h80e instrument may start commissioning (shadow), E28 go-live is refused with instruments.driver_not_available — host query cannot be switched on live', async () => {
    const w = world([h80(1, { state: 'draft' }), h80(2, { state: 'commissioning' })]);
    expect((await w.svc.startInstrumentCommissioning(w.ctx, { instrumentId: INS(1), expectedVersion: 1 })).status).toBe(200);
    const e: any = await rejection(w.svc.goLiveInstrument(w.ctx, { instrumentId: INS(2), expectedVersion: 1, body: { checklist: GOOD_CHECKLIST, evidence_note: 'synthetic evidence note for the regression' } }));
    expect(e?.code).toBe('instruments.driver_not_available');
    expect(w.callsOf('transitionInstrument').filter((c: any) => c.args[3]?.state === 'live')).toHaveLength(0);
  });
});

describe('H80-T08 no test was weakened to get green (static guard over the C7 test tree)', () => {
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.test\.ts$/.test(e.name) ? [join(d, e.name)] : []));
  const all = files(TESTS).filter((f) => !f.endsWith('h80-t08.truth_h80e.regression.test.ts'));
  it('the suite is not empty (full C7 suite is in scope)', () => { expect(all.length).toBeGreaterThan(40); });
  it('no .skip / .only / .skipIf / .fails / xit / xdescribe anywhere in the C7 tests', () => {
    const bad = all.filter((f) => /\b(it|test|describe)\.(skip|only|skipIf|fails)\b|\bx(it|describe)\(/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('it.todo exists only where already known (hostQuery.getein_metis.test.ts, MET-T03 gap) — no new placeholders', () => {
    const withTodo = all.filter((f) => /\bit\.todo\b/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(TESTS.length).replace(/\\/g, '/'));
    expect(withTodo).toEqual(['hostQuery.getein_metis.test.ts']);
  });
});
