// T0D-NAV-COMPLETE-1 (LD-246, LD-250, 11-ROLE-MATRIX R5, 13-M-SERIES s4): the tenant navigation for the administrator pack
// corp_admin (spec/program/11-ROLE-MATRIX.data.yaml) holds Discount approvals, Front desk settings, Tests, Panels, Price lists,
// Users and Roles, has all 13 tenant groups and no `platform`, and shows NO clinical sign-off (Approve stays hidden: the matrix
// does not give corp_admin lab.result.approve). The entries the pack does NOT see are written to the notes (a report, not a failure).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { t } from '../../i18n/messages.ts';
import { buildNav } from '../build-nav.ts';
import { FEATURES, ROOT, ROUTES_YAML, pageExists } from './nav-complete.helpers.ts';

// ADMINPACK-1 (LD-254, 11-ROLE-MATRIX R5a and section 3.3): the pack a tenant really receives is the API copy of the data file
// (services/api/.../role-packs.data.yaml; a test in the identity suite proves it equals the spec file role by role), so the
// navigation is computed from THAT file against the real manifests and routes.
const matrix = parse(readFileSync(join(ROOT, 'services', 'api', 'src', 'modules', 'identity', 'role-packs', 'role-packs.data.yaml'), 'utf8')) as { packs: { roles: { code: string; permissions: string[] }[] }[] };
const corpAdmin = matrix.packs.flatMap((p) => p.roles).find((r) => r.code === 'corp_admin')!;
const held = new Set(corpAdmin?.permissions ?? []);
const TENANT_GROUPS = ['front_desk', 'laboratory', 'reporting', 'billing', 'catalog', 'instruments', 'analytics', 'quality', 'inventory', 'partners', 'engagement', 'home_collection', 'admin'];

// Entries 11-ROLE-MATRIX section 3.3 leaves hidden on purpose (the platform group is computed from the manifest, never visible).
const HIDDEN_NON_PLATFORM = [
  'lab.verification', 'lab.approval', 'lab.qc', 'micro.breakpoint_sets', 'smartreport.library', 'smartreport.wording', 'inventory.bench', 'engagement.queue',
];
const LEFT_OUT = /^(lab\.result\.(verify|approve|amend)|lab\.qc(_hold)?\.|micro\.(breakpoint|culture)\.(manage|work)|anatomic\.case\.(signout|work)|quality\.(autoverify\.manage|qc_run\.review)|smartreport\.|reporting\.(narrative|report\.(release|regenerate|bulk_release))|inventory\.(bench\.record|po\.approve)|engagement\.queue\.operate|billing\..*(refund|reverse|cancel)|payments\.|platform\.)/;

const nav = async () => {
  const { errors, entries } = await buildNav(FEATURES, ROUTES_YAML);
  expect(errors).toEqual([]);
  return { entries, visible: entries.filter((e) => held.has(e.permission)) };
};

