// RM-T01 loader contract (LD-141; 11-ROLE-MATRIX §4 item 1, R3, R6). API under test (tests fix it, 06-IMPLEMENTATION-PLAN has none):
//   loadRolePacks(): RolePackFile                       reads ./role-packs.data.yaml, default registry
//   parseRolePacks(yamlText, registry?): RolePackFile   throws Error (message names the offending code) on any violation
// Negative inputs start from the spec data file (not the module copy) so each throw is proven to come from ONE mutation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadRolePacks, parseRolePacks } from '../../role-packs/loader.js';

const ROOT = join(import.meta.dirname, '../../../../../../..');
const specText = readFileSync(join(ROOT, 'spec/program/11-ROLE-MATRIX.data.yaml'), 'utf8');
const reg = parse(readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8')) as {
  roles: Array<{ code: string }>; permissions: Array<{ code: string; privileged: boolean; roles: string[] }>;
};
const registry = reg.permissions.map(({ code, privileged, roles }) => ({ code, privileged, roles }));

type Doc = { version: number; packs: Array<{ code: string; roles: Array<{ code: string; mfa_required: boolean; permissions: string[] }> }> };
const mutate = (fn: (d: Doc) => void): string => { const d = parse(specText) as Doc; fn(d); return stringify(d); };
const role = (d: Doc, code: string) => d.packs.flatMap((p) => p.roles).find((r) => r.code === code)!;

describe('RM-T01 loader accepts the real data', () => {
  it('parseRolePacks(spec file) returns both packs, 19 + 10 roles, verbatim fields', () => {
    const f = parseRolePacks(specText, registry);
    expect(f.packs.map((p) => [p.code, p.roles.length])).toEqual([['elabcorp_default', 19], ['elabassist_standard', 10]]);
    const admin = f.packs[0]!.roles[0]!;
    expect(admin).toMatchObject({ code: 'corp_admin', name: 'Admin', mfa_required: true, base_default_role: 'tenant_admin' });
    expect(admin.permissions).toHaveLength(92);
  });

  it('loadRolePacks() reads the module data file with the default registry', () => {
    expect(loadRolePacks()).toEqual(parseRolePacks(specText, registry));
  });
});

describe('RM-T01 loader rejects', () => {
  it('a permission code that is not in contracts/permissions.yaml', () => {
    const t = mutate((d) => role(d, 'corp_accession_user').permissions.push('frontdesk.not_a_real.code'));
    expect(() => parseRolePacks(t, registry)).toThrow(/frontdesk\.not_a_real\.code/);
  });

  it('a permission code removed from the injected registry (registry is the source of truth)', () => {
    const smaller = registry.filter((e) => e.code !== 'billing.invoice.read');
    expect(() => parseRolePacks(specText, smaller)).toThrow(/billing\.invoice\.read/);
  });

  it.each(reg.roles.map((r) => r.code))('a template code equal to the default role code %s (R6)', (code) => {
    const t = mutate((d) => { d.packs[0]!.roles[1]!.code = code; });
    expect(() => parseRolePacks(t, registry)).toThrow(new RegExp(code));
  });

  it('a role with a privileged permission and mfa_required false (R3)', () => {
    const t = mutate((d) => { role(d, 'corp_accounts').mfa_required = false; });
    expect(() => parseRolePacks(t, registry)).toThrow(/corp_accounts/);
  });

  it('a privileged permission added to a role that has mfa_required false (R3)', () => {
    const t = mutate((d) => role(d, 'corp_accession_user').permissions.push('catalog.price_list.manage'));
    expect(() => parseRolePacks(t, registry)).toThrow(/corp_accession_user/);
  });

  it('control: a non-privileged registry code added with mfa_required false is accepted', () => {
    const extra = registry.find((e) => !e.privileged && e.roles.length > 0 && e.code === 'identity.centre.read')!;
    const t = mutate((d) => { const r = role(d, 'corp_accession_user'); if (!r.permissions.includes(extra.code)) r.permissions.push(extra.code); });
    expect(() => parseRolePacks(t, registry)).not.toThrow();
  });

  it.each([['empty text', ''], ['not a mapping', '- a\n- b\n'], ['no packs', 'version: 1\n'], ['unknown version', 'version: 2\npacks: []\n']])(
    'fails closed on malformed input: %s', (_n, text) => {
      expect(() => parseRolePacks(text, registry)).toThrow();
    });
});
