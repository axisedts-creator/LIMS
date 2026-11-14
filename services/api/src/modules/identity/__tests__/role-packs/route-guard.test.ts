// RM-T03 per-route guard (11-ROLE-MATRIX §4 item 3; rules R1, R4; LD-141). For every staff_web route in contracts/routes.yaml and every
// role of both packs (data file read directly):
//   API:  IdentityPort.assertRole(ctx, { permission: <route permission> }) -> resolves when the role holds it, else rejects `auth.forbidden` (403).
//   Nav:  the shell shows the route's nav entry (apps/web nav manifests, filtered exactly like core/shell/AppShell.tsx) iff the role holds it.
// A route with no nav entry (parameterised detail pages, no manifest) is checked for the API half only. Assumed seams: createIdentityPort
// (ports/IdentityPort.impl.ts) with the fake repo of ports/__tests__/helpers.ts; buildNav(featuresDir, routesYaml) from apps/web core/nav.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildNav } from '../../../../../../../apps/web/src/core/nav/build-nav.ts';
import { createIdentityPort } from '../../ports/IdentityPort.impl.js';
import { makeCtx, makeFakeRepo, member } from '../../ports/__tests__/helpers';

const ROOT = join(import.meta.dirname, '../../../../../../..');
const routesYaml = readFileSync(join(ROOT, 'contracts/routes.yaml'), 'utf8');
const registry = new Set((parse(readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8')).permissions as Array<{ code: string }>).map((p) => p.code));
const packs = (parse(readFileSync(join(import.meta.dirname, '../../role-packs/role-packs.data.yaml'), 'utf8')) as {
  packs: Array<{ code: string; roles: Array<{ code: string; permissions: string[] }> }>;
}).packs;
const roles = packs.flatMap((p) => p.roles);
const routes = (parse(routesYaml) as { routes: Array<{ id: string; origin: string; path: string; permission?: string; auth?: string; nav?: boolean }> }).routes.filter((r) => r.origin === 'staff_web');
// Routes that name another auth scheme (e.g. the queue-display kiosk, auth: display_token) are not permission routes: they must say so and have no nav entry.
const tokenRoutes = routes.filter((r) => !r.permission && r.auth);
const permRoutes = routes.filter((r) => r.permission);

// One active tenant-A user per pack role, holding exactly the pack's permissions (custom role, S9).
const personaOf = (code: string) => `rm03-${code}`;
const port = createIdentityPort({
  repo: makeFakeRepo({ members: roles.map((r, i) => member('A', personaOf(r.code), 10 + i, { roleCodes: [r.code], permissions: [...r.permissions] })) }).repo as any,
  systemActorPermissions: () => [],
});
async function outcome(role: string, permission: string): Promise<string> {
  const e = await port.assertRole(makeCtx('A', 'user', personaOf(role)), { permission }).then(() => undefined, (x: any) => x);
  return e === undefined ? 'allow' : String(e.code);
}

let nav: Awaited<ReturnType<typeof buildNav>>;
beforeAll(async () => { nav = await buildNav(join(ROOT, 'apps/web/src/features'), routesYaml); });
// Same predicate as AppShell.tsx / core/permissions/routes.ts hasPermission.
const visibleNav = (perms: readonly string[]) => nav.entries.filter((e) => perms.includes(e.permission));

describe('RM-T03 per-route guard: inputs', () => {
  it('both packs loaded (29 roles) and the route table has staff_web routes', () => {
    expect(roles.length).toBe(29);
    expect(routes.length).toBeGreaterThan(100);
    expect(permRoutes.length + tokenRoutes.length).toBe(routes.length);
  });
  it('every staff_web route carries a permission that exists in contracts/permissions.yaml, or an explicit non-permission auth and no nav entry', () => {
    expect(permRoutes.filter((r) => !registry.has(r.permission!)).map((r) => `${r.id}: ${r.permission}`)).toEqual([]);
    expect(routes.filter((r) => !r.permission && !r.auth).map((r) => r.id)).toEqual([]);
  });
  it('token-auth routes never appear in the nav and no pack role is granted anything for them', () => {
    for (const r of tokenRoutes) expect(nav.entries.some((e) => e.routeId === r.id), r.id).toBe(false);
  });
  it('nav manifests build cleanly and are non-empty', () => {
    expect(nav.errors).toEqual([]);
    expect(nav.entries.length).toBeGreaterThan(5);
  });
  it('the shell filters nav by the actor permissions (AppShell.tsx) so the hint matches this test', () => {
    const src = readFileSync(join(ROOT, 'apps/web/src/core/shell/AppShell.tsx'), 'utf8');
    expect(src).toMatch(/navEntries\.filter\(\(e\) => hasPermission\(session\.actor\.permissions, e\.permission\)\)/);
  });
});

describe('RM-T03 per-route guard: API 403 and nav entry, every staff_web route x every pack role', () => {
  it.each(permRoutes.map((r) => [r.id, r] as const))('route %s', async (_id, route) => {
    const wrong: string[] = [];
    const entries = nav.entries.filter((e) => e.routeId === route.id);
    for (const role of roles) {
      const holds = role.permissions.includes(route.permission!);
      const got = await outcome(role.code, route.permission!);
      if (holds && got !== 'allow') wrong.push(`${role.code} holds ${route.permission} but API says ${got}`);
      if (!holds && got !== 'auth.forbidden') wrong.push(`${role.code} lacks ${route.permission} but API says ${got} (want auth.forbidden)`);
      const shown = visibleNav(role.permissions).some((e) => e.routeId === route.id);
      for (const e of entries) expect(e.permission, `nav entry ${e.id} permission must equal the route's`).toBe(route.permission);
      if (entries.length > 0 && shown !== holds) wrong.push(`${role.code}: nav entry ${shown ? 'shown' : 'hidden'} but ${holds ? 'holds' : 'lacks'} ${route.permission}`);
    }
    expect(wrong).toEqual([]);
  });

  it('no role sees any nav entry whose permission it lacks, and sees every entry whose permission it holds', () => {
    const wrong: string[] = [];
    for (const role of roles) {
      const seen = new Set(visibleNav(role.permissions).map((e) => e.id));
      for (const e of nav.entries) if (seen.has(e.id) !== role.permissions.includes(e.permission)) wrong.push(`${role.code}: ${e.id}`);
    }
    expect(wrong).toEqual([]);
  });

  it('not vacuous: most routes are held by some role and refused to another; some nav entries are shown to some roles and hidden from others', () => {
    const split = permRoutes.filter((r) => roles.some((x) => x.permissions.includes(r.permission!)) && roles.some((x) => !x.permissions.includes(r.permission!)));
    expect(split.length).toBeGreaterThan(permRoutes.length / 2);
    const shownTo = (id: string) => roles.filter((r) => visibleNav(r.permissions).some((e) => e.id === id)).length;
    expect(nav.entries.filter((e) => shownTo(e.id) > 0 && shownTo(e.id) < roles.length).length).toBeGreaterThan(3);
  });

  it('a role with no permissions gets 403 on every staff route and an empty nav (fail closed)', async () => {
    const empty = createIdentityPort({ repo: makeFakeRepo({ members: [member('A', 'rm03-none', 90, { roleCodes: ['rm03_empty'], permissions: [] })] }).repo as any, systemActorPermissions: () => [] });
    for (const r of permRoutes)
      expect(await empty.assertRole(makeCtx('A', 'user', 'rm03-none'), { permission: r.permission! }).then(() => 'allow', (e: any) => e.code), r.id).toBe('auth.forbidden');
    expect(visibleNav([])).toEqual([]);
  });
});
