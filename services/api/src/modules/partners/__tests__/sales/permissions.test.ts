// T0B-SALES-1: permission denied cases + wiring of the 15 sales operations (done_when (1) handlers registered so the boot check passes, (5) no personal data in logs).
// For every operation: no grant -> auth.forbidden before any SQL; read-only user cannot write; manage at aal1 -> auth.mfa_required; non-user actors -> auth.forbidden before SQL.
// Real PG17 (the kit); no row is needed because nothing may be reached. Fails now: the operations are pending (no handler). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { ADMIN_A, MANAGE, MANAGE_ONLY_A, NOBODY_A, READ, READER_A, T, as, codeOf, fire, forbidden, idem, ifm, rejected, req, uid } from './helpers.js';

const U = '01a1a98a-ac40-7000-8000-00000000f001';
const OPS: Array<{ id: string; permission: string; r: () => ReturnType<typeof req> }> = [
  { id: 'listSalesDesignations', permission: READ, r: () => req() },
  { id: 'createSalesDesignation', permission: MANAGE, r: () => req({ headers: idem(), body: { name: 'Synthetic', level: 2 } }) },
  { id: 'updateSalesDesignation', permission: MANAGE, r: () => req({ params: { designation_id: U }, headers: ifm(1), body: { name: 'Synthetic' } }) },
  { id: 'listSalesRepresentatives', permission: READ, r: () => req() },
  { id: 'createSalesRepresentative', permission: MANAGE, r: () => req({ headers: idem(), body: { name: 'Synthetic', designation_id: U } }) },
  { id: 'updateSalesRepresentative', permission: MANAGE, r: () => req({ params: { representative_id: U }, headers: ifm(1), body: { name: 'Synthetic' } }) },
  { id: 'deactivateSalesRepresentative', permission: MANAGE, r: () => req({ params: { representative_id: U }, headers: ifm(1) }) },
  { id: 'getSalesTree', permission: READ, r: () => req() },
  { id: 'assignPartyToRepresentative', permission: MANAGE, r: () => req({ headers: idem(), body: { party_kind: 'credit_party', party_id: U, representative_id: U, effective_from: '2026-11-18' } }) },
  { id: 'unassignPartyFromRepresentative', permission: MANAGE, r: () => req({ params: { assignment_id: U }, headers: ifm(1) }) },
  { id: 'listRepresentativeClients', permission: READ, r: () => req({ params: { representative_id: U } }) },
  { id: 'listServiceAreas', permission: READ, r: () => req() },
  { id: 'createServiceArea', permission: MANAGE, r: () => req({ headers: idem(), body: { name: 'Synthetic', district: 'Kathmandu' } }) },
  { id: 'updateServiceArea', permission: MANAGE, r: () => req({ params: { service_area_id: U }, headers: ifm(1), body: { name: 'Synthetic' } }) },
  { id: 'deactivateServiceArea', permission: MANAGE, r: () => req({ params: { service_area_id: U }, headers: ifm(1) }) },
];

describe('the 15 sales operations are wired (boot check, AC-0D-1.2)', () => {
  const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/partners.yaml'));
  const specOps = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
  it('every sales operation has a real handler and is NOT listed pending any more (T0B-SALES-1 removed them)', () => {
    const pending: string[] = [...((manifest as any).pendingOperations ?? [])];
    for (const { id } of OPS) { expect(specOps, id).toContain(id); expect(typeof (manifest.handlers as any)[id], `${id} handler`).toBe('function'); expect(pending, `${id} still pending`).not.toContain(id); }
    expect(pending).toEqual([]);
  });
  it('the test table covers exactly the sales operations of the contract (x-permission matches)', () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) if (path.startsWith('/v1/partners/admin/sales/'))
      for (const m of Object.values<any>(item)) if (m?.operationId) expect(OPS.find((o) => o.id === m.operationId)?.permission, m.operationId).toBe(m['x-permission']);
    expect(OPS).toHaveLength(15);
  });
});

describe.each(OPS)('$id permission cases', ({ id, permission, r }) => {
  it('no grant -> auth.forbidden, asked for the contract permission, no SQL', { timeout: T }, async () => {
    const o = await fire(id, r(), NOBODY_A); forbidden(o); expect(o.probe.identity).toContain(permission); expect(o.probe.sql).toEqual([]);
  });
  it('a user with ONLY the other sales permission is refused (read does not write, manage-only does not read)', { timeout: T }, async () => {
    const o = await fire(id, r(), permission === MANAGE ? READER_A : MANAGE_ONLY_A); forbidden(o); expect(o.probe.sql).toEqual([]);
  });
  it.each(['patient', 'partner', 'device', 'system'])('actor type %s -> auth.forbidden before any SQL (staff operation)', { timeout: T }, async (actorType) => {
    const o = await fire(id, r(), as(ADMIN_A, { actorType })); forbidden(o); expect(o.probe.sql).toEqual([]);
  });
  if (permission === MANAGE) it('manage at aal1 -> auth.mfa_required before any SQL (privileged permission, REQ-SEC-062)', { timeout: T }, async () => {
    const o = await fire(id, r(), as(ADMIN_A, { mfa: 'aal1' })); rejected(o, 'auth.mfa_required'); expect(o.probe.sql).toEqual([]);
  });
  it('a permitted caller with an unseen id never gets a 5xx or a stub answer', { timeout: T }, async () => {
    const o = await fire(id, req({ ...r(), params: Object.fromEntries(Object.keys(r().params).map((k) => [k, uid()])) }), ADMIN_A);
    expect(o.reply?.status === 501 || codeOf(o) === 'common.internal', `${id} answered like a stub`).toBe(false);
  });
});
