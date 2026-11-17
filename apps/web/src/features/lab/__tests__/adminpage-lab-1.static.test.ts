// ADMINPAGE-LAB-1 static guards (node env): files, route rows, nav entries, strings, kit-only styling, no stub, no invented operation, no registry change, notes.
// LD-250 (no stub page), LD-255 (founder: the administrator reaches every feature), T0D-UI-R07 (no raw colour / px radius / inline style), CR-C0-T0D-NAV-COMPLETE-1.1.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { t } from '../../../core/i18n/messages.ts';
import { scanSource } from '../../frontdesk/__tests__/rs-c4.signature';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const BASE = '0a54fee0f'; // tree before ADMINPAGE-LAB-1 (git history is the "unchanged" reference)
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (n === '__tests__' ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)])) : []);

const PAGES = [
  // T0D-ELABMENU-1 (LD-340): lab.nav.worklists now reads with the ElabAssist name "Pathology Result" (was "Worklists")
  { name: 'Pathology Result', seg: 'worklists', path: '/lab/worklists', routeId: 'staff.lab.worklists', permission: 'lab.worklist.read', navId: 'lab.worklists', label: 'lab.nav.worklists', order: 4, helpKey: 'lab.worklists', op: '/v1/catalog/departments' },
  { name: 'Critical values', seg: 'critical-values', path: '/lab/critical-values', routeId: 'staff.lab.critical_values', permission: 'lab.critical_value.read', navId: 'lab.critical_values', label: 'lab.nav.critical_values', order: 8, helpKey: 'lab.critical_values', op: '/v1/lab/critical-values' },
] as const;
const ALLOWED_OPS = ['/v1/catalog/departments', '/v1/lab/worklist-items', '/v1/lab/critical-values'];
const pageDir = (seg: string) => join(WEB, 'src', 'app', '(staff)', 'lab', seg);

// Sources this task adds: the two page directories + every file under apps/web/src/features/lab that did not exist at BASE (tests excluded).
const added = (): string[] => {
  const tracked = git('diff', '--name-only', '--diff-filter=A', BASE, '--', 'apps/web/src/features/lab').split('\n');
  const untracked = git('ls-files', '-o', '--exclude-standard', '--', 'apps/web/src/features/lab').split('\n');
  return [...tracked, ...untracked].filter(Boolean).filter((f) => !/__tests__|\.(test|spec)\.|\.md$/.test(f)).map((f) => join(ROOT, f));
};
const sources = () => [...PAGES.flatMap((p) => walk(pageDir(p.seg))), ...added()].filter((f) => /\.(tsx?|css)$/.test(f) && existsSync(f));

