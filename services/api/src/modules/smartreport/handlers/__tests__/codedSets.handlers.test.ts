// C14 T03 — coded-set endpoints #26 getSmartCodedSet (summary_reject_reasons, smartreport.summary.read) and #35 getSmartLibraryCodedSet (organ_groups, smartreport.template.manage).
// 06-PLAN row T03 done_when: "lab_manager gets 200 on #35 and 403 on #26"; 08 A19 P-43 (one permission floor per operation); 07-SECURITY test plan item 3
// ("#35 is tenant-wide") and item 4 (front_desk on #35 and lab_manager on #26 -> 403 auth.forbidden). Tests: integration (handler + real IdentityPort fake + repo emulator) + probes.
// Seams: see t03.helpers.ts. Additional pinned choices (spec silent):
//   #26 serves ONLY set_code summary_reject_reasons via codedSets.listRejectReasons; #35 serves ONLY organ_groups via codedSets.listOrganGroups.
//   Any other set_code on either operation (even for an actor that holds both permissions) -> common.validation_failed or common.not_found, and NO repository read
//   (otherwise #26 would serve organ_groups to a front_desk user, or #35 reject reasons to a lab_manager — a floor bypass).
//   Items: { code, display, sort_order, is_active } only, active rows, repository order (sort_order ASC). Response { set_code, items }.
// Fails now: handlers 26 and 35 are T01 stubs (common.internal / 501).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/denyTerms.repo.js', async () => (await import('./t03.fakes.js')).denyTermsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('./t03.fakes.js')).codedSetsRepoFake);

import { TA, TB, call, callsOf, codeOf, codedSetProblems, fails, repoCalls, request, seed } from './t03.helpers.js';

const REJECT = 'getSmartCodedSet', ORGAN = 'getSmartLibraryCodedSet';
const REASONS = 'summary_reject_reasons', GROUPS = 'organ_groups';
const reject = (persona: Parameters<typeof call>[1], set = REASONS, tenant: 'A' | 'B' = 'A') => call(REJECT, persona, request({ params: { set_code: set } }), tenant);
const organ = (persona: Parameters<typeof call>[1], set = GROUPS, tenant: 'A' | 'B' = 'A') => call(ORGAN, persona, request({ params: { set_code: set } }), tenant);
beforeEach(() => { seed(); vi.clearAllMocks(); });

describe('C14-T03 done_when: lab_manager gets 200 on #35 and 403 on #26 (08 A19 P-43)', () => {
  it('lab_manager: #35 200, #26 403 auth.forbidden', async () => {
    const ok = await organ('lab_manager').run();
    expect(ok.status).toBe(200);
    expect(ok.body.set_code).toBe(GROUPS);
    const e = await fails(reject('lab_manager').run());
    expect(codeOf(e)).toBe('auth.forbidden');
    expect(callsOf('listRejectReasons')).toHaveLength(0);
  });

  it('front_desk: #26 200, #35 403 auth.forbidden (and the reverse floor holds for pathologist: both 200)', async () => {
    expect((await reject('front_desk').run()).status).toBe(200);
    expect(codeOf(await fails(organ('front_desk').run()))).toBe('auth.forbidden');
    expect((await reject('pathologist').run()).status).toBe(200);
    expect((await organ('pathologist').run()).status).toBe(200);
  });
});

describe('C14-T03 #26 getSmartCodedSet (summary_reject_reasons, smartreport.summary.read)', () => {
  it('front_desk: 200 with the five active reasons in sort_order, CodedSet shape only, tenant-wide permission check', async () => {
    const c = reject('front_desk');
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(codedSetProblems(r.body, REASONS)).toEqual([]);
    expect(r.body.items).toEqual([
      { code: 'wording_problem', display: 'Wording not appropriate', sort_order: 10, is_active: true },
      { code: 'library_error', display: 'Library rule or text error', sort_order: 20, is_active: true },
      { code: 'not_appropriate_for_patient', display: 'Not appropriate for this patient', sort_order: 30, is_active: true },
      { code: 'results_under_review', display: 'Results under review', sort_order: 40, is_active: true },
      { code: 'other', display: 'Other', sort_order: 90, is_active: true },
    ]);                                                                                      // retired_reason (inactive) absent; no system/system_version/created_at
    expect(c.asserted).toEqual([{ permission: 'smartreport.summary.read' }]);
    expect(callsOf('listOrganGroups')).toHaveLength(0);
  });

  it('read-only: no repository function other than the reject-reason read is used (no deny-term access, no write)', async () => {
    await reject('pathologist').run();
    expect(callsOf('listRejectReasons')).toHaveLength(1);
    expect(repoCalls()).toBe(1);
  });

  it('tenant B actor gets the same global set', async () => {
    const r = await reject('pathologist', REASONS, 'B').run();
    expect(r.body.items).toHaveLength(5);
    expect(callsOf('listRejectReasons')[0]!.tenantId).toBe(TB);
  });

  it.each(['lab_manager', 'lab_manager_c1', 'lab_technologist', 'revoked_lab_manager'] as const)('%s -> 403 auth.forbidden before any repository access', async (persona) => {
    expect(codeOf(await fails(reject(persona).run()))).toBe('auth.forbidden');
    expect(repoCalls()).toBe(0);
  });

  it('unknown actor -> auth.unauthenticated', async () => {
    expect(codeOf(await fails(reject('ghost').run()))).toBe('auth.unauthenticated');
    expect(repoCalls()).toBe(0);
  });

  it.each([GROUPS, '', ' ', 'summary_reject_reasons ', 'SUMMARY_REJECT_REASONS', 'smartreport.summary_reject_reasons', 'g_cs_summary_reject_reasons', '../organ_groups',
    "x'; DROP TABLE smartreport.g_cs_organ_groups; --", 'summary_reject_reasons​', 'unknown_set'])('set_code %j is refused (validation or not found) and no set is read — even for an actor holding both permissions', async (setCode) => {
    for (const persona of ['front_desk', 'pathologist'] as const) {
      const e = await fails(reject(persona, setCode).run());
      expect(['common.validation_failed', 'common.not_found'], `${persona} ${JSON.stringify(setCode)} -> ${codeOf(e)}`).toContain(codeOf(e));
    }
    expect(callsOf('listOrganGroups', 'listRejectReasons')).toHaveLength(0);
  });

  it('authorisation precedes set_code validation: lab_manager with a bad set_code gets 403, not 400/404 (no oracle for set names)', async () => {
    expect(codeOf(await fails(reject('lab_manager', 'unknown_set').run()))).toBe('auth.forbidden');
  });

  it('a missing set_code param is refused without any read', async () => {
    const { run } = call(REJECT, 'front_desk', request());
    const e = await fails(run());
    expect(['common.validation_failed', 'common.not_found']).toContain(codeOf(e));
    expect(repoCalls()).toBe(0);
  });
});

