// C7 MET-T07 (tester) — regression with BOTH new drivers (truth_h80e, getein_metis) registered (09-ADDENDUM-GETEIN-METIS §11; LD-163, 2026-11-14).
// done_when: whole C7 suite green with truth_h80e and getein_metis registered; instrument list shows driver status `generic` for both;
// host-query toggle disabled until verified; no existing test edited to make it pass. The whole suite is run by MET-T07-verify.cmd;
// this file adds the both-drivers regression guards. Drivers are seeded from the REAL db/migrations g_drivers rows (readRows). Synthetic data only.
// Host-query toggle: the web toggle is MET-T05/H80-T06 (apps/web); here the server side of "disabled until verified" is asserted
// (go-live refused with instruments.driver_not_available; the driver is not `verified`, which is what gates a live host query).
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
const NEW = ['truth_h80e', 'getein_metis'] as const;
const TCP = { kind: 'tcp_server', bind_address: '10.20.30.40', port: 5100, allowed_peers: ['10.20.30.41'] };
const realRows = () => [...readRows(MIG).values()].map((r) => ({ ...r }));
const mk = (code: string, n: number, o: Record<string, unknown> = {}) => insRow(n, { protocol: 'hl7v2', driver_code: code, transport: structuredClone(TCP), ...o });

function world(instruments: Array<Record<string, unknown>>) {
  const r = makeRepo({ drivers: realRows(), instruments });
  const c = makeCtx();
  const svc: any = createInstrumentsService({ repo: r.repo, publish: makePublisher().publish, now: () => new Date('2026-11-14T12:00:00.000Z'), allowSketchDrivers: false });
  return { ...r, ...c, svc };
}

describe('MET-T07 registry: both new drivers are generic, nothing is verified', () => {
  it('the real g_drivers rows list truth_h80e and getein_metis as generic; no driver in the DB is verified', () => {
    const byCode = new Map(realRows().map((r) => [r['code'], r['status']]));
    for (const c of NEW) expect(byCode.get(c), c).toBe('generic');
    for (const c of ['astm_generic_e1394', 'hl7v2_generic_oru', 'file_drop_generic']) expect(byCode.has(c), c).toBe(true);
    expect([...byCode.values()].filter((s) => s === 'verified')).toEqual([]);   // promotion = a later reviewed migration (§9)
  });
  it('the code registry lists both drivers once, each with a migration row, both generic', () => {
    const codes = listDrivers().map((d) => d.code);
    for (const c of NEW) { expect(codes, c).toContain(c); expect(getDriver(c)?.status, c).toBe('generic'); }
    expect(new Set(codes).size).toBe(codes.length);
    expect([...readRows(MIG).keys()].sort()).toEqual(expect.arrayContaining(codes));
  });
  it('getein_metis row: hl7v2, vendor Getein, version 0.1.0, host query declared (cap_host_query) but worklist download not', () => {
    const row = realRows().find((r) => r['code'] === 'getein_metis') as Record<string, unknown>;
    expect(row).toMatchObject({ protocol: 'hl7v2', status: 'generic', driver_version: '0.1.0', cap_host_query: true, cap_worklist_download: false });
  });
  it('E22 listDrivers (real rows): both generic and active; status filter verified lists neither, generic lists both', async () => {
    const w = world([]);
    const r = await w.svc.listDrivers(w.ctx, {});
    expect(r.status).toBe(200);
    for (const c of NEW) expect(r.body.data.find((d: any) => d.code === c), c).toMatchObject({ status: 'generic', protocol: 'hl7v2', is_active: true });
    const verified = (await w.svc.listDrivers(w.ctx, { status: 'verified' })).body.data.map((d: any) => d.code);
    const generic = (await w.svc.listDrivers(w.ctx, { status: 'generic' })).body.data.map((d: any) => d.code);
    for (const c of NEW) { expect(verified).not.toContain(c); expect(generic).toContain(c); }
  });
});

