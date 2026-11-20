// T0B-PARTYSET-1 done_when (1) FIRST PRIORITY: every new operation of T0C-PARTYSET-1 has a registered handler (not pending, not a stub) so the module boot check passes;
// and every handler asserts exactly its x-permission: a caller with no grants gets auth.forbidden before anything is read or written, a caller holding another
// PARTYSET code is refused too, revealPartyIdNumber at aal1 is auth.mfa_required. Real PG17 (the handler is run, not only listed).
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { ADMIN_A, NOBODY_A, P, T, as, fire, forbidden, only, rejected, req, uid } from './helpers.js';

const OPS: Array<[string, string, () => ReturnType<typeof req>]> = [
  ['getPartyCommercialSetting', P.settingRead, () => req({ params: { party_kind: 'credit_party', party_id: uid() } })],
  ['setPartyCommercialSetting', P.settingManage, () => req({ params: { party_kind: 'credit_party', party_id: uid() }, body: { commission_bp: 1 } })],
  ['listPartyOnboarding', P.decide, () => req()],
  ['decidePartyOnboarding', P.decide, () => req({ params: { onboarding_id: uid() }, headers: { 'if-match': '"1"' }, body: { decision: 'approve' } })],
  ['listNonCompliancePenalties', P.penalty, () => req()],
  ['createNonCompliancePenalty', P.penalty, () => req({ headers: { 'idempotency-key': uid() }, body: { code: 'X1', name: 'x', amount_paisa: 1 } })],
  ['updateNonCompliancePenalty', P.penalty, () => req({ params: { penalty_id: uid() }, headers: { 'if-match': '"1"' }, body: { name: 'x' } })],
  ['deactivateNonCompliancePenalty', P.penalty, () => req({ params: { penalty_id: uid() }, headers: { 'if-match': '"1"' } })],
  ['listNonComplianceEvents', P.penalty, () => req()],
  ['raiseNonComplianceEvent', P.penalty, () => req({ headers: { 'idempotency-key': uid() }, body: { party_kind: 'credit_party', party_id: uid(), penalty_id: uid(), event_date: '2026-11-17' } })],
  ['waiveNonComplianceEvent', P.penalty, () => req({ params: { event_id: uid() }, headers: { 'if-match': '"1"' }, body: { reason: 'Synthetic' } })],
  ['chargeNonComplianceEvent', P.penalty, () => req({ params: { event_id: uid() }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' } })],
  ['revealPartyIdNumber', P.idRead, () => req({ params: { party_kind: 'partner', party_id: uid() }, body: { field: 'tax_number' } })],
];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/partners.yaml'));
const opOf = (id: string): any => Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p)).find((m) => m?.operationId === id);
const pending: readonly string[] = (manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [];

describe('the 13 partners operations of T0C-PARTYSET-1 are registered', () => {
  it.each(OPS.map((o) => o[0]))('%s has a handler and is not listed pending', (id) => {
    expect(typeof (manifest.handlers as Record<string, unknown>)[id], `${id} handler`).toBe('function');
    expect(pending, `${id} pending`).not.toContain(id);
  });
  it('the pending list holds none of them (and every remaining pending id is still a spec operation)', () => {
    expect(pending.filter((id) => OPS.some((o) => o[0] === id))).toEqual([]);
    const ids = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
    expect(pending.filter((id) => !ids.includes(id))).toEqual([]);
  });
  it('the permission each handler asserts is the x-permission of the spec', () => {
    for (const [id, code] of OPS) expect(opOf(id)['x-permission'], id).toBe(code);
  });
});

describe.each(OPS)('%s permission', (id, code, mkReq) => {
  it('no grants -> auth.forbidden, no write', async () => {
    const o = await fire(id, mkReq(), NOBODY_A);
    forbidden(o);
    expect(o.probe.writes).toEqual([]);
  }, T);
  it(`asserts ${code}`, async () => {
    const o = await fire(id, mkReq(), NOBODY_A);
    expect(o.probe.identity).toContain(code);
  }, T);
  it('a caller holding every OTHER partyset code is refused', async () => {
    const others = Object.values(P).filter((c) => c !== code && !c.startsWith('catalog.') && c !== 'partners.partner.read' && c !== 'partners.partner.manage');
    forbidden(await fire(id, mkReq(), only(1, ...others)));
  }, T);
});

describe('privileged reveal', () => {
  it('aal1 with the permission -> auth.mfa_required', async () => {
    rejected(await fire('revealPartyIdNumber', req({ params: { party_kind: 'partner', party_id: uid() }, body: { field: 'tax_number' } }), as(ADMIN_A, { mfa: 'aal1' })), 'auth.mfa_required');
  }, T);
});
