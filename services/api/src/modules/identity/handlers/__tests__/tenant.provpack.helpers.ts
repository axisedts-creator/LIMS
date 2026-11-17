// T0B-PROVPACK-1 helpers (not a test file). Synthetic data only.
// A small STATEFUL pg simulator for the tables the provision -> accept -> activate -> getMe chain touches (core.tenants, roles, role_permissions,
// users, memberships, membership_roles, branches, collection_centres). It plugs into the T0B-PROVFIX-2 recording pool (tenant.realchain.helpers `handle`),
// so the REAL pipeline, handlers, tenant.service, tenant repo, role-pack.service and self.service/self.repo run; only the database is simulated.
// It enforces what the real schema enforces and the fix must respect: UNIQUE (tenant_id, role_code) and the role_permissions primary key (a plain INSERT of an
// existing grant throws 23505; ON CONFLICT DO NOTHING is honoured). BEGIN / ROLLBACK are modelled (snapshot + restore), so a failed step leaves nothing behind.
// Any statement it does not know that touches roles / role_permissions throws: the writer's new SQL must use the same shapes as role-pack.service / seedRoles
// (INSERT ... unnest($n::text[]), tenant_id first, role id as a bound parameter) or extend this file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import type { PoolHandle } from './tenant.realchain.helpers.js';

export interface SimRole { id: string; tenant_id: string; role_code: string; display_name: string; is_system_default: boolean; is_active: boolean; mfa_required: boolean }
interface SimTenant { id: string; code: string; legal_name: string; display_name: string; status: string; version: number; activated_at: Date | null; created_at: Date }
interface SimMember { id: string; tenant_id: string; user_id: string; status: string; accepted: boolean; all_centres: boolean }
interface State {
  tenants: SimTenant[]; roles: SimRole[]; perms: Array<{ t: string; role: string; code: string }>; users: Array<{ t: string; id: string; name: string; email: string }>;
  members: SimMember[]; mroles: Array<{ t: string; membership: string; role: string }>; branches: Array<{ t: string; id: string }>; centres: Array<{ t: string; id: string }>;
}
const empty = (): State => ({ tenants: [], roles: [], perms: [], users: [], members: [], mroles: [], branches: [], centres: [] });
const dupe = (constraint: string) => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });
const norm = (s: string) => s.replace(/\s+/g, ' ');