describe('administrator pack corp_admin: tenant navigation', () => {
  it('the pack exists and holds the founder-named permissions (LD-250 fact), but NOT lab.result.approve (R5: no clinical sign-off)', () => {
    expect(corpAdmin, 'corp_admin in 11-ROLE-MATRIX.data.yaml').toBeTruthy();
    for (const p of ['frontdesk.discount.approve', 'frontdesk.settings.manage', 'catalog.test.read', 'catalog.test.manage']) expect(held.has(p), p).toBe(true);
    expect(held.has('lab.result.approve')).toBe(false);
  });

  it('contains Discount approvals, Tests, Panels, Price lists, Users and Roles', async () => {
    const { visible } = await nav();
    const want: [string, string, string][] = [
      ['Discount approvals', '/frontdesk/discount-approvals', 'frontdesk.discount.approve'],
      ['Tests', '/catalog/tests', 'catalog.test.read'],
      ['Panels', '/catalog/panels', 'catalog.test.read'],
      ['Price lists', '/catalog/price-lists', 'catalog.price_list.read'],
      ['Users', '/admin/users', 'identity.user.read'],
      ['Roles', '/admin/roles', 'identity.user.read'],
    ];
    for (const [name, path, permission] of want) {
      const e = visible.find((x) => x.path === path);
      expect(e, `${name} (${path}) visible to corp_admin`).toBeTruthy();
      expect(e!.permission).toBe(permission);
    }
  });

  it("ADMINPAGE-FD-1 (LD-255): 'Front desk settings' (frontdesk.settings.manage) is in the front_desk group of the administrator navigation, built from a page that exists", async () => {
    const { visible } = await nav();
    expect(pageExists('/frontdesk/settings'), 'page /frontdesk/settings exists').toBe(true);
    const e = visible.find((x) => x.path === '/frontdesk/settings');
    expect(e, 'Front desk settings visible to corp_admin').toBeTruthy();
    expect(e!.permission).toBe('frontdesk.settings.manage');
    expect(e!.group).toBe('front_desk');
    expect(t(e!.label)).toBe('Front desk settings');
  });

  it.each([
    ['Worklists', '/lab/worklists', 'lab.worklist.read', 'lab.worklists'],
    ['Critical values', '/lab/critical-values', 'lab.critical_value.read', 'lab.critical_values'],
  ])("ADMINPAGE-LAB-1 (LD-255): '%s' (%s, %s) is in the laboratory group of the administrator navigation, built from a page that exists", async (label, path, permission, id) => {
    const { visible } = await nav();
    expect(pageExists(path), `page ${path} exists`).toBe(true);
    const e = visible.find((x) => x.path === path);
    expect(e, `${label} visible to corp_admin`).toBeTruthy();
    expect(e!.id).toBe(id);
    expect(e!.permission).toBe(permission);
    expect(e!.group).toBe('laboratory');
    expect(t(e!.label)).toBe(label);
  });

  it("ADMINPAGE-ENG-1 (LD-255): 'Engagement settings' (engagement.settings.manage) is in the engagement group of the administrator navigation, built from a page that exists", async () => {
    const { visible } = await nav();
    expect(pageExists('/engagement/settings'), 'page /engagement/settings exists').toBe(true);
    const e = visible.find((x) => x.path === '/engagement/settings');
    expect(e, 'Engagement settings visible to corp_admin').toBeTruthy();
    expect(e!.id).toBe('engagement.settings');
    expect(e!.permission).toBe('engagement.settings.manage');
    expect(e!.group).toBe('engagement');
    expect(t(e!.label)).toBe('Engagement settings');
  });

  it('the Approve entry (lab.result.approve) is not visible: no clinical sign-off for the administrator', async () => {
    const { visible } = await nav();
    expect(visible.filter((e) => e.permission === 'lab.result.approve' || e.path === '/lab/approval')).toEqual([]);
  });

  it('corp_admin sees at least one entry in every one of the 13 tenant groups (quality and inventory included) and never `platform` (R5a)', async () => {
    const { visible } = await nav();
    const groups = new Set(visible.map((e) => e.group as string));
    const without = TENANT_GROUPS.filter((g) => !groups.has(g));
    expect(without, 'tenant groups with no visible entry for corp_admin').toEqual([]);
    expect(visible.filter((e) => (e.group as string) === 'platform')).toEqual([]);
  });

  it('pins the exact list of entries still hidden from corp_admin (R5a left-out authority: decision, bench, money and platform entries)', async () => {
    const { entries, visible } = await nav();
    const seen = new Set(visible.map((e) => e.id));
    const hidden = entries.filter((e) => !seen.has(e.id)).map((e) => e.id).sort();
    expect(hidden).toEqual([...HIDDEN_NON_PLATFORM, ...entries.filter((e) => (e.group as string) === 'platform').map((e) => e.id)].sort());
    for (const id of HIDDEN_NON_PLATFORM) expect(entries.some((e) => e.id === id), `${id} is a real manifest entry`).toBe(true);
  });

  it('each hidden entry is hidden only for the reason that corp_admin lacks its permission, and that permission is a left-out code (section 3.3)', async () => {
    const { entries, visible } = await nav();
    const seen = new Set(visible.map((e) => e.id));
    for (const e of entries.filter((x) => !seen.has(x.id))) {
      expect(held.has(e.permission), `${e.id} hidden although corp_admin holds ${e.permission}`).toBe(false);
      expect(LEFT_OUT.test(e.permission), `${e.id} hidden for ${e.permission}, which section 3.3 does not leave out: record the reason`).toBe(true);
    }
  });

  it('front_desk shows registration, worklist and discount approvals for the administrator', async () => {
    const { visible } = await nav();
    const paths = visible.filter((e) => e.group === 'front_desk').map((e) => e.path);
    for (const p of ['/frontdesk/worklist', '/frontdesk/discount-approvals']) expect(paths, p).toContain(p);
    // registration needs frontdesk.registration.create: shown only if the matrix gives it (reported below otherwise)
    expect(paths.includes('/frontdesk/registrations/new')).toBe(held.has('frontdesk.registration.create'));
  });

  it('writes the report of entries the pack does NOT see (a report, never a failure)', async () => {
    const { entries, visible } = await nav();
    const seen = new Set(visible.map((e) => e.id));
    const hidden = entries.filter((e) => !seen.has(e.id));
    const rows = hidden.map((e) => `| ${e.group} | ${e.id} | ${e.path} | ${e.permission} |`);
    const out = [
      '# T0D-NAV-COMPLETE-1 / ADMINPACK-1: entries the administrator pack corp_admin does NOT see',
      '',
      `Generated by nav-complete.admin-pack.test.ts from the API pack data (role-packs.data.yaml) and the real manifests. corp_admin holds ${held.size} permissions; ${visible.length} of ${entries.length} entries are visible, ${hidden.length} are not.`,
      'An entry is hidden when corp_admin lacks its permission (11-ROLE-MATRIX R5a and section 3.3 leave decision, bench, money and platform authority out on purpose). The owner can widen with one line in the matrix and the pack data.',
      '',
      `Tenant groups with NO visible entry for corp_admin: ${TENANT_GROUPS.filter((g) => !visible.some((e) => e.group === g)).join(', ') || 'none'}.`,
      '',
      '| group | entry id | path | permission the pack lacks |',
      '|---|---|---|---|',
      ...rows,
      '',
    ].join('\n');
    const dir = join(ROOT, '.orchestra', 'notes');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'T0D-NAV-COMPLETE-1-admin-hidden.md'), out);
    expect(hidden.every((e) => !held.has(e.permission))).toBe(true);
  });
});