describe('C14-T03 #35 getSmartLibraryCodedSet (organ_groups, smartreport.template.manage)', () => {
  it('lab_manager: 200 with the 16 active organ groups in sort_order, CodedSet shape only', async () => {
    const c = organ('lab_manager');
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(codedSetProblems(r.body, GROUPS)).toEqual([]);
    expect(r.body.items).toHaveLength(16);                                                    // retired_group (inactive) absent
    expect(r.body.items.map((i: any) => i.code)).toEqual(['blood_counts', 'glucose', 'lipids', 'liver', 'kidney', 'electrolytes', 'thyroid', 'iron', 'vitamins', 'inflammation', 'hormones', 'immunology', 'urine', 'stool', 'vitals', 'other']);
    expect(r.body.items[1]).toEqual({ code: 'glucose', display: 'Blood sugar', sort_order: 20, is_active: true });
    expect(c.asserted).toEqual([{ permission: 'smartreport.template.manage' }]);
    expect(callsOf('listRejectReasons')).toHaveLength(0);
    expect(repoCalls()).toBe(1);
  });

  it('is tenant-wide (07-SECURITY test plan 3): a centre-scoped lab_manager gets 200 and no centreId is asserted', async () => {
    const c = organ('lab_manager_c1');
    expect((await c.run()).status).toBe(200);
    expect(c.asserted[0]).not.toHaveProperty('centreId');
  });

  it('pathologist and a tenant B lab_manager get the same global set', async () => {
    expect((await organ('pathologist').run()).body.items).toHaveLength(16);
    const b = await organ('lab_manager', GROUPS, 'B').run();
    expect(b.body.items).toHaveLength(16);
    expect(callsOf('listOrganGroups').at(-1)!.tenantId).toBe(TB);
    expect(callsOf('listOrganGroups')[0]!.tenantId === TB).toBe(false);
  });

  it.each(['front_desk', 'lab_technologist', 'revoked_lab_manager'] as const)('%s -> 403 auth.forbidden before any repository access', async (persona) => {
    expect(codeOf(await fails(organ(persona).run()))).toBe('auth.forbidden');
    expect(repoCalls()).toBe(0);
  });

  it('unknown actor -> auth.unauthenticated', async () => {
    expect(codeOf(await fails(organ('ghost').run()))).toBe('auth.unauthenticated');
    expect(repoCalls()).toBe(0);
  });

  it.each([REASONS, '', ' ', 'organ_groups ', 'ORGAN_GROUPS', 'smartreport.organ_groups', 'g_cs_organ_groups', '../summary_reject_reasons',
    "x'; DROP TABLE smartreport.g_cs_summary_reject_reasons; --", 'organ_groups​', 'unknown_set'])('set_code %j is refused (validation or not found) and no set is read — even for an actor holding both permissions', async (setCode) => {
    for (const persona of ['lab_manager', 'pathologist'] as const) {
      const e = await fails(organ(persona, setCode).run());
      expect(['common.validation_failed', 'common.not_found'], `${persona} ${JSON.stringify(setCode)} -> ${codeOf(e)}`).toContain(codeOf(e));
    }
    expect(callsOf('listOrganGroups', 'listRejectReasons')).toHaveLength(0);
  });

  it('authorisation precedes set_code validation: front_desk with a bad set_code gets 403', async () => {
    expect(codeOf(await fails(organ('front_desk', 'unknown_set').run()))).toBe('auth.forbidden');
  });

  it('uses the tenant context only for the repo call (never a tenant from the request)', async () => {
    const { run } = call(ORGAN, 'lab_manager', request({ params: { set_code: GROUPS }, query: { tenant_id: TB }, body: { tenant_id: TB } }));
    await run();
    expect(callsOf('listOrganGroups')[0]!.tenantId).toBe(TA);
  });
});
