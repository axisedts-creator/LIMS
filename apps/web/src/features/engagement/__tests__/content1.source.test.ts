// T0D-CONTENT-1 — structure and guard tests (no rendering): route, page, nav entry, permission codes, catalogue text, shared renderer, upload kit, file cap.
// LD-313 (portal content, engagement module), LD-310 (blanket authority, limits), LD-353 (UI rules). Synthetic data only.
// ASSUMED names (the spec fixes the screens, not the files; dispute through the writer note if wrong):
//   route id staff.engagement.content, path /engagement/content, owner C16, permission engagement.content.read; ONE route, the five tabs are in-page (tabs, not routes)
//   page   apps/web/src/app/(staff)/engagement/content/page.tsx  -> renders PortalContentScreen, reads through features/engagement/server/*
//   screen apps/web/src/features/engagement/components/content/PortalContentScreen.tsx (named export; more files may sit next to it)
//   nav    id engagement.content, label key engagement.nav.content, group engagement, order > 90 (the free slots after Engagement settings)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const SRC = join(WEB, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);

const PAGE = join(SRC, 'app', '(staff)', 'engagement', 'content', 'page.tsx');
const COMPONENT_DIR = join(SRC, 'features', 'engagement', 'components', 'content');
const TESTS = join(SRC, 'features', 'engagement', '__tests__');
const contentFiles = () => [
  ...walk(COMPONENT_DIR),
  ...walk(join(SRC, 'features', 'engagement', 'server')).filter((f) => /content/i.test(f.split(/[\\/]/).pop()!)),
  ...walk(join(SRC, 'app', '(staff)', 'engagement', 'content')),
].filter((f) => /\.(ts|tsx)$/.test(f));
const uiFiles = () => contentFiles().filter((f) => /\.tsx$/.test(f));

