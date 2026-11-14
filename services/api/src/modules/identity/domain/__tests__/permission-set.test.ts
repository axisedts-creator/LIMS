// T2 permission-set.ts (AC-B2.1, AC-B2.2, AC-E4.3 allowlist, US-C2 n/a; 02-TRD §7.4 support allowlist, §2 domain/permission-set.ts;
// 03-APP-FLOW §4.3; contracts/permissions.yaml). The real registry is parsed from contracts/permissions.yaml in this test.
// Assumed API (pure; `registry` = the `permissions:` array of contracts/permissions.yaml: { code, privileged, roles: string[] }[]):
//   isAssignable(code, registry): boolean              — exists, not `platform.*`, `roles` non-empty (not actor-only)
//   validateRolePermissions(codes: string[], submittedMfaRequired: boolean, registry)
//     -> { ok: true; mfaRequired: boolean /* submitted OR any privileged code */ }
//      | { ok: false; errors: Array<{ pointer: '/permissions/<i>'; code: 'common.field_invalid' }> }   (HTTP 400 common.validation_failed)
//   permissionsOfRoles(roleCodes: string[], registry): string[]   — union of codes whose registry `roles` include any role; sorted, de-duplicated; unknown role -> []
//   supportPermissions(scope: 'read_only' | 'admin'): string[]    — sorted, exact 02-TRD §7.4 sets
//   fixedActorPermissions(actor: 'device' | 'portal' | 'patient' | 'patient_pre_auth' | 'partner', variant?: string): string[]
//     device variants bridge_agent (default when variant absent) | queue_display; partner variants partner_member | partner_admin (admin ⊇ member)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  fixedActorPermissions, isAssignable, permissionsOfRoles, supportPermissions, validateRolePermissions,
} from '../permission-set.js';

type Entry = { code: string; privileged: boolean; roles: string[] };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const doc = parse(readFileSync(resolve(root, 'contracts/permissions.yaml'), 'utf8')) as {
  permissions: Entry[]; roles: Array<{ code: string }>;
};
const REG = doc.permissions;
const byCode = new Map(REG.map((e) => [e.code, e]));
const privilegedAssignable = REG.filter((e) => e.privileged && e.roles.length > 0 && !e.code.startsWith('platform.'));
const nonPrivilegedAssignable = REG.filter((e) => !e.privileged && e.roles.length > 0 && !e.code.startsWith('platform.'));

// tiny synthetic registry for rule-level tests
const SYN: Entry[] = [
  { code: 'x.thing.read', privileged: false, roles: ['r1'] },
  { code: 'x.thing.write', privileged: false, roles: ['r1', 'r2'] },
  { code: 'x.thing.admin', privileged: true, roles: ['r2'] },
  { code: 'platform.thing.manage', privileged: false, roles: ['platform_superadmin'] },
  { code: 'x.actor.only', privileged: false, roles: [] },
];

describe('fixture sanity (real registry)', () => {
  it('has both privileged and plain assignable codes', () => {
    expect(privilegedAssignable.length).toBeGreaterThan(10);
    expect(nonPrivilegedAssignable.length).toBeGreaterThan(10);
  });
});

describe('isAssignable', () => {
  it('plain, privileged tenant codes are assignable', () => {
    expect(isAssignable('x.thing.read', SYN)).toBe(true);
    expect(isAssignable('x.thing.admin', SYN)).toBe(true);
  });
  it('platform.* is never assignable, even with a non-empty roles list', () => expect(isAssignable('platform.thing.manage', SYN)).toBe(false));
  it('actor-only (roles: []) is not assignable', () => expect(isAssignable('x.actor.only', SYN)).toBe(false));
  it('unknown code is not assignable', () => expect(isAssignable('x.nope.read', SYN)).toBe(false));
  it('real registry: every platform.* code and every roles:[] code is rejected', () => {
    for (const e of REG.filter((r) => r.code.startsWith('platform.') || r.roles.length === 0)) {
      expect(isAssignable(e.code, REG), e.code).toBe(false);
    }
  });
  it('real registry: all other codes are assignable', () => {
    for (const e of [...privilegedAssignable, ...nonPrivilegedAssignable]) expect(isAssignable(e.code, REG), e.code).toBe(true);
  });
  it('look-alike codes do not slip through (case, whitespace, prefix)', () => {
    for (const c of ['Platform.tenant.read', ' platform.tenant.read', 'platformx.tenant.read', 'IDENTITY.USER.READ', 'identity.user.read ', '']) {
      expect(isAssignable(c, REG), JSON.stringify(c)).toBe(false);
    }
  });
});