export function makeDbSim() {
  let st = empty();
  let snap: State | undefined;
  const writes: Array<{ text: string; values: unknown[] }> = [];   // every statement that changes roles / role_permissions / membership_roles, in order
  const tenantRow = (t: SimTenant) => ({
    id: t.id, code: t.code, legal_name: t.legal_name, display_name: t.display_name, status: t.status, timezone: 'Asia/Kathmandu', status_reason: null, activated_at: t.activated_at,
    suspended_at: null, offboarded_at: null, billing_live_on: null, created_at: t.created_at, version: t.version,
  });
  const permsOf = (roleId: string) => st.perms.filter((p) => p.role === roleId).map((p) => p.code).sort();
  const grant = (t: string, role: string, codes: string[], onConflictNothing: boolean) => {
    for (const code of codes) {
      if (st.perms.some((p) => p.role === role && p.code === code)) { if (onConflictNothing) continue; throw dupe('role_permissions_pkey'); }
      st.perms.push({ t, role, code });
    }
  };
  const addRole = (r: SimRole) => {
    if (st.roles.some((x) => x.tenant_id === r.tenant_id && x.role_code === r.role_code)) throw dupe('roles__tenant_code__uq');
    st.roles.push(r);
  };

  const handle: PoolHandle = (text, values, res) => {
    const t = norm(text);
    const v = values as any[];
    // ---- transaction control: snapshot at BEGIN, restore at ROLLBACK (savepoint rollbacks are not modelled), fall through to the stock answer
    if (/^BEGIN\b/i.test(t)) { snap = structuredClone(st); return undefined; }
    if (/^ROLLBACK$/i.test(t)) { if (snap) st = structuredClone(snap); return undefined; }

    // ---- core.tenants
    if (/FROM core\.tenants t WHERE t\.tenant_code = \$1/i.test(t)) { const x = st.tenants.find((r) => r.code === v[0]); return res(x ? [tenantRow(x)] : [], 'SELECT'); }
    if (/FROM core\.tenants t WHERE t\.id = \$1/i.test(t)) { const x = st.tenants.find((r) => r.id === v[0]); return res(x ? [tenantRow(x)] : [], 'SELECT'); }
    if (/^INSERT INTO core\.tenants/i.test(t)) {
      if (st.tenants.some((r) => r.code === v[1])) throw dupe('tenants__tenant_code__uq');
      const x: SimTenant = { id: v[0], code: v[1], legal_name: v[2], display_name: v[3], status: 'provisioning', version: 1, activated_at: null, created_at: new Date('2026-11-17T00:00:00Z') };
      st.tenants.push(x); return res([tenantRow(x)], 'INSERT', 1);
    }
    if (/^UPDATE core\.tenants SET status = \$3/i.test(t)) {   // repo.setStatus: [id, expectedVersion, status, reason, at, actor]
      const x = st.tenants.find((r) => r.id === v[0] && r.version === v[1]);
      if (!x) return res([], 'UPDATE', 0);
      x.status = v[2]; x.version += 1; if (v[2] === 'active' && !x.activated_at) x.activated_at = v[4];
      return res([tenantRow(x)], 'UPDATE', 1);
    }

    // ---- branches / centres / users / memberships
    if (/^INSERT INTO core\.branches/i.test(t)) { st.branches.push({ t: v[1], id: v[0] }); return res([], 'INSERT', 1); }
    if (/^INSERT INTO core\.collection_centres/i.test(t)) { st.centres.push({ t: v[1], id: v[0] }); return res([], 'INSERT', 1); }
    if (/^INSERT INTO core\.users/i.test(t)) { st.users.push({ t: v[0], id: v[1], name: v[2], email: v[3] }); return res([], 'INSERT', 1); }
    if (/^INSERT INTO core\.memberships/i.test(t)) {   // [tenant, membership id, user id, actor] ('invited', all_centres true in the statement)
      st.members.push({ id: v[1], tenant_id: v[0], user_id: v[2], status: 'invited', accepted: false, all_centres: true }); return res([], 'INSERT', 1);
    }

    // ---- core.roles
    if (/^INSERT INTO core\.roles/i.test(t)) {
      if (/is_system_default/i.test(t)) {   // tenant.service seedRoles: [id, tenant, code, description, mfa, actor] -> a system default role
        addRole({ id: v[0], tenant_id: v[1], role_code: v[2], display_name: v[2], is_system_default: true, is_active: true, mfa_required: v[4] });
      } else {                              // role-pack.service insertRole: [tenant, id, code, name, mfa, actor] -> a custom role (is_system_default column default false)
        addRole({ id: v[1], tenant_id: v[0], role_code: v[2], display_name: v[3], is_system_default: false, is_active: true, mfa_required: v[4] });
      }
      writes.push({ text: t, values: v }); return res([], 'INSERT', 1);
    }
    if (/SELECT r\.id, r\.role_code AS code, r\.is_system_default, r\.is_active, r\.mfa_required/i.test(t)) {   // role-pack.service listRoles
      return res(st.roles.filter((r) => r.tenant_id === v[0]).sort((a, b) => a.role_code.localeCompare(b.role_code))
        .map((r) => ({ id: r.id, code: r.role_code, is_system_default: r.is_system_default, is_active: r.is_active, mfa_required: r.mfa_required, permission_codes: permsOf(r.id) })), 'SELECT');
    }
    if (/^INSERT INTO core\.role_permissions/i.test(t)) {
      // known shape (seedRoles and role-pack grant): [tenant, role id, text[] codes, actor]; fallback: role id / role code found among the parameters or the SQL literal
      const codes = v.find((x) => Array.isArray(x)) as string[] | undefined;
      let role = st.roles.find((r) => r.id === v[1] && r.tenant_id === v[0]);
      if (!role) {
        const lit = /role_code = '([a-z_0-9]+)'/i.exec(t)?.[1];
        const code = lit ?? (v.find((x) => typeof x === 'string' && st.roles.some((r) => r.tenant_id === v[0] && r.role_code === x)) as string | undefined);
        role = code === undefined ? undefined : st.roles.find((r) => r.tenant_id === v[0] && r.role_code === code);
      }
      if (!codes || !role) throw new Error(`TEST SIM: unrecognised role_permissions statement (adapt the SQL to the seedRoles / role-pack shape or extend the sim): ${t}`);
      grant(v[0], role.id, codes, /ON CONFLICT DO NOTHING/i.test(t)); writes.push({ text: t, values: v }); return res([], 'INSERT', codes.length);
    }
    if (/^(UPDATE|DELETE)\b.*\bcore\.(roles|role_permissions|membership_roles)\b/i.test(t) || /^DELETE FROM core\.(roles|role_permissions|membership_roles)/i.test(t)) {
      writes.push({ text: t, values: v });   // recorded; the test asserts none exists (the step is additive only)
      throw new Error(`TEST SIM: ${t.slice(0, 60)} is not allowed in this task (additive only)`);
    }

    // ---- membership_roles (admin invite) and the readiness count of activateTenant
    if (/^INSERT INTO core\.membership_roles/i.test(t)) {   // [tenant, membership id, actor]; the statement selects the tenant_admin role
      const role = st.roles.find((r) => r.tenant_id === v[0] && r.role_code === 'tenant_admin' && r.is_active);
      if (!role) return res([], 'INSERT', 0);
      st.mroles.push({ t: v[0], membership: v[1], role: role.id }); writes.push({ text: t, values: v }); return res([{ role_id: role.id }], 'INSERT', 1);
    }
    if (/AS admins/i.test(t) && /AS branches/i.test(t)) {
      const id = v[0];
      const admins = st.members.filter((m) => m.tenant_id === id && m.status === 'active' && m.accepted
        && st.mroles.some((x) => x.membership === m.id && st.roles.some((r) => r.id === x.role && r.is_active && r.role_code === 'tenant_admin'))).length;
      return res([{ admins, branches: st.branches.filter((b) => b.t === id).length, centres: st.centres.filter((c) => c.t === id).length }], 'SELECT');
    }

    // ---- getMe: the self.repo PROFILE_SQL (profile + roles + permissions of one membership)
    if (/AS permissions/i.test(t) && /FROM core\.memberships m JOIN core\.users u/i.test(t)) {   // [tenant, membership id, user id, actor type, 'verified']
      const m = st.members.find((x) => x.tenant_id === v[0] && x.id === v[1] && x.user_id === v[2]); const u = m && st.users.find((x) => x.t === v[0] && x.id === m.user_id);
      if (!m || !u) return res([], 'SELECT');
      const mine = st.mroles.filter((x) => x.t === v[0] && x.membership === m.id).map((x) => st.roles.find((r) => r.id === x.role)!).filter((r) => r.is_active)
        .sort((a, b) => a.role_code.localeCompare(b.role_code));
      return res([{
        membership_id: m.id, user_id: m.user_id, last_login_at: null, all_centres: m.all_centres, display_name: u.name, email: u.email,
        role_ids: mine.map((r) => r.id), role_codes: mine.map((r) => r.role_code), role_names: mine.map((r) => r.display_name),
        permissions: [...new Set(mine.flatMap((r) => permsOf(r.id)))].sort(), centre_ids: [], has_verified_factor: false,
      }], 'SELECT');
    }
    return undefined;
  };

  const rolesOf = (t: string) => st.roles.filter((r) => r.tenant_id === t);
  return {
    handle, writes,
    roles: rolesOf, role: (t: string, code: string) => st.roles.find((r) => r.tenant_id === t && r.role_code === code),
    perms: (t: string, code: string) => { const r = st.roles.find((x) => x.tenant_id === t && x.role_code === code); return r ? permsOf(r.id) : []; },
    grantCount: (t: string) => st.perms.filter((p) => p.t === t).length,
    tenant: (id: string) => st.tenants.find((x) => x.id === id), members: (t: string) => st.members.filter((m) => m.tenant_id === t),
    memberRoleCount: (t: string) => st.mroles.filter((m) => m.t === t).length,
    /** the "accept" step (invitation accepted by the first administrator): the T0B-ACTIVATE-1 tests cover the real accept; here the row is set like the accept does */
    accept(t: string) { for (const m of st.members.filter((x) => x.tenant_id === t)) { m.status = 'active'; m.accepted = true; } },
    /** a custom (non default) role the lab created itself */
    seedCustomRole(o: { tenant: string; id: string; code: string; name: string; mfa: boolean; perms: string[] }) {
      addRole({ id: o.id, tenant_id: o.tenant, role_code: o.code, display_name: o.name, is_system_default: false, is_active: true, mfa_required: o.mfa });
      grant(o.tenant, o.id, o.perms, false);
    },
    /** A lab provisioned BEFORE the fix, in its state on staging 2026-11-17: ten default roles with the old grants, no pack, an accepted tenant_admin, status provisioning. */
    seedLegacyLab(o: { id: string; code: string; adminUser: string; adminMembership: string; oldAdminGrants: string[]; defaultGrants: Record<string, string[]>; defaultMfa: Record<string, boolean> }) {
      st.tenants.push({ id: o.id, code: o.code, legal_name: 'Synthetic Legacy Lab', display_name: 'Legacy', status: 'provisioning', version: 1, activated_at: null, created_at: new Date('2026-11-16T00:00:00Z') });
      st.branches.push({ t: o.id, id: 'b1' }); st.centres.push({ t: o.id, id: 'c1' });
      let n = 0;
      for (const [code, codes] of Object.entries(o.defaultGrants)) {
        const id = `0190a000-0000-7000-8000-${(0x9000 + n++).toString(16).padStart(12, '0')}`;
        st.roles.push({ id, tenant_id: o.id, role_code: code, display_name: code, is_system_default: true, is_active: true, mfa_required: o.defaultMfa[code] ?? false });
        grant(o.id, id, code === 'tenant_admin' ? o.oldAdminGrants : codes, false);
      }
      st.users.push({ t: o.id, id: o.adminUser, name: 'Legacy Admin', email: 'legacy.admin@synthetic.example.test' });
      st.members.push({ id: o.adminMembership, tenant_id: o.id, user_id: o.adminUser, status: 'active', accepted: true, all_centres: true });
      st.mroles.push({ t: o.id, membership: o.adminMembership, role: st.roles.find((r) => r.tenant_id === o.id && r.role_code === 'tenant_admin')!.id });
    },
  };
}
export type DbSim = ReturnType<typeof makeDbSim>;