describe.each(PAGES)('$name page files (LD-250: a real page, never a stub)', (p) => {
  it('page.tsx exists, is a server component gated on the route permission, with loading.tsx and error.tsx like its siblings', () => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(pageDir(p.seg), f)), `app/(staff)/lab/${p.seg}/${f}`).toBe(true);
    const page = read(join(pageDir(p.seg), 'page.tsx'));
    expect(page).not.toMatch(/^\s*['"]use client['"]/m);
    expect(page).toContain(p.permission);
    expect(read(join(pageDir(p.seg), 'error.tsx'))).toMatch(/^\s*['"]use client['"]/m);
  });

  it('asks for help through the screen help key (help file already exists) and the kit PageHeader', () => {
    const text = sources().map(read).join('\n');
    expect(text).toContain(`helpKey="${p.helpKey}"`);
    expect(text).toMatch(/@lims\/ui\/components\/PageHeader/);
    expect(existsSync(join(WEB, 'src', 'features', 'lab', 'help', `${p.helpKey.replace('lab.', '')}.md`))).toBe(true);
  });

  it('the dynamic [department_id] / [critical_event_id] sibling pages are not replaced: the new page.tsx sits beside them', () => {
    expect(existsSync(join(pageDir(p.seg), 'page.tsx'))).toBe(true);
    if (p.seg === 'worklists') expect(existsSync(join(pageDir('worklists'), '[department_id]', 'page.tsx'))).toBe(true);
  });
});

describe('both pages together: sources, operations, styling', () => {
  it('new feature components exist under features/lab (no logic inside page.tsx only) and carry no stub / placeholder / TODO text', () => {
    const files = added().filter((f) => /\.tsx$/.test(f));
    expect(files.length, 'new .tsx component files under features/lab').toBeGreaterThan(0);
    expect(sources().map(read).join('\n')).not.toMatch(/lorem|placeholder page|coming soon|not implemented|TODO|FIXME|stub/i);
  });

  it('calls only existing contract operations: every /v1 path in the sources is one of departments, worklist-items, critical-values; each page uses its own; the code cites LD-255', () => {
    const text = sources().map(read).join('\n');
    const paths = [...text.matchAll(/['"`](\/v1\/[A-Za-z0-9_\-./${}[\]]*)/g)].map((m) => m[1]!.replace(/\/+$/, '').split('?')[0]!);
    expect(paths.length).toBeGreaterThan(0);
    expect([...new Set(paths)].filter((x) => !ALLOWED_OPS.includes(x))).toEqual([]);
    for (const p of PAGES) expect(paths, p.op).toContain(p.op);
    expect(text, 'code comment cites the lead decision').toMatch(/LD-255/);
    expect(text, 'read-only pages: no write call').not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  });

  it('no hex / rgb / hsl colour, no px border-radius, no inline style object in the page or feature sources (T0D-UI-R07)', () => {
    const hits = sources().flatMap((f) => scanSource(f, read(f)));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });

  it('no raw table-less layout hacks: no raw <button>/<input>/<select> element (controls come from @lims/ui/components so target size and focus ring come from the kit)', () => {
    const tsx = sources().filter((f) => f.endsWith('.tsx')).map(read).join('\n');
    expect(tsx).not.toMatch(/<(input|textarea|button)[\s>]/);
  });
});

describe('route rows, navigation entries, strings', () => {
  const routes = (parse(readFileSync(join(ROOT, 'contracts', 'routes.yaml'), 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string; owner?: string }[] }).routes;

  it.each(PAGES)('contracts/routes.yaml has ONE non-parameterised staff_web row for $path: id $routeId, owner C5, permission $permission; the parametrised rows stay', (p) => {
    const rows = routes.filter((r) => r.path === p.path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: p.routeId, origin: 'staff_web', owner: 'C5', permission: p.permission });
    expect(routes.filter((r) => r.id === p.routeId)).toHaveLength(1);
    expect(routes.some((r) => r.id === 'staff.lab.worklist' && r.path === '/lab/worklists/{department_id}')).toBe(true);
    expect(routes.some((r) => r.id === 'staff.lab.critical_value' && r.path === '/lab/critical-values/{critical_event_id}')).toBe(true);
  });

  it('only those two rows were added to routes.yaml', () => {
    const was = (parse(git('show', `${BASE}:contracts/routes.yaml`)) as { routes: { id: string }[] }).routes.map((r) => r.id);
    const now = routes.map((r) => r.id);
    expect(was.filter((i) => !now.includes(i))).toEqual([]);
    expect(now.filter((i) => !was.includes(i)).sort()).toEqual(['staff.lab.critical_values', 'staff.lab.worklists']);
  });

  it.each(PAGES)('lab nav manifest entry $navId: label key $label resolves to the spec wording "$name", group laboratory, order $order, section daily work', async (p) => {
    const m = (await import('../nav.manifest.ts')).navManifest;
    const e = m.entries.find((x) => x.routeId === p.routeId);
    expect(e, `entry for ${p.routeId}`).toBeTruthy();
    expect(e).toMatchObject({ id: p.navId, label: p.label, permission: p.permission, group: 'laboratory', order: p.order, section: 'core.nav.section.daily_work' });
    expect(t(e!.label)).toBe(p.name);
    expect(m.entries.filter((x) => x.routeId === p.routeId)).toHaveLength(1);
  });

  it('messages.ts has no duplicate key', () => {
    const keys = [...read(join(WEB, 'src', 'core', 'i18n', 'messages.ts')).matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1]!);
    expect(new Set(keys).size, 'duplicate message keys').toBe(keys.length);
  });
});

describe('no registry or contract change (LD-255: no new permission, no invented operation)', () => {
  it('contracts/permissions.yaml and contracts/openapi/* are byte-identical to the tree before this task', () => {
    expect(git('diff', '--name-only', BASE, '--', 'contracts/permissions.yaml', 'contracts/openapi').trim()).toBe('');
  });
});

describe('task notes (CR answer and gaps)', () => {
  it('.orchestra/notes/ADMINPAGE-LAB-1-impl.md answers CR T0D-NAV-COMPLETE-1.1 for both pages, and lists the spec fields the operations do not carry as gaps', () => {
    const p = join(ROOT, '.orchestra', 'notes', 'ADMINPAGE-LAB-1-impl.md');
    expect(existsSync(p), p).toBe(true);
    const text = read(p);
    expect(text).toContain('T0D-NAV-COMPLETE-1.1');
    expect(text).toContain('/lab/worklists');
    expect(text).toContain('/lab/critical-values');
    expect(text).toMatch(/gap/i);
    for (const re of [/counts?/i, /reg(istration)? no/i, /patient/i, /notifications? count/i]) expect(text, `gap ${re}`).toMatch(re);
  });
});