const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner?: string; permission?: string }[] }).routes;
const permissionCodes = new Set((parse(read(join(ROOT, 'contracts', 'permissions.yaml'))) as { permissions: { code: string }[] }).permissions.map((p) => p.code));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const catalogue = Object.fromEntries([...messagesSrc.matchAll(/'(engagement\.content\.[a-z0-9_.]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => [m[1]!, m[2] ?? m[3]!]));

describe('T0D-CONTENT-1 route, page and navigation', () => {
  it('the page exists, renders PortalContentScreen and reads through the engagement server files', () => {
    expect(existsSync(PAGE), PAGE).toBe(true);
    const src = read(PAGE);
    expect(src).toMatch(/export default (async )?function/);
    expect(src).toContain('PortalContentScreen');
    expect(src).toMatch(/features\/engagement\/server\//);
  });
  it('routes.yaml has ONE staff_web row for /engagement/content (owner C16, an existing permission); the tabs are not routes', () => {
    const r = routes.filter((x) => x.origin === 'staff_web' && x.path === '/engagement/content');
    expect(r.length).toBe(1);
    expect(r[0]!.owner).toBe('C16');
    expect(r[0]!.permission).toBe('engagement.content.read'); // API floor of listPortalContent / listProfileImages
    expect(permissionCodes.has('engagement.content.read')).toBe(true);
    expect(routes.filter((x) => /^\/engagement\/content\//.test(x.path)), 'no per tab route').toEqual([]);
    expect(existsSync(join(SRC, 'app', '(staff)', 'engagement', 'content', 'news')), 'no per tab page folder').toBe(false);
  });
  it('no route is removed: every pre-existing engagement route is still there', () => {
    for (const p of ['/engagement/queue', '/engagement/bookings', '/engagement/reminders', '/engagement/enquiries', '/engagement/memberships', '/engagement/slots', '/engagement/bookable-items', '/engagement/queue/setup', '/engagement/settings', '/engagement/app-access/{patient_id}']) {
      expect(routes.some((x) => x.origin === 'staff_web' && x.path === p), p).toBe(true);
    }
  });
  it('the nav manifest gets ONE additive entry: group engagement, the route permission, a message key label that exists in the catalogue', async () => {
    const m = (await import(join(SRC, 'features', 'engagement', 'nav.manifest.ts'))).navManifest as { entries: { id: string; label: string; routeId: string; permission: string; group: string; order: number }[] };
    const route = routes.find((r) => r.path === '/engagement/content');
    const e = m.entries.find((x) => x.routeId === route?.id);
    expect(e, 'entry for /engagement/content').toBeTruthy();
    expect(e!.id).toBe('engagement.content');
    expect(e!.group).toBe('engagement');
    expect(e!.permission).toBe('engagement.content.read');
    expect(e!.order).toBeGreaterThan(90);
    expect(e!.label).toBe('engagement.nav.content');
    expect(messagesSrc).toContain("'engagement.nav.content'");
    expect(m.entries.length, 'the nine existing entries stay').toBe(10);
  });
  it('nothing under features/admin, features/platform, app/(auth), app/(platform) is imported by the new files', () => {
    for (const f of contentFiles()) expect(read(f), f).not.toMatch(/features\/(admin|platform)\b|\(auth\)|\(platform\)/);
  });
  it('the change stays within the 22 file cap of the brief (components + server + page + tests + nav/catalogue edits)', () => {
    const tests = walk(TESTS).filter((f) => /content1\./.test(f) || /vitest\.content1/.test(f));
    const edits = 4; // nav.manifest.ts, routes.yaml, messages.ts, nav-complete.engagement.test.ts
    expect(contentFiles().length + tests.length + edits).toBeLessThanOrEqual(22);
  });
});

describe('T0D-CONTENT-1 permission codes', () => {
  it('every engagement.* / identity.* permission string used by the new files exists in contracts/permissions.yaml (no invented code)', () => {
    const used = new Set(contentFiles().flatMap((f) => [...read(f).matchAll(/['"`]((?:engagement|identity)\.[a-z_]+\.[a-z_]+)['"`]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(permissionCodes.has(c), `${c} must be a code in contracts/permissions.yaml`).toBe(true);
  });
  it('the screens gate on the two T0C-CONTENT-1 codes', () => {
    const all = contentFiles().map(read).join('\n');
    expect(all).toContain('engagement.content.read');
    expect(all).toContain('engagement.content.manage');
  });
});

describe('T0D-CONTENT-1 message catalogue (rule 8, done_when 6)', () => {
  it('the five tab names and the visible states are catalogue values under engagement.content.*', () => {
    const values = new Set(Object.values(catalogue));
    for (const l of ['News', 'Banners', 'Offers', 'Contact Us', 'Profile Images']) expect(values.has(l), `catalogue value "${l}"`).toBe(true);
    expect(Object.keys(catalogue).length, 'engagement.content.* keys').toBeGreaterThanOrEqual(25);
  });
  it('the components take their text from the catalogue (t() imported from core/i18n/messages)', () => {
    expect(uiFiles().length).toBeGreaterThan(0);
    for (const f of uiFiles()) expect(read(f), f).toMatch(/core\/i18n\/messages/);
  });
  it('no exclamation marks and no development copy in the catalogue text of this screen', () => {
    for (const [k, v] of Object.entries(catalogue)) {
      expect(v, k).not.toMatch(/!/);
      expect(v, k).not.toMatch(/\b(TODO|FIXME|lorem|WIP|placeholder|T0D-|LD-\d)/i);
    }
  });
});

describe('T0D-CONTENT-1 safe preview (LD-313 d: no raw HTML, no second renderer)', () => {
  it('a markdown preview exists and renders only renderMarkdown output: dangerouslySetInnerHTML is never fed anything else', () => {
    const withHtml = uiFiles().filter((f) => /dangerouslySetInnerHTML/.test(read(f)));
    expect(withHtml.length, 'the live preview injects the renderer output').toBeGreaterThan(0);
    for (const f of withHtml) {
      const src = read(f);
      expect(src, f).toMatch(/renderMarkdown/);
      for (const m of src.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+)\}\}/g)) expect(m[1], `${f}: __html must be the renderer output`).toMatch(/renderMarkdown|rendered|html\b/i);
    }
  });
  it('no markdown library, no HTML rich text editor and no innerHTML assignment in the content files', () => {
    for (const f of contentFiles()) {
      const src = read(f);
      expect(src, f).not.toMatch(/from ['"](marked|markdown-it|showdown|remark[\w-]*|react-markdown|snarkdown|dompurify|sanitize-html|quill|tinymce|draft-js|slate|@tiptap\/[\w-]+)['"]/);
      expect(src, f).not.toMatch(/RichTextEditor/); // the kit editor emits HTML; portal text is the Markdown subset
      expect(src, f).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    }
  });
});

describe('T0D-CONTENT-1 upload (done_when 3, LD-313 d: no new upload route)', () => {
  it('banner and profile image upload use the kit FileUpload with uploadFile (progress and retry), image types only', () => {
    const files = uiFiles().filter((f) => /FileUpload/.test(read(f)));
    expect(files.length).toBeGreaterThan(0);
    const all = files.map(read).join('\n');
    expect(all).toMatch(/from '@lims\/ui\/components\/FileUpload'/);
    expect(all).toMatch(/uploadFile=/);
    expect(all).toMatch(/image\/png/);
    expect(all).toMatch(/image\/jpeg/);
    expect(all).not.toMatch(/application\/pdf|text\/csv|spreadsheetml/);
  });
  it('the image goes to the existing branding route; the new files add no upload route of their own', () => {
    const all = contentFiles().map(read).join('\n');
    expect(all).toContain('/v1/identity/settings/branding-assets');
    expect(all).not.toMatch(/\/v1\/engagement\/[a-z\-/{}_]*(upload|attachments?|media)/i);
    expect(all).not.toMatch(/<input[^>]*type=["']file["']/); // the kit component, not a bare input
  });
});

describe('T0D-CONTENT-1 never delete (history is kept)', () => {
  it('portal content is deactivated, never deleted: no DELETE against portal-content in the new files', () => {
    for (const f of contentFiles()) {
      const src = read(f);
      expect(src, f).not.toMatch(/portal-content[^\n]*DELETE|DELETE[^\n]*portal-content/i);
    }
  });
});
