// C2.T20 static tests: route files for AD-1..AD-15 + ME-1, nav manifest (04-UI-UX §1), help files (§3 "Help"), source rules (REQ-SEC-088, REQ-SEC-068).
// ASSUMED: manifest at features/admin/nav.manifest.ts exporting `navManifest: NavManifest` (same shape as features/analytics/nav.manifest.ts);
// help at features/admin/help/<screen>.md; page files under app/(staff)/admin/<route>/page.tsx. routeIds are the writer's choice but must exist in contracts/routes.yaml
// (build-nav fails otherwise — the verify.cmd runs `build:nav` first), so any missing staff.admin.* route needs a CR for contracts/routes.yaml (not owned by C2's UI task).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const APP = join(WEB, 'src', 'app', '(staff)', 'admin');
const FEAT = join(WEB, 'src', 'features', 'admin');

// [route dir under /admin, screen id, permission]  — 04-UI-UX §1
const SCREENS: Array<[string, string, string]> = [
  ['me', 'ME-1', 'identity.self.manage'],
  ['users', 'AD-1', 'identity.user.read'],
  ['users/new', 'AD-2', 'identity.user.manage'],
  ['users/[membership_id]', 'AD-3', 'identity.user.read'],
  ['roles', 'AD-4', 'identity.user.read'],
  ['roles/[role_id]', 'AD-5', 'identity.user.read'],
  ['roles/new', 'AD-5', 'identity.role.manage'],
  ['branches', 'AD-6', 'identity.user.read'],
  ['centres', 'AD-7', 'identity.centre.read'],
  ['settings', 'AD-8', 'identity.settings.manage'],
  ['sessions', 'AD-9', 'identity.session.revoke'],
  ['audit', 'AD-10', 'audit.log.read'],
  ['audit/[audit_id]', 'AD-11', 'audit.log.read'],
  ['access-log', 'AD-12', 'audit.log.read'],
  ['exports', 'AD-13', 'audit.log.export'],
  ['support-access', 'AD-14', 'audit.log.read'],
  ['access-review', 'AD-15', 'identity.user.read'],
];
const HELP = ['me', 'users', 'user-new', 'user-detail', 'roles', 'role-editor', 'branches', 'centres', 'settings', 'sessions', 'audit', 'audit-entry', 'access-log', 'exports', 'support-access', 'access-review'];

const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === '__tests__' || f === 'auth' ? [] : walk(p)) : [p]; }) : []);
const sources = () => [...walk(APP), ...walk(FEAT)].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !/nav\.manifest/.test(f));

describe('C2.T20 static — screens exist', () => {
  for (const [dir, id] of SCREENS) {
    it(`${id}: app/(staff)/admin/${dir}/page.tsx exists and default-exports a page`, () => {
      const f = join(APP, ...dir.split('/'), 'page.tsx');
      expect(existsSync(f), f).toBe(true);
      expect(readFileSync(f, 'utf8')).toMatch(/export\s+default/);
    });
  }
  it('admin loading/error boundaries exist (billing/analytics convention)', () => {
    expect(existsSync(join(APP, 'loading.tsx')), 'admin/loading.tsx').toBe(true);
    expect(existsSync(join(APP, 'error.tsx')), 'admin/error.tsx').toBe(true);
  });
  it('the audit-export download is a BFF route handler (Bearer never reaches the browser, AC-D4.5)', () => {
    const f = join(APP, 'exports', '[export_id]', 'file', 'route.ts');
    expect(existsSync(f), f).toBe(true);
    const s = readFileSync(f, 'utf8');
    expect(s).toMatch(/export\s+(async\s+function|const)\s+GET/);
    expect(s).toMatch(/audit-exports/);
  });
});

