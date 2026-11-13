// RM-T01 pack integrity of the data file (11-ROLE-MATRIX §4 item 1; rules R2-R6; LD-141). Reads the YAML directly with
// `yaml`, independent of the loader, against contracts/permissions.yaml (the registry) and counts hard-coded from
// 11-ROLE-MATRIX §3 tables. Never widen a role to make a test pass: a mismatch is reported, not fixed here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '../../../../../../..');
const DATA_FILE = join(import.meta.dirname, '../../role-packs/role-packs.data.yaml');
const SPEC_FILE = join(ROOT, 'spec/program/11-ROLE-MATRIX.data.yaml');
const lf = (s: string) => s.replace(/\r\n/g, '\n');

type Role = { code: string; name: string; mfa_required: boolean; base_default_role: string | null; permissions: string[] };
type Pack = { code: string; label: string; roles: Role[] };
const data = (): { version: number; packs: Pack[] } => parse(readFileSync(DATA_FILE, 'utf8'));
const roles = (): Role[] => data().packs.flatMap((p) => p.roles);
const byCode = (c: string): Role => roles().find((r) => r.code === c)!;

const registry = parse(readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8')) as {
  roles: Array<{ code: string }>; partner_roles: Array<{ code: string }>; platform_roles: Array<{ code: string }>;
  permissions: Array<{ code: string; privileged: boolean }>;
};
const PERM = new Map(registry.permissions.map((p) => [p.code, p.privileged]));
const DEFAULT_ROLE_CODES = [...registry.roles, ...registry.partner_roles, ...registry.platform_roles].map((r) => r.code);

// 11-ROLE-MATRIX §3.1 / §3.2: code -> [permissions, privileged]
const EXPECTED: Record<string, Record<string, [number, number]>> = {
  elabcorp_default: {
    corp_admin: [92, 33], corp_accession_user: [22, 0], corp_accounts: [18, 6], corp_franchise_user: [24, 0],
    corp_client_operator: [44, 8], corp_laboratory_admin: [11, 0], corp_laboratory_lab_user: [24, 0],
    corp_laboratory_user: [18, 0], corp_collection_center: [22, 1], corp_it_department: [5, 0],
    corp_junior_lab_user: [24, 0], corp_sr_lab_user: [51, 9], corp_sr_lab_user_t2: [51, 9], corp_pathologist: [45, 7],
    corp_pathologist_t2: [44, 7], corp_pathologist_t3: [40, 7], corp_client_user: [21, 3], corp_sales_person: [35, 7],
    corp_senior_lab_user: [51, 9],
  },
  elabassist_standard: {
    std_admin: [85, 30], std_reception: [18, 0], std_accession: [25, 0], std_lab_technician: [40, 0],
    std_consulting_pathologist: [20, 5], std_collection_center_user: [21, 0], std_collection_center_admin: [21, 0],
    std_collection_boy: [19, 0], std_affiliation_hospital_user: [17, 0], std_account: [25, 6],
  },
};
const ADMINS = ['corp_admin', 'std_admin'];
const PATHOLOGISTS = ['corp_pathologist', 'corp_pathologist_t2', 'corp_pathologist_t3', 'std_consulting_pathologist'];
const SR_LAB = ['corp_sr_lab_user', 'corp_sr_lab_user_t2', 'corp_senior_lab_user'];
const ACCOUNTS = ['corp_accounts', 'std_account'];