// ---- the permission catalogue read straight from contracts/permissions.yaml (an oracle independent of the generated TypeScript and of the fix)
type Entry = { code: string; privileged: boolean; roles: string[] };
const doc = parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8')) as { roles: Array<{ code: string; mfa_required: boolean }>; permissions: Entry[] };
export const CATALOGUE: readonly Entry[] = doc.permissions;
export const DEFAULT_ROLE_CODES: string[] = doc.roles.map((r) => r.code);
export const DEFAULT_ROLE_MFA: Record<string, boolean> = Object.fromEntries(doc.roles.map((r) => [r.code, r.mfa_required]));
/** every tenant scoped permission: not platform.*, and not actor-only (roles: [] = device / portal / patient / partner / system sets, never a tenant role) */
export const TENANT_SCOPED: string[] = CATALOGUE.filter((e) => !e.code.startsWith('platform.') && e.roles.length > 0).map((e) => e.code).sort();
export const NEVER_FOR_TENANT_ADMIN: string[] = CATALOGUE.filter((e) => e.code.startsWith('platform.') || e.roles.length === 0).map((e) => e.code).sort();
/** what a non-admin default role holds today (the catalogue's `roles:` lists); no other role may gain anything */
export const GRANTS_OF = (role: string): string[] => CATALOGUE.filter((e) => e.roles.includes(role)).map((e) => e.code).sort();