describe('C2.T20 static — nav manifest (04-UI-UX §1: group "Administration", permission per item)', () => {
  it('features/admin/nav.manifest.ts exists with module "admin" and group admin entries carrying the spec permissions', async () => {
    const f = join(FEAT, 'nav.manifest.ts');
    expect(existsSync(f), f).toBe(true);
    const { navManifest } = (await import(/* @vite-ignore */ '../nav.manifest')) as { navManifest: { module: string; entries: Array<{ id: string; routeId: string; permission: string; group: string; order: number; chord?: string }> } };
    expect(navManifest.module).toBe('admin');
    expect(navManifest.entries.length).toBeGreaterThanOrEqual(13);
    expect(new Set(navManifest.entries.map((e) => e.group))).toEqual(new Set(['admin']));
    const perms = navManifest.entries.map((e) => e.permission);
    for (const p of ['identity.user.read', 'identity.centre.read', 'identity.settings.manage', 'identity.session.revoke', 'audit.log.read', 'audit.log.export']) expect(perms, p).toContain(p);
    const ids = navManifest.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => i.startsWith('admin.'))).toBe(true);
    const orders = navManifest.entries.map((e) => e.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // nothing from the platform console leaks into the tenant manifest (04-UI-UX §1: platform has its own manifest)
    expect(navManifest.entries.filter((e) => /platform/.test(e.routeId) || /^platform\./.test(e.permission))).toEqual([]);
  });
  it('"My account" (ME-1) is reachable for identity.self.manage (shell user menu or manifest entry)', async () => {
    const { navManifest } = (await import(/* @vite-ignore */ '../nav.manifest')) as { navManifest: { entries: Array<{ permission: string; routeId: string }> } };
    const shell = readFileSync(join(WEB, 'src', 'core', 'shell', 'AppShell.tsx'), 'utf8');
    expect(navManifest.entries.some((e) => e.permission === 'identity.self.manage') || /\/admin\/me/.test(shell)).toBe(true);
  });
});

describe('C2.T20 static — help panel content per screen (04-UI-UX §3; the manual itself is T30)', () => {
  for (const h of HELP) {
    it(`features/admin/help/${h}.md exists and is non-trivial`, () => {
      const f = join(FEAT, 'help', `${h}.md`);
      expect(existsSync(f), f).toBe(true);
      expect(readFileSync(f, 'utf8').trim().length).toBeGreaterThan(80);
    });
  }
});

describe('C2.T20 static — source rules', () => {
  it('has sources to scan (guards against a vacuous pass)', () => {
    expect(sources().length).toBeGreaterThan(10);
  });
  it('REQ-SEC-088: no innerHTML / dangerouslySetInnerHTML / inline SVG injection of audit or user values', () => {
    for (const f of sources()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  });
  it('REQ-SEC-068: no token or storage handling in admin code (no localStorage/sessionStorage/document.cookie; no "use client" file imports server-fetch/session/server)', () => {
    for (const f of sources()) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      if (/^\s*['"]use client['"]/m.test(s)) expect(s, f).not.toMatch(/core\/api\/server-fetch|core\/session\/server|LIMS_ORIGIN_API/);
    }
  });
  it('server-fetch/session are only used from server files (server-only guard)', () => {
    for (const f of sources()) {
      const s = readFileSync(f, 'utf8');
      if (/core\/api\/server-fetch/.test(s)) expect(/^\s*['"]use client['"]/m.test(s), `${f} is a client file importing server-fetch`).toBe(false);
    }
  });
  it('error codes are never shown raw: pages/components map codes to catalog copy (no bare `problem.code` / `error.message` rendering)', () => {
    for (const f of sources().filter((x) => x.endsWith('.tsx'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\{\s*(err|error|e)\.message\s*\}/);
  });
  it('message keys follow admin.<screen>.<key> (02-CV §13) for any key string used', () => {
    const keys = sources().flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/['"`]((?:admin|platform|auth)\.[a-z0-9_]+\.[a-z0-9_.]+)['"`]/g)].map((m) => m[1]!));
    for (const k of keys) expect(k).toMatch(/^(admin|platform|auth)\.[a-z0-9_]+\.[a-z0-9_]+(\.[a-z0-9_]+)*$/);
  });
});
