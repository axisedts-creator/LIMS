// C6-T08 self-check of the test harness (assemble.helpers.ts) — passes without any implementation. If this fails, the harness (not the task) is wrong.
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../../../../api/src/modules/reporting/domain/readiness.js';
import { ITEM, LAB, MASKED_NAME, FULL_NAME, I, TENANT_A, expectedFingerprint, makePorts, mutex, setup, versionRow, wrapTx, world, HASH_1, OUT_FILE, sha256 } from './assemble.helpers.js';

describe('harness self-check', () => {
  it('world: laboratory report + 3 item rows (+ narrative item in combined mode, removed item on request), input file confirmed', () => {
    const w = world(); expect(w.db.items().filter((r) => r['report_id'] === LAB).map((r) => r['order_item_id']).sort()).toEqual([ITEM.urine, ITEM.ratio, ITEM.out].sort());
    expect(w.report()).toMatchObject({ needs_assembly: true, lab_approved_set_hash: HASH_1, latest_version_no: 0 }); expect(w.db.all('reporting.input_files')[0]).toMatchObject({ id: OUT_FILE, state: 'confirmed' });
    expect(world({ combined: true }).db.items()).toHaveLength(4); expect(world({ removedItem: true }).db.items().some((r) => r['item_status'] === 'removed')).toBe(true);
    expect(world({ versions: [versionRow(1), versionRow(2)] }).report()['latest_version_no']).toBe(2);
  });
  it('expectedFingerprint = domain fingerprint over the ready lines, and depends on hash / counter / item set', () => {
    expect(expectedFingerprint(['urine', 'ratio', 'out'])).toBe(fingerprint({ items: [
      { orderItemId: ITEM.urine, approvedSetHash: HASH_1, narrativeVersionIds: [] }, { orderItemId: ITEM.ratio, approvedSetHash: HASH_1, narrativeVersionIds: [] },
      { orderItemId: ITEM.out, narrativeVersionIds: [], inputFileId: OUT_FILE }], regenerationCounter: 0 }));
    const a = expectedFingerprint(['urine']); expect(a).not.toBe(expectedFingerprint(['urine', 'ratio'])); expect(a).not.toBe(expectedFingerprint(['urine'], 1)); expect(a).not.toBe(expectedFingerprint(['urine'], 0, 'b'.repeat(64)));
  });
  it('wrapTx applies ORDER BY ... DESC and LIMIT (the base fake ignores them)', async () => {
    const w = world({ versions: [versionRow(1), versionRow(2), versionRow(3)] }); const tx = wrapTx(w.db.tx, mutex());
    const r = await tx.query('SELECT version_no FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 ORDER BY version_no DESC LIMIT 1', [TENANT_A, LAB]);
    expect(r.rows.map((x: any) => x.version_no)).toEqual([3]);
    const all = await tx.query('SELECT version_no FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 ORDER BY version_no', [TENANT_A, LAB]); expect(all.rows.map((x: any) => x.version_no)).toEqual([1, 2, 3]);
  });
  it('FOR UPDATE on reporting.reports serialises two transactions until release()', async () => {
    const w = world(); const m = mutex(); const a = wrapTx(w.db.tx, m); const b = wrapTx(w.db.tx, m); const q = 'SELECT id FROM reporting.reports WHERE tenant_id = $1 AND id = $2 FOR UPDATE';
    const order: string[] = []; await a.query(q, [TENANT_A, LAB]); order.push('a-locked');
    const pb = b.query(q, [TENANT_A, LAB]).then(() => order.push('b-locked'));
    await new Promise((r) => setTimeout(r, 20)); expect(order).toEqual(['a-locked']);
    a.release(); await pb; expect(order).toEqual(['a-locked', 'b-locked']); b.release();
  });
  it('ports: full name only for report_render, masked for portal_display, other purposes refused; settings carry partialReleaseAllowed', async () => {
    const { ports } = makePorts({ partialReleaseAllowed: true });
    expect((await ports.frontdesk.getPatientDemographics({}, { patientId: I.patient, purpose: 'report_render' })).fullName).toBe(FULL_NAME);
    expect((await ports.frontdesk.getPatientDemographics({}, { patientId: I.patient, purpose: 'portal_display' })).fullName).toBe(MASKED_NAME);
    await expect(ports.frontdesk.getPatientDemographics({}, { patientId: I.patient, purpose: 'notification' })).rejects.toThrow();
    expect((await ports.identity.getTenantSettings({}, { keys: ['partialReleaseAllowed'] })).partialReleaseAllowed).toBe(true);
    const r = await ports.lab.getOrderResults({}, { orderId: I.order, scope: 'approved' }); expect(r.items.map((g: any) => g.orderItemId).sort()).toEqual([ITEM.urine, ITEM.ratio].sort());
  });
  it('setup(): ctx carries tenant, system actor, ports, storage, metrics; instrument attachment is stored and reachable only when requested', async () => {
    const s = setup({ attachment: true }); const c = s.ctx();
    expect(c.tenantId).toBe(TENANT_A); expect(c.ports.lab).toBeTruthy(); expect(typeof c.storage.read).toBe('function'); expect(typeof c.metrics.inc).toBe('function');
    const r = await s.ports.ports.lab.getOrderResults({}, { orderId: I.order, scope: 'approved' }); const ph = r.items.flatMap((g: any) => g.results).find((x: any) => x.analyteId === I.aPh);
    expect(ph.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/); expect(sha256('x')).toHaveLength(64);
  });
});
