// ADMINPAGE-FD-1 static guards (node env): files, route row, nav label, help, kit-only styling, no stub, no invented operation, no registry change.
// LD-250 (no stub page), LD-255 (founder: discount settings reachable by the administrator), T0D-UI-R07 (no raw colour / px radius / inline style).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { t } from '../../../core/i18n/messages.ts';
import { scanSource } from './rs-c4.signature';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const BASE = '93bfe99f5'; // tree before ADMINPAGE-FD-1 (git history is the "unchanged" reference)
const PAGE_DIR = join(WEB, 'src', 'app', '(staff)', 'frontdesk', 'settings');
const FEATURE_DIR = join(WEB, 'src', 'features', 'frontdesk', 'settings');
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (n === '__tests__' ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)])) : []);
const sources = () => [...walk(PAGE_DIR), ...walk(FEATURE_DIR)].filter((f) => /\.(tsx?|css)$/.test(f) && !/\.(test|spec)\./.test(f));
const gitShow = (path: string) => execFileSync('git', ['show', `${BASE}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
const FIELDS = ['discount_self_limit_bp', 'discount_self_limit_paisa', 'discount_absolute_max_bp', 'require_referrer', 'consent_text_version', 'registration_sms_enabled', 'label_autoprint', 'buyer_pan_pattern', 'patient_search_min_chars'];

describe('page files (LD-250: a real page, never a stub)', () => {
  it('page.tsx exists, is a server component gated on frontdesk.settings.manage, with loading.tsx and error.tsx like its siblings', () => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(PAGE_DIR, f)), `app/(staff)/frontdesk/settings/${f}`).toBe(true);
    const page = read(join(PAGE_DIR, 'page.tsx'));
    expect(page).not.toMatch(/^\s*['"]use client['"]/m);
    expect(page).toContain('frontdesk.settings.manage');
    expect(read(join(PAGE_DIR, 'error.tsx'))).toMatch(/^\s*['"]use client['"]/m);
  });

  it('the feature code lives under features/frontdesk/settings/ (existing frontdesk server/forms/hooks files stay byte-identical: see the baseline test)', () => {
    expect(walk(FEATURE_DIR).filter((f) => /\.tsx$/.test(f)).length).toBeGreaterThan(0);
  });

  it('no stub / placeholder / lorem / TODO text, and every one of the 9 F24 fields is wired (field name present in the feature sources)', () => {
    const text = sources().map(read).join('\n');
    expect(text).not.toMatch(/lorem|placeholder page|coming soon|not implemented|TODO|FIXME|stub/i);
    for (const f of FIELDS) expect(text, `field ${f} not wired`).toContain(f);
  });

  it('calls only the real operation: every /v1 path in the sources is /v1/frontdesk/settings, uses PUT with If-Match, and cites LD-255', () => {
    const files = sources();
    const text = files.map(read).join('\n');
    const paths = [...text.matchAll(/['"`](\/v1\/[A-Za-z0-9_\-./${}[\]]*)/g)].map((m) => m[1]!.replace(/\/+$/, ''));
    expect(paths.length).toBeGreaterThan(0);
    expect([...new Set(paths)]).toEqual(['/v1/frontdesk/settings']);
    expect(text).toMatch(/PUT/);
    expect(text).toMatch(/if-match/i);
    expect(text, 'code comment cites the lead decision').toMatch(/LD-255/);
  });

  it('the page asks for help through the screen help key and the PageHeader of the kit', () => {
    const text = sources().map(read).join('\n');
    expect(text).toContain('helpKey="frontdesk.settings"');
    expect(text).toMatch(/@lims\/ui\/components\/PageHeader/);
  });
});