describe('MET-T07 instrument list / detail: driver status generic for both (AC-04.2; LD-139, LD-163)', () => {
  it('E23 listInstruments: truth_h80e and getein_metis instruments side by side report driver_status generic in every state', async () => {
    const w = world([
      mk('truth_h80e', 1, { state: 'draft' }), mk('truth_h80e', 2, { state: 'commissioning' }),
      mk('getein_metis', 3, { state: 'draft' }), mk('getein_metis', 4, { state: 'commissioning' }), mk('getein_metis', 5, { state: 'suspended', cap_host_query: true }),
    ]);
    const r = await w.svc.listInstruments(w.ctx, {});
    expect(r.status).toBe(200);
    for (const c of NEW) {
      const mine = r.body.data.filter((i: any) => i.driver_code === c);
      expect(mine.length, c).toBeGreaterThan(0);
      for (const i of mine) expect(i, c).toMatchObject({ driver_status: 'generic' });
    }
    expect(r.body.data.filter((i: any) => i.driver_code === 'getein_metis')).toHaveLength(3);
  });
  it('E25 getInstrument getein_metis: driver_status generic, driver_version 0.1.0', async () => {
    const w = world([mk('getein_metis', 1, { state: 'commissioning' })]);
    expect((await w.svc.getInstrument(w.ctx, { instrumentId: INS(1) })).body).toMatchObject({ driver_code: 'getein_metis', driver_status: 'generic', driver_version: '0.1.0' });
  });
  it('E27 a generic getein_metis instrument may start commissioning (shadow); E28 go-live is refused with instruments.driver_not_available — host query cannot go live', async () => {
    const w = world([mk('getein_metis', 1, { state: 'draft' }), mk('getein_metis', 2, { state: 'commissioning', cap_host_query: true })]);
    expect((await w.svc.startInstrumentCommissioning(w.ctx, { instrumentId: INS(1), expectedVersion: 1 })).status).toBe(200);
    const e: any = await rejection(w.svc.goLiveInstrument(w.ctx, { instrumentId: INS(2), expectedVersion: 1, body: { checklist: GOOD_CHECKLIST, evidence_note: 'synthetic evidence note for the regression' } }));
    expect(e?.code).toBe('instruments.driver_not_available');
    expect(w.callsOf('transitionInstrument').filter((c: any) => c.args[3]?.state === 'live')).toHaveLength(0);
  });
  it('E28 same refusal for truth_h80e next to getein_metis (adding the second driver did not change the first)', async () => {
    const w = world([mk('truth_h80e', 1, { state: 'commissioning' })]);
    const e: any = await rejection(w.svc.goLiveInstrument(w.ctx, { instrumentId: INS(1), expectedVersion: 1, body: { checklist: GOOD_CHECKLIST, evidence_note: 'synthetic evidence note for the regression' } }));
    expect(e?.code).toBe('instruments.driver_not_available');
  });
});

describe('MET-T07 no test was weakened to get green (static guard over the C7 test tree)', () => {
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.test\.ts$/.test(e.name) ? [join(d, e.name)] : []));
  const all = files(TESTS).filter((f) => !f.endsWith('met-t07.getein_metis.regression.test.ts'));
  it('the suite is not empty and includes both new drivers\' tests and the H80-T08 regression', () => {
    expect(all.length).toBeGreaterThan(40);
    const rel = all.map((f) => f.slice(TESTS.length).replace(/\\/g, '/'));
    expect(rel).toEqual(expect.arrayContaining(['hostQuery.getein_metis.test.ts', 'ingest.getein_metis.test.ts', 'hostQuery.truth_h80e.test.ts', 'regression/h80-t08.truth_h80e.regression.test.ts']));
  });
  it('no skip / only / skipIf / fails / xit / xdescribe anywhere in the C7 tests', () => {
    const bad = all.filter((f) => /\b(it|test|describe)\.(skip|only|skipIf|fails)\b|\bx(it|describe)\(/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('todo placeholders exist only where already known (hostQuery.getein_metis.test.ts, MET-T03 gap) — no new ones', () => {
    const withTodo = all.filter((f) => /\bit\.todo\(/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(TESTS.length).replace(/\\/g, '/'));
    expect(withTodo).toEqual(['hostQuery.getein_metis.test.ts']);
  });
});
