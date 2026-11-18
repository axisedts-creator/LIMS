// ADMINPAGE-ENG-1 static guards (node env): files, route row, nav entry + label, kit-only styling, no stub, no invented operation, no registry change.
// LD-250 (no stub page), LD-255 (founder: the administrator gets every feature), T0D-UI-R07 (no raw colour / px radius / inline style),
// C16 04-UI-UX 1.3 (nav row) and W12 (screen), contracts/openapi/engagement.yaml getEngagementSettings / updateEngagementSettings.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { t } from '../../../core/i18n/messages.ts';
import { scanSource } from '../../frontdesk/__tests__/rs-c4.signature';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const BASE = '052539369'; // tree before ADMINPAGE-ENG-1 (git history is the "unchanged" reference)
const PAGE_DIR = join(WEB, 'src', 'app', '(staff)', 'engagement', 'settings');
const FEATURE_DIR = join(WEB, 'src', 'features', 'engagement', 'settings');
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (n === '__tests__' ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)])) : []);
const sources = () => [...walk(PAGE_DIR), ...walk(FEATURE_DIR)].filter((f) => /\.(tsx?|css)$/.test(f) && !/\.(test|spec)\./.test(f));
const gitShow = (path: string) => execFileSync('git', ['show', `${BASE}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
// EngagementSettingsInput properties (contracts/openapi/engagement.yaml): all 44 are carried by the PUT body, so each must be wired.
const FIELDS = [
  'app_enabled', 'bookings_enabled', 'home_collection_enabled', 'queue_enabled', 'reminders_enabled', 'memberships_enabled', 'enquiries_enabled', 'smart_report_in_app',
  'show_partner_orders', 'auto_no_show', 'auto_follow_up_reminders', 'home_collection_centre_id', 'allowed_phone_prefixes', 'otp_daily_cap', 'min_app_version_android',
  'min_app_version_ios', 'app_gateways', 'support_phone', 'app_consent_text', 'app_consent_text_version', 'max_profiles_per_account', 'max_accounts_per_patient',
  'link_code_ttl_hours', 'dormant_after_days', 'minor_age_years', 'booking_horizon_days', 'booking_min_lead_minutes', 'booking_cancel_cutoff_minutes', 'no_show_grace_minutes',
  'max_active_bookings_per_profile', 'max_bookings_created_per_account_day', 'max_orderables_per_booking', 'booking_reminder_hours_before', 'follow_up_reminder_lead_days',
  'queue_display_history_count', 'smart_report_disclaimer_text',
];

describe('page files (LD-250: a real page, never a stub)', () => {
  it('page.tsx exists, is a server component gated on engagement.settings.manage, with loading.tsx and error.tsx like its siblings', () => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(PAGE_DIR, f)), `app/(staff)/engagement/settings/${f}`).toBe(true);
    const page = read(join(PAGE_DIR, 'page.tsx'));
    expect(page).not.toMatch(/^\s*['"]use client['"]/m);
    expect(page).toContain('engagement.settings.manage');
    expect(read(join(PAGE_DIR, 'error.tsx'))).toMatch(/^\s*['"]use client['"]/m);
  });

  it('the feature code lives under features/engagement/settings/ (the existing engagement components and server files are not the place for it)', () => {
    expect(walk(FEATURE_DIR).filter((f) => /\.tsx$/.test(f)).length).toBeGreaterThan(0);
  });

  it('no stub / placeholder / lorem / TODO text, and every one of the 36 writable operation fields is wired (field name present in the feature sources)', () => {
    const text = sources().map(read).join('\n');
    expect(text).not.toMatch(/lorem|placeholder page|coming soon|not implemented|TODO|FIXME|stub/i);
    for (const f of FIELDS) expect(text, `field ${f} not wired`).toContain(f);
  });

  it('calls only real operations: every /v1 path in the sources is /v1/engagement/settings (or the C2 centre list /v1/identity/centres), uses PUT with If-Match, and cites LD-255', () => {
    const text = sources().map(read).join('\n');
    const paths = [...text.matchAll(/['"`](\/v1\/[A-Za-z0-9_\-./${}[\]]*)/g)].map((m) => m[1]!.replace(/\/+$/, ''));
    expect(paths.length).toBeGreaterThan(0);
    expect([...new Set(paths)].filter((p) => p !== '/v1/engagement/settings' && p !== '/v1/identity/centres')).toEqual([]);
    expect(paths).toContain('/v1/engagement/settings');
    expect(text).toMatch(/PUT/);
    expect(text).toMatch(/if-match/i);
    expect(text, 'code comment cites the lead decision').toMatch(/LD-255/);
  });

  it('the page asks for help through the screen help key and the PageHeader of the kit (help/engagement.settings.ts already exists)', () => {
    const text = sources().map(read).join('\n');
    expect(text).toContain('helpKey="engagement.settings"');
    expect(text).toMatch(/@lims\/ui\/components\/PageHeader/);
    expect(existsSync(join(WEB, 'src', 'features', 'engagement', 'help', 'engagement.settings.ts'))).toBe(true);
  });
});