describe('AC-B2.1 privileged -> mfa_required regardless of submitted flag', () => {
  it('any privileged code forces mfaRequired=true when submitted false', () => {
    expect(validateRolePermissions(['x.thing.read', 'x.thing.admin'], false, SYN)).toEqual({ ok: true, mfaRequired: true });
  });
  it('submitted true is kept with only plain codes (flag OR privileged)', () => {
    expect(validateRolePermissions(['x.thing.read'], true, SYN)).toEqual({ ok: true, mfaRequired: true });
  });
  it('only plain codes and submitted false -> false', () => {
    expect(validateRolePermissions(['x.thing.read', 'x.thing.write'], false, SYN)).toEqual({ ok: true, mfaRequired: false });
  });
  it('empty permission list is valid; mfaRequired mirrors the flag', () => {
    expect(validateRolePermissions([], false, SYN)).toEqual({ ok: true, mfaRequired: false });
    expect(validateRolePermissions([], true, SYN)).toEqual({ ok: true, mfaRequired: true });
  });
  it('real registry: EVERY privileged assignable code alone forces mfaRequired=true', () => {
    for (const e of privilegedAssignable) {
      expect(validateRolePermissions([e.code], false, REG), e.code).toEqual({ ok: true, mfaRequired: true });
    }
  });
  it('real registry: EVERY non-privileged assignable code alone leaves mfaRequired=false', () => {
    for (const e of nonPrivilegedAssignable) {
      expect(validateRolePermissions([e.code], false, REG), e.code).toEqual({ ok: true, mfaRequired: false });
    }
  });
  it('duplicates in the input do not change the outcome', () => {
    expect(validateRolePermissions(['x.thing.read', 'x.thing.read'], false, SYN)).toMatchObject({ ok: true, mfaRequired: false });
  });
});

describe('AC-B2.2 platform.* / actor-only / unknown rejected at /permissions/<i>', () => {
  it('platform.* at index 1', () => {
    expect(validateRolePermissions(['x.thing.read', 'platform.thing.manage'], false, SYN)).toEqual({
      ok: false, errors: [{ pointer: '/permissions/1', code: 'common.field_invalid' }],
    });
  });
  it('actor-only at index 0', () => {
    expect(validateRolePermissions(['x.actor.only'], false, SYN)).toEqual({
      ok: false, errors: [{ pointer: '/permissions/0', code: 'common.field_invalid' }],
    });
  });
  it('unknown code at index 2', () => {
    expect(validateRolePermissions(['x.thing.read', 'x.thing.write', 'x.nope.read'], false, SYN)).toEqual({
      ok: false, errors: [{ pointer: '/permissions/2', code: 'common.field_invalid' }],
    });
  });
  it('reports every offending index, valid ones are not reported', () => {
    const r = validateRolePermissions(['platform.thing.manage', 'x.thing.read', 'x.actor.only', 'zzz'], false, SYN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.pointer)).toEqual(['/permissions/0', '/permissions/2', '/permissions/3']);
  });
  it('real registry: every platform.* code is rejected (privileged or not)', () => {
    for (const e of REG.filter((r) => r.code.startsWith('platform.'))) {
      expect(validateRolePermissions([e.code], true, REG), e.code).toMatchObject({ ok: false });
    }
  });
  it('real registry: actor-only identity.signatory.read and reporting.portal.view are rejected', () => {
    for (const c of ['identity.signatory.read', 'reporting.portal.view', 'instruments.ingest.submit']) {
      expect(validateRolePermissions([c], false, REG), c).toMatchObject({ ok: false, errors: [{ pointer: '/permissions/0' }] });
    }
  });
  it('a rejected list never reports ok even if it also holds privileged codes', () => {
    expect(validateRolePermissions(['x.thing.admin', 'platform.thing.manage'], false, SYN)).toMatchObject({ ok: false });
  });
  it('non-string entries are rejected, not coerced', () => {
    expect(validateRolePermissions([null as never, 5 as never], false, SYN)).toMatchObject({ ok: false });
  });
});

