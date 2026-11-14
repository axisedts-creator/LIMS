// C16.T-DOC1 — manual pages docs/manual/engagement/**, a help file for every helpKey, patient page "How the app protects your reports".
// Plan row T-DOC1: "production build passes help check (C0-UI 7)"; tests: "link checker". Spec: 04-UI-UX §8 (help keys + manual mirror + patient page linked from A6),
// C0 04-UI-UX §7 HelpPanel (src/features/<m>/help/<helpKey>.ts = { title, sections:{heading,body}[], shortcuts?:{keys,action}[], links?:{routeId,label}[] }),
// 07-SECURITY §2 (what the app really does: secure storage, screenshot protection, no push, no pinning in v1, system browser for payments).
// LD-28 (2026-11-07, A33-5 app legal links): both apps show "Privacy policy" and "Terms of use" opened in the system browser; URLs come from platform
//   config legal.privacy_url / legal.terms_url (never hard-coded in docs).
// LD-140: help files are plain data -> no hex colours, pixel sizes or inline style objects.
// ASSUMED (dispute if wrong): help file name = full helpKey ("engagement.bookings.ts", same as C13/C7); manual has README.md + one or more pages that name every helpKey
//   verbatim; the patient page is whichever .md under docs/manual/engagement has the H1 "How the app protects your reports" (file name free).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');
const feat = join(root, 'apps/web/src/features/engagement');
const helpDir = join(feat, 'help');
const manualDir = join(root, 'docs/manual/engagement');

function walk(d: string, keep: (n: string) => boolean): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === '__tests__' || n === 'help' || n === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p, keep) : keep(n) ? [p] : [];
  });
}
const allFiles = (d: string): string[] =>
  existsSync(d) ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? allFiles(join(d, n)) : [join(d, n)])) : [];

// ---- help keys: the 12 in 04-UI-UX §8 (verbatim) UNION every literal helpKey the engagement staff UI passes to PageHeader
const SPEC_KEYS = ['engagement.bookings', 'engagement.booking_detail', 'engagement.booking_new', 'engagement.slots', 'engagement.bookable', 'engagement.queue',
  'engagement.queue_setup', 'engagement.app_access', 'engagement.reminders', 'engagement.memberships', 'engagement.enquiries', 'engagement.settings'];