describe('shared kit and tokens only (T0D-UI-R07, 10-DESIGN-SYSTEM s7/s8)', () => {
  it('no hex / rgb / hsl colour, no px border-radius, no inline style object in the page or feature sources', () => {
    const hits = sources().flatMap((f) => scanSource(f, read(f)));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });

  it('form controls come from @lims/ui/components (no raw input, select, textarea or button element) so the 24 px target size and focus ring come from the kit', () => {
    const tsx = sources().filter((f) => f.endsWith('.tsx')).map(read).join('\n');
    expect(tsx).toMatch(/from ['"]@lims\/ui\/components\/(TextField|IntegerField|Checkbox|Switch|TextArea|Form|Button)/);
    expect(tsx).not.toMatch(/<(input|select|textarea|button)[\s>]/);
  });
});

describe('route row, navigation entry, strings, registries', () => {
  const routes = (parse(readFileSync(join(ROOT, 'contracts', 'routes.yaml'), 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string; owner?: string }[] }).routes;

  it('contracts/routes.yaml has ONE non-parameterised staff_web row for /engagement/settings: staff.engagement.settings, owner C16, permission engagement.settings.manage', () => {
    const rows = routes.filter((r) => r.path === '/engagement/settings');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'staff.engagement.settings', origin: 'staff_web', owner: 'C16', permission: 'engagement.settings.manage' });
    expect(routes.filter((r) => r.id === 'staff.engagement.settings')).toHaveLength(1);
  });

  it('no new permission outside the allowed families and no lost contract: base engagement codes unchanged, the settings operations still exist, and the administrator role holds the permission', () => {
    const perms = read(join(ROOT, 'contracts', 'permissions.yaml'));
    // Ruling T0D-CONTENT-1 (after T0D-ENGBOOK-1): LD-313 (a, c) puts portal content in the engagement module and allows new codes for it; LD-316, LD-321
    // and LD-322 authorise new non-engagement codes (lab.verification_policy.*, partners.sales.*, partners.ticket.*, sync.*) added by other contract tasks.
    // So the "no new code" check applies to the engagement family alone: new engagement.content.* and engagement.broadcast.* codes are allowed;
    // every engagement code that existed at BASE must still be present unchanged.
    const basePerms = gitShow('contracts/permissions.yaml');
    const engLines = (s: string) => s.split('\n').filter((l) => /code: engagement\./.test(l));
    for (const l of engLines(basePerms)) expect(perms.split('\n')).toContain(l);
    const codes = (s: string) => [...s.matchAll(/code: ([\w.]+)/g)].map((m) => m[1]!);
    const baseCodes = new Set(codes(basePerms));
    expect(codes(perms).filter((c) => !baseCodes.has(c) && c.startsWith('engagement.') && !c.startsWith('engagement.content.') && !c.startsWith('engagement.broadcast.'))).toEqual([]);
    expect(perms).toMatch(/code: engagement\.settings\.manage,[^\n]*tenant_admin/);
    const api = read(join(ROOT, 'contracts', 'openapi', 'engagement.yaml'));
    expect(api).toMatch(/operationId: getEngagementSettings/);
    expect(api).toMatch(/operationId: updateEngagementSettings/);
  });

  it("the manifest entry is engagement.settings (C16 04-UI-UX 1.3): label key engagement.nav.settings = 'Engagement settings', group engagement, order 90, phase 2, no new chord", async () => {
    const m = (await import('../nav.manifest.ts')).navManifest;
    const e = m.entries.find((x) => x.routeId === 'staff.engagement.settings');
    expect(e, 'entry for staff.engagement.settings').toBeTruthy();
    expect(e).toMatchObject({ id: 'engagement.settings', label: 'engagement.nav.settings', permission: 'engagement.settings.manage', group: 'engagement', order: 90, phase: '2' });
    expect(e!.chord, 'spec has no chord for settings').toBeUndefined();
    expect(t(e!.label)).toBe('Engagement settings');
    const messages = read(join(WEB, 'src', 'core', 'i18n', 'messages.ts'));
    const keys = [...messages.matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1]!);
    expect(new Set(keys).size, 'duplicate message keys').toBe(keys.length);
    expect(keys.filter((k) => k === 'engagement.nav.settings')).toHaveLength(1);
  });
});

describe('task notes (CR answer and gaps)', () => {
  it('.orchestra/notes/ADMINPAGE-ENG-1-impl.md answers CR T0D-NAV-COMPLETE-1.1 for /engagement/settings and lists spec fields the operation does not carry (or says there are none)', () => {
    const p = join(ROOT, '.orchestra', 'notes', 'ADMINPAGE-ENG-1-impl.md');
    expect(existsSync(p), p).toBe(true);
    const text = read(p);
    expect(text).toContain('T0D-NAV-COMPLETE-1.1');
    expect(text).toContain('/engagement/settings');
    expect(text).toMatch(/gap/i);
  });
});