describe('permissionsOfRoles (default-role resolution from the registry)', () => {
  it('synthetic: union, sorted, de-duplicated', () => {
    expect(permissionsOfRoles(['r1', 'r2'], SYN)).toEqual(['x.thing.admin', 'x.thing.read', 'x.thing.write']);
    expect(permissionsOfRoles(['r1'], SYN)).toEqual(['x.thing.read', 'x.thing.write']);
  });
  it('unknown role and empty list resolve to nothing', () => {
    expect(permissionsOfRoles(['ghost'], SYN)).toEqual([]);
    expect(permissionsOfRoles([], SYN)).toEqual([]);
  });
  it('real registry: tenant_admin holds identity.user.manage and identity.settings.manage; front_desk does not', () => {
    const admin = permissionsOfRoles(['tenant_admin'], REG);
    expect(admin).toEqual(expect.arrayContaining(['identity.user.manage', 'identity.settings.manage', 'audit.log.export']));
    expect(permissionsOfRoles(['front_desk'], REG)).not.toContain('identity.user.manage');
  });
  it('real registry: result equals exactly the codes listing that role', () => {
    for (const role of doc.roles.map((r) => r.code)) {
      const expected = REG.filter((e) => e.roles.includes(role)).map((e) => e.code).sort();
      expect(permissionsOfRoles([role], REG), role).toEqual([...new Set(expected)]);
    }
  });
  it('real registry: platform roles resolve platform codes; tenant roles never do', () => {
    expect(permissionsOfRoles(['platform_support'], REG)).toContain('platform.tenant.read');
    for (const role of doc.roles.map((r) => r.code)) {
      expect(permissionsOfRoles([role], REG).filter((c) => c.startsWith('platform.')), role).toEqual([]);
    }
  });
});

describe('support permission allowlist (02-TRD §7.4; AC-E4.3 / C2-1)', () => {
  const READ_ONLY = ['audit.log.read', 'identity.centre.read', 'identity.user.read'];
  const ADMIN = [...READ_ONLY, 'identity.centre.manage', 'identity.role.manage', 'identity.session.revoke',
    'identity.settings.manage', 'identity.user.manage'].sort();

  it('read_only is exactly user.read, centre.read, audit.log.read', () => expect(supportPermissions('read_only')).toEqual(READ_ONLY));
  it('admin is read_only + user.manage, role.manage, centre.manage, settings.manage, session.revoke', () => {
    expect(supportPermissions('admin')).toEqual(ADMIN);
  });
  it('admin ⊇ read_only', () => {
    const admin = new Set(supportPermissions('admin'));
    for (const c of supportPermissions('read_only')) expect(admin.has(c), c).toBe(true);
  });
  it.each(['read_only', 'admin'] as const)('%s: never audit.log.export, never platform.*, only identity.* and audit.log.read', (scope) => {
    const set = supportPermissions(scope);
    expect(set).not.toContain('audit.log.export');
    for (const c of set) {
      expect(c.startsWith('platform.'), c).toBe(false);
      expect(/^(identity\.|audit\.log\.read$)/.test(c), c).toBe(true);
    }
  });
  it.each(['read_only', 'admin'] as const)('%s: every code exists in the registry and is assignable to tenant roles', (scope) => {
    for (const c of supportPermissions(scope)) {
      expect(byCode.has(c), c).toBe(true);
      expect(isAssignable(c, REG), c).toBe(true);
    }
  });
  it('no clinical / billing / patient data permission is ever allowed', () => {
    const all = [...supportPermissions('read_only'), ...supportPermissions('admin')];
    for (const c of all) expect(/^(lab|billing|frontdesk|reporting|engagement|catalog|partners|instruments|patient)\./.test(c), c).toBe(false);
  });
  it('returns a fresh array — callers cannot mutate the allowlist', () => {
    const a = supportPermissions('admin');
    a.push('lab.result.read');
    expect(supportPermissions('admin')).toEqual(ADMIN);
  });
  it('unknown scope fails closed (throws or returns empty), never widens', () => {
    let got: string[] | undefined;
    try { got = supportPermissions('superuser' as never); } catch { got = []; }
    expect(got).toEqual([]);
  });
});