describe('RM-T01 role-packs.data.yaml', () => {
  it('equals spec/program/11-ROLE-MATRIX.data.yaml unchanged (LD-141; line endings ignored)', () => {
    expect(lf(readFileSync(DATA_FILE, 'utf8'))).toBe(lf(readFileSync(SPEC_FILE, 'utf8')));
  });

  it('has the two packs with 19 + 10 roles and the exact template codes of §3', () => {
    const d = data();
    expect(d.version).toBe(1);
    expect(d.packs.map((p) => [p.code, p.roles.length])).toEqual([['elabcorp_default', 19], ['elabassist_standard', 10]]);
    for (const p of d.packs) expect(p.roles.map((r) => r.code)).toEqual(Object.keys(EXPECTED[p.code]!));
  });

  it('permission and privileged counts per role equal the §3 tables', () => {
    for (const p of data().packs) {
      for (const r of p.roles) {
        const priv = r.permissions.filter((c) => PERM.get(c) === true).length;
        expect([r.code, r.permissions.length, priv]).toEqual([r.code, ...EXPECTED[p.code]![r.code]!]);
      }
    }
  });

  it('every permission code exists in contracts/permissions.yaml; lists are unique and sorted', () => {
    for (const r of roles()) {
      expect(r.permissions.filter((c) => !PERM.has(c)), r.code).toEqual([]);
      expect(new Set(r.permissions).size, `${r.code} duplicates`).toBe(r.permissions.length);
      expect(r.permissions, `${r.code} sorted`).toEqual([...r.permissions].sort());
    }
  });

  it('no template code equals a default role code; prefixes corp_/std_ (R6); codes unique', () => {
    const all = roles().map((r) => r.code);
    expect(new Set(all).size).toBe(29);
    for (const c of all) expect(DEFAULT_ROLE_CODES, c).not.toContain(c);
    for (const p of data().packs) {
      const prefix = p.code === 'elabcorp_default' ? 'corp_' : 'std_';
      for (const r of p.roles) expect(r.code.startsWith(prefix), r.code).toBe(true);
    }
  });

  it('a role with a privileged permission has mfa_required true (R3)', () => {
    for (const r of roles()) {
      if (r.permissions.some((c) => PERM.get(c) === true)) expect(r.mfa_required, r.code).toBe(true);
      expect(typeof r.mfa_required, r.code).toBe('boolean');
    }
  });

  it('only the Admin roles extend tenant_admin (R5); every other base_default_role is null', () => {
    for (const r of roles()) expect(r.base_default_role, r.code).toBe(ADMINS.includes(r.code) ? 'tenant_admin' : null);
  });

  it('R4: identity.role.manage and identity.user.manage only on the two Admin roles', () => {
    for (const code of ['identity.role.manage', 'identity.user.manage']) {
      expect(roles().filter((r) => r.permissions.includes(code)).map((r) => r.code).sort(), code).toEqual(ADMINS.slice().sort());
    }
  });

  it('R4: instrument manage + instrument code map only on Admin, the three Sr. Lab User roles, std_lab_technician', () => {
    const allowed = new Set([...ADMINS, ...SR_LAB, 'std_lab_technician']);
    for (const code of ['instruments.instrument.manage', 'catalog.instrument_code_map.manage']) {
      const holders = roles().filter((r) => r.permissions.includes(code)).map((r) => r.code);
      expect(holders.filter((h) => !allowed.has(h)), code).toEqual([]);
      for (const must of ['corp_admin', ...SR_LAB]) expect(holders, code).toContain(must); // ticked and not capped
    }
    for (const r of roles().filter((x) => !allowed.has(x.code))) {
      expect(r.permissions, r.code).not.toContain('instruments.instrument.manage');
      expect(r.permissions, r.code).not.toContain('catalog.instrument_code_map.manage');
    }
  });

  it('R2/R5: decision authorities come only from the overlay; Admin has no clinical sign-off', () => {
    const holders = (code: string) => roles().filter((r) => r.permissions.includes(code)).map((r) => r.code).sort();
    for (const code of ['lab.result.approve', 'lab.result.amend', 'reporting.narrative.sign', 'anatomic.case.signout']) {
      expect(holders(code), code).toEqual([...PATHOLOGISTS].sort());
    }
    expect(holders('lab.result.verify')).toEqual([...PATHOLOGISTS, ...SR_LAB, 'std_lab_technician'].sort());
    for (const code of ['billing.refund.approve', 'billing.payment.reverse', 'billing.invoice.cancel']) {
      expect(holders(code), code).toEqual([...ACCOUNTS].sort());
    }
    expect(holders('frontdesk.discount.approve')).toEqual([...ACCOUNTS, ...ADMINS].sort());
    for (const a of ADMINS) {
      for (const code of ['lab.result.verify', 'lab.result.approve', 'lab.result.amend', 'reporting.narrative.sign', 'anatomic.case.signout']) {
        expect(byCode(a).permissions, `${a} ${code}`).not.toContain(code);
      }
    }
  });
});
