// RM-T03 matrix replay (11-ROLE-MATRIX §4 item 2; rules R1, R2, R4, R5; LD-141). Generated: iterates every (role, feature) cell of
// both sheets using the §5.1 / §5.2 screen -> permission tables parsed from the spec and the pack data file read directly.
//   ticked cell   -> the role holds all permissions of the feature, except the codes the R4 safety caps drop for that role.
//   unticked cell -> the role holds none of the permissions that belong ONLY to that feature (shared codes can come from another tick).
// LD-141: never widen a role to make a test pass; a mismatch is reported. Gap rows (status gap / no permissions) grant nothing (R7).
// Assumption (the per-role tick sheet is not in the repo, only the per-feature tick COUNT): a cell is "ticked" when the role holds the
// feature's effective permissions in full; "partial" (some but not all of the feature-only codes) is a violation. The tick count per
// feature is checked against the sheet's "Roles ticked" column. Admin (base_default_role tenant_admin, R5) holds the default role's
// codes without a tick, so Admin is exempt from the unticked rule and counted as +/-1 in the tick count.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '../../../../../../..');
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const md = lf(readFileSync(join(ROOT, 'spec/program/11-ROLE-MATRIX.md'), 'utf8'));
const data = parse(readFileSync(join(import.meta.dirname, '../../role-packs/role-packs.data.yaml'), 'utf8')) as {
  packs: Array<{ code: string; roles: Array<{ code: string; name: string; base_default_role: string | null; permissions: string[] }> }>;
};

// R4 caps (spec text): user/role management only on the pack Admin; instrument mapping only on Admin, the three Sr. Lab User roles, std Lab technician.
const ADMIN_ONLY = ['identity.role.manage', 'identity.user.manage'];
const INSTRUMENT = ['instruments.instrument.manage', 'catalog.instrument_code_map.manage'];
const INSTRUMENT_ROLES = new Set(['corp_admin', 'std_admin', 'corp_sr_lab_user', 'corp_sr_lab_user_t2', 'corp_senior_lab_user', 'std_lab_technician']);
const cappedFor = (role: string): Set<string> => {
  const out = new Set<string>();
  if (role !== 'corp_admin' && role !== 'std_admin') ADMIN_ONLY.forEach((c) => out.add(c));
  if (!INSTRUMENT_ROLES.has(role)) INSTRUMENT.forEach((c) => out.add(c));
  return out;
};

// R2 authority overlay (11-ROLE-MATRIX §3.1 paragraph "Authority overlay", D2/D3): codes a role may hold WITHOUT the screen being ticked,
// by role name. Only codes that also appear in a screen table are listed; overlay-only codes (approve, refund, ...) are RM-T04's.
const ENTRY = ['lab.result.read', 'lab.result.enter', 'lab.worklist.read'];
const CRITICAL = ['lab.critical_value.read', 'lab.critical_value.log_notification'];
const ENTRY_CV = [...ENTRY, ...CRITICAL];
const ACCOUNTING = ['billing.invoice.read', 'billing.invoice.issue', 'billing.invoice.reprint', 'billing.payment.record', 'billing.credit_party.read', 'billing.cash_report.read'];
const CLINICAL = [...ENTRY, ...CRITICAL, 'reporting.report.read', 'anatomic.case.read'];
const OVERLAY: Record<string, string[]> = {
  corp_pathologist: CLINICAL, corp_pathologist_t2: CLINICAL, corp_pathologist_t3: CLINICAL, std_consulting_pathologist: CLINICAL,
  // LD-151 (CR-C2-RM-002 option a): exactly these four roles keep both critical-value codes through the section 3.1 overlay (R2); nothing wider (LD-141).
  corp_sr_lab_user: ENTRY_CV, corp_sr_lab_user_t2: ENTRY_CV, corp_senior_lab_user: ENTRY_CV, corp_laboratory_lab_user: ENTRY_CV,
  corp_junior_lab_user: ENTRY, corp_laboratory_user: ENTRY, std_lab_technician: ENTRY,
  corp_accounts: ACCOUNTING, std_account: ACCOUNTING,
  corp_laboratory_admin: ['lab.status_board.read'], corp_collection_center: ['lab.specimen.collect', 'lab.specimen.label_print'],
};
const overlayOf = (role: string) => new Set(OVERLAY[role] ?? []);

type Feature = { key: string; name: string; count: number; status: string; perms: string[] };
function sheet(startHeading: string, endHeading: string): Feature[] {
  const a = md.indexOf(startHeading), b = md.indexOf(endHeading, a + 1);
  if (a < 0 || b < 0) throw new Error(`spec headings not found: ${startHeading} / ${endHeading}`);
  const rows: Feature[] = [];
  for (const line of md.slice(a, b).split('\n')) {
    const c = line.split('|').map((s) => s.trim());
    if (c.length < 7 || !/^\d+$/.test(c[3] ?? '')) continue;                    // table rows with a numeric "Roles ticked"
    rows.push({ key: `${c[1]} / ${c[2]}`, name: c[2]!, count: Number(c[3]), status: c[4]!, perms: [...(c[5] ?? '').matchAll(/`([a-z_]+\.[a-z_]+\.[a-z_]+)`/g)].map((m) => m[1]!) });
  }
  return rows;
}