describe('fixed actor sets (contracts/permissions.yaml fixed_actor_permissions)', () => {
  const fixed = (parse(readFileSync(resolve(root, 'contracts/permissions.yaml'), 'utf8')) as {
    fixed_actor_permissions: Record<string, unknown>;
  }).fixed_actor_permissions as {
    device: Record<string, string[]>; portal: string[]; patient: string[]; patient_pre_auth: string[];
    partner: { partner_member: string[] };
  };
  it('portal / patient / patient_pre_auth match the registry file', () => {
    expect(fixedActorPermissions('portal')).toEqual([...fixed.portal].sort());
    expect(fixedActorPermissions('patient')).toEqual([...fixed.patient].sort());
    expect(fixedActorPermissions('patient_pre_auth')).toEqual([...fixed.patient_pre_auth].sort());
  });
  it('device: absent variant = bridge_agent; queue_display is its own set', () => {
    expect(fixedActorPermissions('device')).toEqual([...fixed.device.bridge_agent!].sort());
    expect(fixedActorPermissions('device', 'bridge_agent')).toEqual([...fixed.device.bridge_agent!].sort());
    expect(fixedActorPermissions('device', 'queue_display')).toEqual(['engagement.queue.board_read']);
  });
  it('partner_admin ⊇ partner_member; admin adds referrer.manage and partner_user.manage', () => {
    const member = fixedActorPermissions('partner', 'partner_member');
    const admin = fixedActorPermissions('partner', 'partner_admin');
    expect(member).toEqual([...fixed.partner.partner_member].sort());
    for (const c of member) expect(admin).toContain(c);
    expect(admin).toEqual(expect.arrayContaining(['partners.referrer.manage', 'partners.partner_user.manage']));
    expect(member).not.toContain('partners.partner_user.manage');
  });
  it('no fixed actor set contains platform.*, identity.*.manage or any privileged tenant-admin code except identity.self.manage', () => {
    const sets = [fixedActorPermissions('portal'), fixedActorPermissions('patient'), fixedActorPermissions('patient_pre_auth'),
      fixedActorPermissions('device'), fixedActorPermissions('device', 'queue_display'),
      fixedActorPermissions('partner', 'partner_member'), fixedActorPermissions('partner', 'partner_admin')];
    for (const c of sets.flat()) {
      expect(c.startsWith('platform.'), c).toBe(false);
      if (/^identity\..*\.manage$/.test(c)) expect(c).toBe('identity.self.manage');
    }
  });
  it('unknown actor / variant fails closed (throws or empty)', () => {
    for (const args of [['ghost'], ['device', 'ghost'], ['partner', 'ghost']] as const) {
      let got: string[] = ['x'];
      try { got = fixedActorPermissions(...(args as unknown as Parameters<typeof fixedActorPermissions>)); } catch { got = []; }
      expect(got, args.join('/')).toEqual([]);
    }
  });
});
