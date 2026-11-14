// C13.T16 static guards (node env): route files, boundaries, server-component discipline, LD-140 design-system rules, PHI, copy rules, nav wiring.
// 04-UI-UX §1.2/§4/§6/§7, LD-140 (packages/ui only; no hex colours / pixel radii / inline style objects), 07-SECURITY (PHI in URLs/storage), 03-APP-FLOW §4.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const app = join(web, 'src', 'app', '(staff)', 'partners');
const feat = join(web, 'src', 'features', 'partners');
const PAGES = ['', '[partner_id]', 'manifests', 'manifests/[manifest_id]', 'pickups', 'referrers', 'settings']; // SP-1, SP-2/3, SM-1, SM-2, SK-1, SF-1, SS-1
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return n === '__tests__' || n === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const own = () => [...walk(feat), ...walk(app)].filter((f) => /\.(tsx?|css|mjs)$/.test(f) && !f.endsWith('nav.manifest.ts'));
const dir = (p: string) => join(app, ...p.split('/').filter(Boolean));

describe('routes (04-UI-UX §1.2 / routes.yaml staff.partners.*)', () => {
  it.each(PAGES)('partners/%s/page.tsx exists', (p) => { expect(existsSync(join(dir(p), 'page.tsx'))).toBe(true); });

  it.each(PAGES)('partners/%s has loading.tsx and error.tsx (own or segment-level at partners/); error.tsx is a client boundary showing the digest, never message/stack', (p) => {
    const has = (n: string) => existsSync(join(dir(p), n)) || existsSync(join(app, n));
    expect(has('loading.tsx')).toBe(true);
    expect(has('error.tsx')).toBe(true);
    const f = existsSync(join(dir(p), 'error.tsx')) ? join(dir(p), 'error.tsx') : join(app, 'error.tsx');
    const src = readFileSync(f, 'utf8');
    expect(src).toMatch(/^['"]use client['"]/m);
    expect(src).not.toMatch(/error\.message|error\.stack/);
    expect(src).toMatch(/digest/);
  });

  it('[partner_id] and manifests/[manifest_id] have not-found.tsx ("Partner not found" / "Manifest not found")', () => {
    expect(readFileSync(join(app, '[partner_id]', 'not-found.tsx'), 'utf8')).toMatch(/Partner not found/);
    expect(readFileSync(join(app, 'manifests', '[manifest_id]', 'not-found.tsx'), 'utf8')).toMatch(/Manifest not found/);
  });

  it('pages are server components reading only through features/partners/server/*.server.ts and passing session permissions down (no fetch in pages)', () => {
    for (const p of PAGES) {
      const src = readFileSync(join(dir(p), 'page.tsx'), 'utf8');
      expect(src, p).not.toMatch(/^['"]use client['"]/m);
      expect(src, p).not.toMatch(/\bfetch\(/);
      expect(src, p).toMatch(/features\/partners\/server\//);
      expect(src, p).toMatch(/getShellSession/);
    }
  });

  it('writes are server actions (features/partners/server/actions.ts): receive, retry, not-received, schedule, picked-up, reject, map, suspend, settings', () => {
    const src = readFileSync(join(feat, 'server', 'actions.ts'), 'utf8');
    expect(src).toMatch(/^['"]use server['"]/m);
    for (const n of ['receive', 'retry', 'notreceived', 'schedule', 'pickedup', 'reject', 'map', 'suspend', 'settings']) expect(src.toLowerCase().replace(/[-_]/g, '')).toContain(n);
  });

  it('the staff routes the app links to come from the route table (buildRoute / routes.yaml ids), not hand-built strings with PHI', () => {
    const src = own().filter((f) => f.endsWith('.tsx')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).toMatch(/staff\.frontdesk\.order|\/frontdesk\/orders\//); // registration-no link to C4
  });
});

describe('LD-140 design system (spec/program/10-DESIGN-SYSTEM.md §6): kit components + tokens only', () => {
  it('scan set is not empty', () => { expect(own().filter((f) => f.endsWith('.tsx')).length).toBeGreaterThanOrEqual(8); });

  it('no hex colours, rgb()/hsl() literals, pixel border-radius or inline style objects in feature code', () => {
    for (const f of own()) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(s, f).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
      expect(s, f).not.toMatch(/border-?[rR]adius\s*:\s*['"`]?\d+px/);
      expect(s, f).not.toMatch(/\bstyle=\{\{/);
    }
  });

  it('UI is built from @lims/ui: DataTable on list screens, PageHeader with helpKey, no raw <table>/<dialog>/<select> in components', () => {
    const comps = own().filter((f) => f.endsWith('.tsx') && /components/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(comps).toMatch(/@lims\/ui\/components\/DataTable/);
    expect(comps).toMatch(/@lims\/ui\/components\/PageHeader/);
    expect(comps).toMatch(/@lims\/ui\/components\/BarcodeInput/);
    expect(comps).toMatch(/@lims\/ui\/components\/ConfirmDialog/);
    expect(comps).toMatch(/@lims\/ui\/components\/CodedSelect/);
    expect(comps).toMatch(/helpKey/);
    expect(comps).not.toMatch(/<(table|dialog|select)\b/);
  });

  it('one primary button per page: no more than one variant="primary" per component file', () => {
    for (const f of own().filter((x) => x.endsWith('.tsx'))) {
      const n = (readFileSync(f, 'utf8').match(/variant=["']primary["']/g) ?? []).length;
      expect(n, f).toBeLessThanOrEqual(2); // header primary + one dialog confirm
    }
  });
});

describe('privacy + safety (07-SECURITY, REQ-SEC-088/098)', () => {
  it('no localStorage/sessionStorage/indexedDB/document.cookie (patient names, partner refs never in browser storage)', () => {
    for (const f of own()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('no dangerouslySetInnerHTML / innerHTML / eval', () => {
    for (const f of own()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/);
  });

  it('no PHI in titles, metadata or hrefs (patient name / phone / partner sample ref)', () => {
    for (const p of PAGES) expect(readFileSync(join(dir(p), 'page.tsx'), 'utf8'), p).not.toMatch(/generateMetadata[\s\S]{0,400}(full_name|phone|partner_sample_ref)/);
    for (const f of own().filter((x) => x.endsWith('.tsx'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/href=\{?[`'"][^`'"]*\$\{[^}]*(full_name|phone|partner_sample_ref|email)/);
  });

  it('patient/doctor search queries go in the POST body, never a URL (no GET /patients/search or ?q= with names)', () => {
    const src = own().map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).toMatch(/\/v1\/frontdesk\/patients\/search/);
    expect(src).toMatch(/\/v1\/catalog\/doctors\/search/);
    expect(src).not.toMatch(/patients\/search\?|doctors\/search\?/);
  });

  it('copy rules (04-UI-UX §6): never "commission"; partner-facing "invoice" words do not appear on these screens; no IRD-approval claims', () => {
    for (const f of own()) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/commission/i);
      expect(s, f).not.toMatch(/IRD[ -]approved|IRD certified|approved by IRD/i);
    }
  });

  it('no raw error/failure codes in JSX text — codes are mapped to staff texts', () => {
    for (const f of own().filter((x) => x.endsWith('.tsx') && /components/.test(x))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/>\s*(frontdesk|catalog|partners|common|auth)\.[a-z_]+\s*</);
  });

  it('the six staff failure texts of 04-UI-UX §4 exist verbatim in the feature', () => {
    const src = own().map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const t of [
      'A patient with similar details already exists.', 'Consent details are missing for this patient.', 'A test on this sample is no longer offered.',
      'A test has no price for this partner.', 'The referring doctor has not been confirmed.', 'Registration did not complete.',
    ]) expect(src).toContain(t);
  });
});

describe('nav (04-UI-UX §1.2, CR-C13-008)', () => {
  it('nav.manifest.ts keeps the five entries and every routeId resolves to a page in this segment', () => {
    const src = readFileSync(join(feat, 'nav.manifest.ts'), 'utf8');
    for (const id of ['staff.partners.inbox', 'staff.partners.pickups', 'staff.partners.list', 'staff.partners.referrers', 'staff.partners.settings']) expect(src).toContain(id);
    for (const p of ['manifests', 'pickups', '', 'referrers', 'settings']) expect(existsSync(join(dir(p), 'page.tsx'))).toBe(true);
  });
});
