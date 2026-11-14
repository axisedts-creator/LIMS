// C7 INT-T03 — static half of the probe suite (07-SECURITY §6 S-01/S-02/S-05; REQ-SEC-072, REQ-SEC-099). No database, no fakes: the contract and the handler map.
//   - the probe suite covers exactly the operations of contracts/openapi/instruments.yaml (E01-E08, E10-E42 = 41; there is no E09) and every one is served by a REAL handler (not the `common.internal` stub);
//   - the security scheme splits the operations: the 8 agent operations accept the device token only, the 33 staff operations the bearer JWT only (AB3: a device token on a staff operation -> 401 by scheme mismatch);
//   - the device permission set is instruments.ingest.* only (REQ-SEC-072); no staff operation can be satisfied by an ingest permission; no operation is public (REQ-SEC-099).
import { describe, expect, it } from 'vitest';
import { INSTRUMENTS_PERMISSIONS } from '../../permissions.js';
import { OPENAPI_OPS, isDeviceOp } from './harness.js';
import { DEVICE_PROBES } from './matrix.device.js';
import { STAFF_PROBES } from './matrix.staff.js';

const { manifest } = await import('../../index.js');
const DEVICE = OPENAPI_OPS.filter(isDeviceOp), STAFF = OPENAPI_OPS.filter((o) => !isDeviceOp(o));

describe('operation coverage (100 %)', () => {
  it('the contract has the 41 operations E01-E08 + E10-E42', () => {
    expect(OPENAPI_OPS).toHaveLength(41); expect(DEVICE).toHaveLength(8); expect(STAFF).toHaveLength(33);
  });
  it('every contract operation has a probe, and every probe belongs to a contract operation (no stale entries)', () => {
    const ids = OPENAPI_OPS.map((o) => o.id).sort();
    expect([...Object.keys(DEVICE_PROBES), ...Object.keys(STAFF_PROBES)].sort()).toEqual(ids);
    expect(Object.keys(DEVICE_PROBES).sort()).toEqual(DEVICE.map((o) => o.id).sort());
    expect(Object.keys(STAFF_PROBES).sort()).toEqual(STAFF.map((o) => o.id).sort());
  });
  it('every contract operation is served by a real handler: calling it without a request context answers auth.unauthenticated, never the common.internal "not implemented" stub', async () => {
    const stubs: string[] = [];
    for (const o of OPENAPI_OPS) {
      const h = (manifest.handlers as Record<string, (r: unknown, c: unknown) => Promise<unknown>>)[o.id];
      try { await h!({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: o.id }); stubs.push(`${o.id}: answered`); } catch (e: any) { if (e?.code !== 'auth.unauthenticated') stubs.push(`${o.id}: ${e?.code ?? e}`); }
    }
    expect(stubs, 'operations without a real, fail-closed handler').toEqual([]);
  });
});

describe('S-05 / AB3 device scope (contract)', () => {
  it('agent operations: security = deviceToken only; permission is an instruments.ingest.* code', () => {
    for (const o of DEVICE) { expect(o.security, o.id).toEqual(['deviceToken']); expect(o.permission, o.id).toMatch(/^instruments\.ingest\.(enrol|submit|heartbeat|host_query|config_read)$/); }
  });
  it('staff operations: security = bearerJwt only (a device token cannot authenticate them -> 401), and none needs an ingest permission', () => {
    for (const o of STAFF) { expect(o.security, o.id).toEqual(['bearerJwt']); expect(o.permission, o.id).toMatch(/^instruments\.(agent|instrument|message)\.(read|manage|rematch)$/); }
  });
  it('the device permission set excludes lab.* and instruments.message.* / agent.* / instrument.* (REQ-SEC-072)', () => {
    const devicePerms = new Set(DEVICE.map((o) => o.permission));
    for (const p of devicePerms) { expect(p.startsWith('lab.'), p).toBe(false); expect(/^instruments\.(message|agent|instrument)\./.test(p), p).toBe(false); }
    expect([...devicePerms].sort()).toEqual(INSTRUMENTS_PERMISSIONS.filter((p) => p.startsWith('instruments.ingest.')).sort());   // every ingest code is used by a device op, none by a staff op
  });
  it('no operation is public (REQ-SEC-099): every operation names a security scheme and a permission', () => {
    for (const o of OPENAPI_OPS) { expect(o.security.length, o.id).toBeGreaterThan(0); expect(o.permission, o.id).not.toBe(''); }
  });
});