const srcFiles = walk(feat, (n) => /\.tsx?$/.test(n) && !/\.test\./.test(n));
const literalKeys = [...new Set(srcFiles.flatMap((f) => [...read(f).matchAll(/helpKey=\{?["'`]([a-z_.]+)["'`]/g)].map((m) => m[1]!)))].sort();
const keys = [...new Set([...SPEC_KEYS, ...literalKeys])].sort();

type Help = { title: string; sections: { heading: string; body: string }[]; shortcuts?: { keys: string; action: string }[]; links?: { routeId: string; label: string }[] };
const load = async (k: string): Promise<Help> => (await import(/* @vite-ignore */ pathToFileURL(join(helpDir, `${k}.ts`)).href)).default;
const routeIds = new Set([...read(join(root, 'contracts/routes.yaml')).matchAll(/\bid:\s*([a-z][\w.]*)/g)].map((m) => m[1]!));
const helpFiles = existsSync(helpDir) ? readdirSync(helpDir).filter((n) => /\.tsx?$/.test(n)) : [];

describe('T-DOC1 help: every helpKey has a help file (apps/web/src/features/engagement/help/<helpKey>.ts)', () => {
  it('discovers the keys (non-vacuous): all 12 spec keys, and every literal helpKey in the UI is a spec key', () => {
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(literalKeys.length, 'engagement UI should already pass helpKeys to PageHeader').toBeGreaterThanOrEqual(5);
    for (const k of literalKeys) expect(SPEC_KEYS, `PageHeader helpKey ${k} is not in 04-UI-UX §8`).toContain(k);
  });
  it.each(keys)('%s has a help file with title and >= 2 sections', async (k) => {
    expect(existsSync(join(helpDir, `${k}.ts`)), `missing apps/web/src/features/engagement/help/${k}.ts`).toBe(true);
    const h = await load(k);
    expect(typeof h.title, `${k}: title`).toBe('string');
    expect(h.title.trim().length).toBeGreaterThan(2);
    expect(h.sections.length, `${k}: needs >= 2 sections`).toBeGreaterThanOrEqual(2);
    for (const s of h.sections) {
      expect(s.heading.trim().length, `${k}: empty heading`).toBeGreaterThan(1);
      expect(s.body.trim().length, `${k}/${s.heading}: body too short`).toBeGreaterThan(40);
      expect(s.body, `${k}/${s.heading}: markup/HTML in plain-data help`).not.toMatch(/<[a-z][^>]*>/i);
    }
    for (const sc of h.shortcuts ?? []) {
      expect(sc.keys.trim().length).toBeGreaterThan(0);
      expect(sc.action.trim().length).toBeGreaterThan(2);
    }
    for (const l of h.links ?? []) {
      expect(routeIds.has(l.routeId), `${k}: unknown routeId ${l.routeId} (not in contracts/routes.yaml)`).toBe(true);
      expect(l.label.trim().length).toBeGreaterThan(1);
    }
  });
  it('no orphan help files (each maps to a helpKey)', () => {
    expect(helpFiles.map((n) => n.replace(/\.tsx?$/, '')).filter((k) => !keys.includes(k))).toEqual([]);
  });
  it('LD-140: no hex colours, pixel sizes or inline style objects in help files', () => {
    expect(helpFiles.length, 'no engagement help files at all').toBeGreaterThan(0);
    for (const n of helpFiles) {
      const t = read(join(helpDir, n));
      expect(t, `${n}: hex colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(t, `${n}: px value`).not.toMatch(/\b\d+px\b/);
      expect(t, `${n}: inline style`).not.toMatch(/style\s*=\s*\{\{/);
    }
  });
  it('app_access help explains the identity check, the phone binding and that a code shows the full history (04-UI-UX §8)', async () => {
    const h = await load('engagement.app_access');
    const t = h.sections.map((s) => `${s.heading}\n${s.body}`).join('\n');
    expect(t, 'identity check').toMatch(/identity|photo id/i);
    expect(t, 'phone binding').toMatch(/(works|bound|tied|linked)[^.\n]*(only )?(on|to)[^.\n]*phone|phone[^.\n]*(only|bound|tied|number)/i);
    expect(t, 'a code shows the full history').toMatch(/full history|all (of )?(the |their |earlier |past )*(orders|reports|history)|earlier reports/i);
    expect(t, 'works once').toMatch(/once|one time|single use/i);
  });
  it('help copy contains no real-looking contact data or secrets', () => {
    for (const n of helpFiles) {
      const t = read(join(helpDir, n));
      expect(t, `${n}: phone number`).not.toMatch(/\+?977[- ]?\d{8,10}|\b9[78]\d{8}\b/);
      expect(t, `${n}: email`).not.toMatch(/[\w.+-]+@(?!example\.(com|org|net)\b)[\w-]+\.\w+/);
      expect(t, `${n}: secret-like`).not.toMatch(/\b(Bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=]|password\s*[:=]|eyJ[A-Za-z0-9_-]{20,})/i);
    }
  });
});

// ---- manual: docs/manual/engagement/** ---------------------------------------------------------------------------------------------------
const pages = allFiles(manualDir).filter((f) => f.endsWith('.md'));
const body = pages.filter((f) => !/README\.md$/.test(f));
const text = pages.map(read).join('\n');
const norm = (s: string) => s.replace(/[`*]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
const ntext = norm(text);
const PATIENT_H1 = /^#\s+How the app protects your reports\s*$/im;
const patientPages = pages.filter((f) => PATIENT_H1.test(read(f)));
const slug = (h: string) => h.trim().toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

describe('T-DOC1 manual structure (docs/manual/engagement)', () => {
  it('exists with a README index and a page for the staff screens', () => {
    expect(existsSync(manualDir), `missing ${manualDir}`).toBe(true);
    expect(existsSync(join(manualDir, 'README.md')), 'missing README.md index').toBe(true);
    expect(body.length, 'expected the patient page plus staff pages besides README').toBeGreaterThanOrEqual(4);
  });
  it('each page: H1, >= 2 sections, non-trivial; no unfinished-text markers', () => {
    expect(body.length).toBeGreaterThan(0);
    for (const p of body) {
      const t = read(p);
      expect(t.length, `${p}: too short`).toBeGreaterThan(400);
      expect(t, `${p}: no H1`).toMatch(/^#\s+\S/m);
      expect((t.match(/^##\s+\S/gm) ?? []).length, `${p}: needs >= 2 sections`).toBeGreaterThanOrEqual(2);
      expect(t, `${p}: unfinished marker`).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum|XXX)\b/i);
    }
  });
  it('mirrors help: every helpKey is named verbatim in the manual', () => {
    for (const k of SPEC_KEYS) expect(ntext, `manual never names helpKey ${k}`).toContain(k);
  });
  it('covers the staff routes from routes.yaml for the engagement screens', () => {
    const paths = [...read(join(root, 'contracts/routes.yaml')).matchAll(/\bpath:\s*['"]?(\/engagement[^\s'",}]*)/g)].map((m) => m[1]!);
    expect(paths.length, 'routes.yaml has no /engagement paths').toBeGreaterThan(0);
    const missing = [...new Set(paths)].filter((p) => !ntext.includes(p));
    expect(missing, 'manual does not mention these engagement routes').toEqual([]);
  });
});

describe('T-DOC1 link checker', () => {
  it('README links every other manual page', () => {
    const readme = read(join(manualDir, 'README.md'));
    for (const p of body) {
      const rel = p.slice(manualDir.length + 1).replace(/\\/g, '/');
      expect(readme, `README does not link ${rel}`).toContain(rel);
    }
  });
  it('every relative link resolves to an existing file inside docs/manual and every #anchor exists', () => {
    const headings = (f: string) => new Set([...read(f).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => slug(m[1]!)));
    let n = 0;
    for (const p of pages)
      for (const m of read(p).matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const href = m[1]!;
        if (/^(https?:|mailto:|tel:)/i.test(href)) continue;
        n++;
        const [file, anchor] = href.split('#');
        const target = file ? resolve(dirname(p), file) : p;
        expect(target.startsWith(resolve(root, 'docs')), `${p}: link escapes docs/ (${href})`).toBe(true);
        expect(existsSync(target), `${p}: dead link ${href}`).toBe(true);
        if (anchor && target.endsWith('.md')) expect(headings(target).has(anchor.toLowerCase()), `${p}: missing anchor #${anchor} in ${target}`).toBe(true);
      }
    expect(n, 'no relative links at all: README must link its pages').toBeGreaterThan(0);
  });
  it('images are local PNGs inside the manual, exist, and have alt text; screenshots say synthetic data', () => {
    for (const p of pages) {
      const t = read(p);
      const imgs = [...t.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)];
      if (imgs.length) expect(t, `${p}: screenshots must say synthetic data`).toMatch(/synthetic/i);
      for (const [, alt, src] of imgs) {
        expect(src, `${p}: remote image`).not.toMatch(/^[a-z]+:\/\//i);
        const f = resolve(dirname(p), src!);
        expect(f.startsWith(manualDir), `${p}: image escapes the manual folder`).toBe(true);
        expect(existsSync(f), `${p}: missing image ${src}`).toBe(true);
        expect(readFileSync(f).subarray(0, 8).toString('hex'), `${src} is not a PNG`).toBe('89504e470d0a1a0a');
        expect(alt!.trim().length, `${p}: empty alt text`).toBeGreaterThan(5);
      }
    }
  });
  it('no external URLs except example.* / localhost (LD-28: legal URLs live in platform config, never in docs)', () => {
    expect(text.length, 'no manual text').toBeGreaterThan(0);
    const urls = [...text.matchAll(/https?:\/\/[^\s)>"'\]]+/g)].map((m) => m[0]);
    expect(urls.filter((u) => !/^https?:\/\/(localhost|[\w.-]*example\.(com|org|net))\b/.test(u))).toEqual([]);
  });
  it('synthetic data only: no phone numbers, real-looking emails, secrets or tokens', () => {
    expect(text.length, 'no manual text').toBeGreaterThan(0);
    expect(text).not.toMatch(/\+?977[- ]?\d{8,10}|\b9[78]\d{8}\b/);
    expect(text).not.toMatch(/[\w.+-]+@(?!example\.(com|org|net)\b)[\w-]+\.\w+/);
    expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{20,}|\beyJ[A-Za-z0-9_-]{20,}/);
    expect(text).not.toMatch(/\/r\/[A-Za-z0-9_-]{22,}/);
    expect(text).not.toMatch(/\b[0-9A-Z]{5}-[0-9A-Z]{5}\b(?<!XXXXX-XXXXX)/); // a real-looking app code; use XXXXX-XXXXX in examples
  });
});

describe('T-DOC1 patient page "How the app protects your reports" (04-UI-UX §8, linked from A6)', () => {
  const page = () => norm(read(patientPages[0]!));
  const raw = () => read(patientPages[0]!);
  it('exists exactly once and is linked from the README', () => {
    expect(patientPages.length, 'need exactly one page with H1 "How the app protects your reports"').toBe(1);
    expect(read(join(manualDir, 'README.md'))).toContain(patientPages[0]!.slice(manualDir.length + 1).replace(/\\/g, '/'));
    expect(raw().length).toBeGreaterThan(900);
    expect((raw().match(/^##\s+\S/gm) ?? []).length, 'needs several short sections').toBeGreaterThanOrEqual(3);
  });
  it('explains in plain words what protects the reports (07-SECURITY §2, REQ-SEC-102/103/106/109)', () => {
    const t = page();
    expect(t, 'secure storage of the sign-in').toMatch(/secure (storage|store)|keychain|keystore|protected storage/i);
    expect(t, 'screenshot / recents protection').toMatch(/screenshot/i);
    expect(t, 'a code works once and only on the phone number it was issued for').toMatch(/once/i);
    expect(t).toMatch(/phone number|your phone/i);
    expect(t, 'only profiles you linked are shown').toMatch(/linked|profile/i);
    expect(t, 'removing a profile').toMatch(/remove/i);
    expect(t, 'reports and payments open outside the app / system browser').toMatch(/system browser|browser/i);
    expect(t, 'what to do if the phone is lost').toMatch(/lost|stolen|sign out|ask the lab/i);
    expect(t, 'no tracking or advertising').toMatch(/(no|not|never|does not|doesn't)[^.]*(analytics|tracking|advert)/i);
  });
  it('says the screenshot trade-off truthfully: reports can be saved as PDF after a warning (07-SECURITY §2 Screens)', () => {
    expect(page()).toMatch(/PDF/);
    expect(page()).toMatch(/warning|warn/i);
  });
  it('LD-28: names "Privacy policy" and "Terms of use", opened in the system browser, URLs not hard-coded', () => {
    const t = page();
    expect(t).toContain('Privacy policy');
    expect(t).toContain('Terms of use');
    expect(t).toMatch(/system browser/i);
    expect(raw(), 'no URLs on the patient page (they come from platform config)').not.toMatch(/https?:\/\//i);
  });
  it('does not over-promise or claim what v1 does not do (no pinning, no push, no guarantees)', () => {
    const lines = raw().split(/\r?\n/);
    expect(raw()).not.toMatch(/\b(100% secure|unhackable|completely safe|guarantee[sd]?|military[- ]grade|cannot be hacked|totally secure)\b/i);
    for (const l of lines.filter((x) => /pinn/i.test(x))) expect(l, `claims certificate pinning (not in v1, D-PIN): ${l}`).toMatch(/\b(not|no|never|don't|does not)\b/i);
    for (const l of lines.filter((x) => /\bpush\b/i.test(x))) expect(l, `claims push notifications (none until B11): ${l}`).toMatch(/\b(not|no|never|don't|does not|doesn't|without)\b/i);
    expect(raw(), 'must not say the lab or app can read results aloud / diagnose').not.toMatch(/\bdiagnos(e|es|is)\b[^.\n]*(app|we)\b/i);
  });
  it('contains no staff-only wording (permissions, table names, internal ids)', () => {
    expect(raw()).not.toMatch(/\bengagement\.[a-z_.]+|\b[a-z_]+\.[a-z_]+\.(read|manage|issue|write)\b|\boperationId\b|\btenant_id\b|\baccount_patient_links\b/);
  });
});

describe('T-DOC1 LD-28 legal links in the staff manual', () => {
  it('names platform config keys legal.privacy_url and legal.terms_url and the optional tenant privacy URL', () => {
    expect(ntext).toContain('legal.privacy_url');
    expect(ntext).toContain('legal.terms_url');
    expect(ntext, 'required in production builds').toMatch(/required[^.]*production|production[^.]*required/i);
    expect(ntext, 'optional tenant privacy URL shown under the lab name').toMatch(/tenant[^.]*privacy[^.]*(URL|link)|privacy[^.]*(URL|link)[^.]*(lab|tenant)/i);
  });
  it('engagement settings and app_access manual pages exist and name their permissions/routes', () => {
    expect(ntext).toMatch(/engagement\.link\.issue/); // W8 issue code permission (TRD / 07-SECURITY §6.5)
    expect(ntext, 'aal2 / MFA needed to save settings (W12)').toMatch(/aal2|MFA|multi-factor|two-step/i);
    expect(ntext, 'consent text version (W12)').toMatch(/consent text/i);
  });
});
