// C13.T25 — in-app help + user manual. Plan row T25: "every PageHeader.helpKey has a help file (build check); manual pages for partner
// and staff roles". PRD IS-14. TRD §3.6 (apps/partner/src/features/<feature>/{...,help}), TRD §1 (docs/manual/partners/**).
// Help format = existing precedent (C11 T-25, apps/web/src/features/anatomic/help): help/<helpKey>.ts, default export
// { title, sections:[{heading,body}], links?:[{routeId,label}] }, plain data.
// LD-140: help is plain data -> no hex colours, pixel sizes or inline style objects in help files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');
const dirs = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()) : []);
function walk(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === '__tests__' || n === 'help' || n === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const keysIn = (files: string[]) => [...new Set(files.flatMap((f) => [...read(f).matchAll(/helpKey=["']([a-z_.]+)["']/g)].map((m) => m[1]!)))].sort();

// ---- the two surfaces -------------------------------------------------------------------------------------------------------------
const partnerSrc = join(root, 'apps/partner/src');
const partnerFeatures = join(partnerSrc, 'features');
const partnerHelpDirs = dirs(partnerFeatures).map((f) => join(partnerFeatures, f, 'help')).filter(existsSync);
const staffFeature = join(root, 'apps/web/src/features/partners');
const staffHelpDir = join(staffFeature, 'help');

const partnerKeys = keysIn(walk(partnerSrc));
const staffKeys = keysIn(walk(staffFeature));

type Help = { title: string; sections: { heading: string; body: string }[]; links?: { routeId: string; label: string }[] };
const load = async (file: string): Promise<Help> => (await import(/* @vite-ignore */ pathToFileURL(file).href)).default;
const routeIds = new Set([...read(join(root, 'contracts/routes.yaml')).matchAll(/\bid:\s*([a-z][\w.]*)/g)].map((m) => m[1]!));

function checkHelp(k: string, h: Help) {
  expect(typeof h.title, `${k}: title`).toBe('string');
  expect(h.title.trim().length).toBeGreaterThan(2);
  expect(h.sections.length, `${k}: needs >= 2 sections`).toBeGreaterThanOrEqual(2);
  for (const s of h.sections) {
    expect(s.heading.trim().length, `${k}: empty heading`).toBeGreaterThan(1);
    expect(s.body.trim().length, `${k}/${s.heading}: body too short`).toBeGreaterThan(40);
    expect(s.body, `${k}/${s.heading}: markup/HTML in plain-data help`).not.toMatch(/<[a-z][^>]*>/i);
  }
  for (const l of h.links ?? []) expect(routeIds.has(l.routeId), `${k}: unknown routeId ${l.routeId}`).toBe(true);
}
function checkLd140(files: string[]) {
  for (const f of files) {
    const t = read(f);
    expect(t, `${f}: hex colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(t, `${f}: px value`).not.toMatch(/\b\d+px\b/);
    expect(t, `${f}: inline style`).not.toMatch(/style\s*=\s*\{\{/);
  }
}
const baseKey = (f: string) => f.replace(/^.*[\\/]/, '').replace(/\.tsx?$/, '');

describe('C13 T25 partner app: every helpKey has a help file (apps/partner/src/features/*/help/<helpKey>.ts)', () => {
  const helpFile = (k: string) => partnerHelpDirs.map((d) => join(d, `${k}.ts`)).filter(existsSync);
  const all = partnerHelpDirs.flatMap((d) => readdirSync(d).filter((n) => /\.tsx?$/.test(n)).map((n) => join(d, n)));
  it('discovers the partner screens (non-vacuous)', () => {
    expect(partnerKeys).toEqual(expect.arrayContaining([
      'partners.home', 'partners.manifests', 'partners.manifest', 'partners.manifest_editor', 'partners.manifest_print', 'partners.orders', 'partners.order',
      'partners.reports', 'partners.report', 'partners.pickups', 'partners.pickup_request', 'partners.price_list', 'partners.statements', 'partners.referrers',
      'partners.users', 'partners.account',
    ]));
  });
  it.each(partnerKeys)('%s has exactly one help file with a title and sections', async (k) => {
    const f = helpFile(k);
    expect(f.length, `missing apps/partner/src/features/<feature>/help/${k}.ts (found ${f.length})`).toBe(1);
    checkHelp(k, await load(f[0]!));
  });
  it('no orphan help files (each maps to a helpKey in the partner app)', () => {
    expect(all.map(baseKey).filter((k) => !partnerKeys.includes(k))).toEqual([]);
  });
  it('LD-140: no hex colours, pixel sizes or inline style objects in help files', () => {
    expect(all.length, 'no partner help files at all').toBeGreaterThan(0);
    checkLd140(all);
  });
});

describe('C13 T25 staff web: every helpKey has a help file (apps/web/src/features/partners/help/<helpKey>.ts)', () => {
  const all = existsSync(staffHelpDir) ? readdirSync(staffHelpDir).filter((n) => /\.tsx?$/.test(n)).map((n) => join(staffHelpDir, n)) : [];
  it('discovers the staff screens (non-vacuous)', () => {
    expect(staffKeys).toEqual(expect.arrayContaining(['partners.inbox', 'partners.manifest', 'partners.pickups', 'partners.list', 'partners.detail', 'partners.referrers', 'partners.settings']));
  });
  it.each(staffKeys)('%s has a help file with a title and sections', async (k) => {
    const f = join(staffHelpDir, `${k}.ts`);
    expect(existsSync(f), `missing ${f}`).toBe(true);
    checkHelp(k, await load(f));
  });
  it('no orphan help files', () => {
    expect(all.map(baseKey).filter((k) => !staffKeys.includes(k))).toEqual([]);
  });
  it('LD-140: no hex colours, pixel sizes or inline style objects in help files', () => {
    expect(all.length, 'no staff help files at all').toBeGreaterThan(0);
    checkLd140(all);
  });
});

// ---- manual: docs/manual/partners/** (TRD §1: "partner portal + staff screens") -----------------------------------------------------
const manualDir = join(root, 'docs/manual/partners');
function walkMd(d: string): string[] {
  return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walkMd(join(d, n)) : n.endsWith('.md') ? [join(d, n)] : []));
}
const pages = existsSync(manualDir) ? walkMd(manualDir) : [];
const text = pages.map(read).join('\n');
const body = pages.filter((f) => !/README\.md$/.test(f));
const PARTNER_PATHS = ['/manifests', '/orders', '/reports', '/pickups', '/pickups/new', '/price-list', '/statements', '/referrers', '/users', '/account'];
const STAFF_PATHS = ['/partners', '/partners/manifests', '/partners/pickups', '/partners/referrers', '/partners/settings'];
const STAFF_PERMS = ['partners.manifest.receive', 'partners.pickup.manage', 'partners.partner.read', 'partners.referrer.map', 'partners.partner.manage'];
const PARTNER_PERMS = ['partners.manifest.submit', 'partners.pickup.request', 'partners.order.read', 'partners.report.read', 'partners.statement.read', 'partners.partner_user.manage'];

describe('C13 T25 manual pages (docs/manual/partners)', () => {
  it('exists with a README index and enough pages for both roles', () => {
    expect(existsSync(manualDir), `missing ${manualDir}`).toBe(true);
    expect(existsSync(join(manualDir, 'README.md')), 'missing README.md index').toBe(true);
    expect(body.length, 'expected partner pages and staff pages besides README').toBeGreaterThanOrEqual(4);
  });
  it('README links every other page; no dead relative links', () => {
    const readme = read(join(manualDir, 'README.md'));
    for (const p of body) {
      const rel = p.slice(manualDir.length + 1).replace(/\\/g, '/');
      expect(readme, `README does not link ${rel}`).toContain(rel);
    }
    for (const p of pages)
      for (const m of read(p).matchAll(/!?\]\(((?!https?:|#|mailto:)[^)\s#]+)(?:#[^)]*)?\)/g)) expect(existsSync(join(dirname(p), m[1]!)), `${p}: dead link ${m[1]}`).toBe(true);
  });
  it('each page: H1, >= 2 sections, non-trivial; screenshots have alt text and say synthetic data', () => {
    expect(body.length).toBeGreaterThan(0);
    for (const p of body) {
      const t = read(p);
      expect(t.length, `${p}: too short`).toBeGreaterThan(400);
      expect(t, `${p}: no H1`).toMatch(/^#\s+\S/m);
      expect((t.match(/^##\s+\S/gm) ?? []).length, `${p}: needs >= 2 sections`).toBeGreaterThanOrEqual(2);
      if (/!\[/.test(t)) expect(t, `${p}: screenshots must say synthetic data`).toMatch(/synthetic/i);
      for (const m of t.matchAll(/!\[([^\]]*)\]/g)) expect(m[1]!.trim().length, `${p}: empty alt text`).toBeGreaterThan(5);
    }
  });
  it('covers every partner screen address (partner role)', () => {
    for (const r of PARTNER_PATHS) expect(text, `manual does not mention \`${r}\``).toContain('`' + r + '`');
    for (const p of PARTNER_PERMS) expect(text, `manual does not name permission ${p}`).toContain(p);
  });
  it('covers every staff screen address and permission (staff role)', () => {
    for (const r of STAFF_PATHS) expect(text, `manual does not mention \`${r}\``).toContain('`' + r + '`');
    for (const p of STAFF_PERMS) expect(text, `manual does not name permission ${p}`).toContain(p);
  });
  it('flags the consent / attestation risk for the lab (06-PLAN R6: "flag in manual")', () => {
    expect(text).toMatch(/consent/i);
    expect(text).toMatch(/attest/i);
  });
  it('synthetic data only: no real-looking numbers, e-mail domains or secrets', () => {
    expect(text.length, 'no manual text').toBeGreaterThan(0);
    expect(text).not.toMatch(/\b\d{10,}\b/);
    expect(text).not.toMatch(/[\w.+-]+@(?!example\.(com|org|test))[\w-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/(password|secret|api[_-]?key|token)\s*[:=]\s*\S+/i);
  });
});