const SHEETS = [
  { pack: 'elabcorp_default', roles: 19, rows: 80, features: sheet('### 5.1 ELabCorp sheet', '### 5.2 ELabAssist sheet') },
  { pack: 'elabassist_standard', roles: 10, rows: 44, features: sheet('### 5.2 ELabAssist sheet', '## 6. Gaps') },
];

describe.each(SHEETS)('RM-T03 matrix replay: $pack', ({ pack, roles: nRoles, features }) => {
  const roles = data.packs.find((p) => p.code === pack)?.roles ?? [];
  const held = new Map(roles.map((r) => [r.code, new Set(r.permissions)]));
  const mapped = features.filter((f) => f.status === 'ok' && f.perms.length > 0);
  // Codes that belong to exactly one feature of this sheet ("only to that feature").
  const owners = new Map<string, Set<string>>();
  for (const f of mapped) for (const p of f.perms) owners.set(p, (owners.get(p) ?? new Set()).add(f.key));
  const onlyOf = (f: Feature) => f.perms.filter((p) => owners.get(p)!.size === 1);
  const effective = (f: Feature, role: string) => f.perms.filter((p) => !cappedFor(role).has(p));
  const exclusive = (f: Feature, role: string) => onlyOf(f).filter((p) => !cappedFor(role).has(p));

  it('sheet parsed completely: all roles in the data file, 80 / 44 feature rows, gap rows grant nothing (R7)', () => {
    expect(roles.length).toBe(nRoles);
    for (const f of features.filter((x) => x.status === 'gap')) expect(f.perms, f.key).toEqual([]);
    expect(features.length).toBeLessThanOrEqual(SHEETS.find((s) => s.pack === pack)!.rows);
    expect(mapped.length).toBeGreaterThan(30);
  });

  it.each(mapped.map((f) => [f.key, f] as const))('feature %s: every role cell is ticked (holds all) or unticked (holds none of its own codes)', (_k, f) => {
    const bad: string[] = [];
    for (const r of roles) {
      const have = held.get(r.code)!;
      const eff = effective(f, r.code), only = exclusive(f, r.code);
      const ticked = eff.length > 0 && eff.every((p) => have.has(p));
      const ownHeld = only.filter((p) => have.has(p) && !overlayOf(r.code).has(p));   // overlay codes are R2, not a tick
      if (ticked) continue;                                                      // ticked cell: R1 holds all (checked above)
      if (r.base_default_role) continue;                                         // Admin: tenant_admin codes without a tick (R5)
      if (ownHeld.length > 0) bad.push(`${r.code}: unticked cell but holds ${ownHeld.join(', ')} (feature-only codes; holds ${eff.filter((p) => have.has(p)).length}/${eff.length})`);
    }
    expect(bad).toEqual([]);
  });

  it.each(mapped.filter((f) => onlyOf(f).length > 0).map((f) => [f.key, f] as const))(
    'feature %s: ticked-role count matches the sheet ("Roles ticked")',
    (_k, f) => {
      // Lower bound: roles holding every effective code of the feature (a tick implies it; overlay may add more). Upper bound: roles holding
      // every feature-only code that is neither capped (R4) nor overlay (R2) for them. Admin may hold codes via tenant_admin: it is +/-1.
      const nonAdmin = roles.filter((r) => !r.base_default_role);
      const holdsAll = (r: (typeof roles)[number], codes: string[]) => codes.length > 0 && codes.every((p) => held.get(r.code)!.has(p));
      const inclusive = nonAdmin.filter((r) => holdsAll(r, effective(f, r.code))).length;
      const strict = nonAdmin.filter((r) => holdsAll(r, exclusive(f, r.code).filter((p) => !overlayOf(r.code).has(p)))).length;
      expect(inclusive, `${f.key}: sheet says ${f.count} roles ticked, fewer hold its codes`).toBeGreaterThanOrEqual(f.count - 1);
      expect(strict, `${f.key}: sheet says ${f.count} roles ticked, more hold its feature-only codes`).toBeLessThanOrEqual(f.count);
    },
  );

  it('role-by-role replay: every permission a role holds is explained by a ticked feature, the Admin base, or the R2 overlay (R1: nothing more)', () => {
    const inAnyFeature = new Set(mapped.flatMap((f) => f.perms));
    const unexplained: string[] = [];
    for (const r of roles) {
      const have = held.get(r.code)!;
      const ticked = mapped.filter((f) => { const e = effective(f, r.code); return e.length > 0 && e.every((p) => have.has(p)); });
      const covered = new Set([...ticked.flatMap((f) => effective(f, r.code)), ...overlayOf(r.code)]);
      for (const p of have) if (inAnyFeature.has(p) && !covered.has(p) && !r.base_default_role)
        unexplained.push(`${r.code}: ${p} is a screen code but no ticked feature explains it`);
    }
    expect(unexplained).toEqual([]);
  });

  it('R4: capped codes never reach a role the cap excludes, even though the sheet ticks them', () => {
    for (const r of roles) for (const c of cappedFor(r.code)) expect(held.get(r.code)!.has(c), `${r.code} holds capped ${c}`).toBe(false);
  });
});