describe('shared kit and tokens only (T0D-UI-R07, 10-DESIGN-SYSTEM s7/s8)', () => {
  it('no hex / rgb / hsl colour, no px border-radius, no inline style object in the page or feature sources', () => {
    const hits = sources().flatMap((f) => scanSource(f, read(f)));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });

  it('form controls come from @lims/ui/components (no raw input, select, textarea or button element) so the 24 px target size and focus ring come from the kit', () => {
    const tsx = sources().filter((f) => f.endsWith('.tsx')).map(read).join('\n');
    expect(tsx).toMatch(/from ['"]@lims\/ui\/components\/(TextField|IntegerField|MoneyField|Checkbox|Form|Button)/);
    expect(tsx).not.toMatch(/<(input|select|textarea|button)[\s>]/);
    expect(tsx).toMatch(/@lims\/ui\/components\/MoneyField/); // NPR is converted the way the other money fields of the app are
  });
});

describe('route row, navigation entry, strings and help', () => {
  const routes = (parse(readFileSync(join(ROOT, 'contracts', 'routes.yaml'), 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string; owner?: string }[] }).routes;

  it('contracts/routes.yaml has ONE non-parameterised staff_web row for /frontdesk/settings: owner C4, permission frontdesk.settings.manage', () => {
    const rows = routes.filter((r) => r.path === '/frontdesk/settings');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'staff.frontdesk.settings', origin: 'staff_web', owner: 'C4', permission: 'frontdesk.settings.manage' });
    expect(routes.filter((r) => r.id === 'staff.frontdesk.settings')).toHaveLength(1);
  });

  it('no new permission and no registry change: contracts/permissions.yaml is byte-identical to the tree before this task, and the administrator role still holds the permission', () => {
    const now = read(join(ROOT, 'contracts', 'permissions.yaml'));
    // LD-431: main-landed tasks may ADD permissions after the frozen BASE; every BASE line must still be present.
    // A list that main extended changes its last item's terminator (`x]` becomes `x,`), so only a trailing `]` or `,` is ignored.
    const norm = (l: string) => l.replace(/[\],](\s*(#.*)?)$/, '$1');
    const nowLines = new Set(now.split('\n').map(norm));
    for (const line of gitShow('contracts/permissions.yaml').split('\n').filter((l) => l.trim() !== '')) {
      expect(nowLines.has(norm(line)), `BASE line missing from contracts/permissions.yaml: ${line}`).toBe(true);
    }
    expect(now).toMatch(/code: frontdesk\.settings\.manage,[^\n]*tenant_admin/);
  });

  it("the nav entry label resolves to the spec label 'Front desk settings' (strings live in core/i18n/messages.ts)", async () => {
    const m = (await import('../nav.manifest.ts')).navManifest;
    const e = m.entries.find((x) => x.routeId === 'staff.frontdesk.settings');
    expect(e, 'entry for staff.frontdesk.settings').toBeTruthy();
    expect(e).toMatchObject({ permission: 'frontdesk.settings.manage', group: 'front_desk', order: 40 });
    expect(t(e!.label)).toBe('Front desk settings');
    const messages = read(join(WEB, 'src', 'core', 'i18n', 'messages.ts'));
    const keys = [...messages.matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1]!);
    expect(new Set(keys).size, 'duplicate message keys').toBe(keys.length);
  });

  it('help/settings.md exists with Purpose, Fields and Shortcuts headings, names every field and the 409 reload behaviour, and states no IRD claim', () => {
    const p = join(WEB, 'src', 'features', 'frontdesk', 'help', 'settings.md');
    expect(existsSync(p), 'features/frontdesk/help/settings.md').toBe(true);
    const text = read(p);
    expect(text.length).toBeGreaterThan(300);
    expect(text).toMatch(/^#\s+\S/m);
    for (const h of ['Purpose', 'Fields', 'Shortcuts']) expect(text, h).toMatch(new RegExp(`^#{2,3}\\s+.*${h}`, 'im'));
    for (const re of [/self-limit/i, /absolute max/i, /referrer/i, /consent text version/i, /sms/i, /label/i, /pan pattern/i, /search min/i]) expect(text).toMatch(re);
    expect(text).toMatch(/reload/i);
    expect(text).not.toMatch(/IRD[ -](approved|certified|compliant)|approved by IRD|guarantee/i);
  });
});

describe('task notes (CR answer and gaps)', () => {
  it('.orchestra/notes/ADMINPAGE-FD-1-impl.md answers CR T0D-NAV-COMPLETE-1.1 for /frontdesk/settings and lists spec fields the operation does not carry (or says there are none)', () => {
    const p = join(ROOT, '.orchestra', 'notes', 'ADMINPAGE-FD-1-impl.md');
    expect(existsSync(p), p).toBe(true);
    const text = read(p);
    expect(text).toContain('T0D-NAV-COMPLETE-1.1');
    expect(text).toContain('/frontdesk/settings');
    expect(text).toMatch(/gap/i);
  });
});
