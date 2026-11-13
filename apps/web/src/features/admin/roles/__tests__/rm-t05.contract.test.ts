// RM-T05 — contract + static rules for the "apply a role pack" admin screen (11-ROLE-MATRIX §8, LD-141, LD-140).
// done_when: operation applyRolePack in contracts/openapi (CR-C2-RM-001 accepted by C0 first); screen uses PermissionMatrix and the kit only.
// Expected red now: no applyRolePack operation, no pack-list read, no staff_web route, no screen files.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, listPacksOp, operation, packRoute } from './rm-t05.contract';

const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
const FEATURE = join(WEB_SRC, 'features', 'admin', 'roles');
const sources = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === '__tests__') return [];
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });

describe('contract (CR-C2-RM-001)', () => {
  it('identity.yaml declares operation applyRolePack as POST, tenant context, gated by identity.role.manage', () => {
    const o = operation('applyRolePack');
    expect(o, 'operationId applyRolePack missing from contracts/openapi/identity.yaml').toBeDefined();
    expect(o!.method).toBe('POST');
    expect(o!.op['x-permission']).toBe('identity.role.manage');
    expect(o!.op['x-context']).toBe('tenant');
    expect(o!.op.security).toEqual([{ bearerJwt: [] }]);
  });
  it('request body carries only pack_code (tenant and actor come from the token, never the body); response lists created / updated / unchanged role codes', () => {
    const o = operation('applyRolePack');
    expect(o).toBeDefined();
    const text = JSON.stringify(o!.op);
    expect(text).toMatch(/pack_code/);
    expect(text).not.toMatch(/tenant_id|actor_id|membership_id/);
    for (const k of ['created', 'updated', 'unchanged']) expect(text).toContain(k);
    for (const c of ['403', '422']) expect(Object.keys(o!.op.responses)).toContain(c);
  });
  it('a pack-list read exists (GET …/role-packs) so the screen can diff a pack against the current roles', () => {
    expect(listPacksOp(), 'no GET path ending in /role-packs in identity.yaml').toBeDefined();
  });
  it('routes.yaml has a staff_web route for the screen owned by C2, permission identity.role.manage', () => {
    const r = packRoute();
    expect(r, 'no /admin/roles/…pack… staff_web route in contracts/routes.yaml').toBeDefined();
    expect(r!.permission).toBe('identity.role.manage');
  });
});

describe('screen sources (apps/web/src/features/admin/roles/**, LD-140)', () => {
  const files = sources(FEATURE);
  const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  it('feature files exist', () => { expect(files.length).toBeGreaterThan(0); });
  it('uses PermissionMatrix from the kit', () => { expect(all).toMatch(/@lims\/ui\/components\/PermissionMatrix/); });
  it('kit only: no hex colours, pixel radii, inline styles or raw colour functions', () => {
    expect(files.length).toBeGreaterThan(0); // not vacuous
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(all).not.toMatch(/border-radius\s*:|borderRadius\s*[:=]/);
    expect(all).not.toMatch(/\bstyle\s*=\s*\{/);
    expect(all).not.toMatch(/\b(rgb|hsl)a?\(/);
  });
  it('no new UI dependency: imports only react, next, @lims/ui and relative or @/ paths', () => {
    expect(files.length).toBeGreaterThan(0); // not vacuous
    const mods = [...all.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(mods.filter((m) => !/^(react|react\/.*|next\/.*|server-only|@lims\/ui\/.*|@\/.*|\.{1,2}\/.*)$/.test(m))).toEqual([]);
  });
  it('page (if present) gates on identity.role.manage before any API call, and hardcodes no pack role content', () => {
    const r = packRoute();
    expect(r).toBeDefined();
    const page = join(WEB_SRC, 'app', '(staff)', 'admin', ...r!.rel.split('/'), 'page.tsx');
    expect(existsSync(page), `missing ${page}`).toBe(true);
    const src = readFileSync(page, 'utf8');
    expect(src).toMatch(/gate\(\s*['"]identity\.role\.manage['"]\s*\)/);
    expect(src.indexOf('identity.role.manage')).toBeLessThan(src.search(/\bcall\s*[<(]/));
    expect(all + src).not.toMatch(/\b(corp|std)_[a-z_]+/); // pack contents come from the API, never copied into the web
  });
});
