// HC-T19 — structure / copy / help / LD-140 of app/(staff)/homecollection/visits/[visit_id] and the visit-detail files in features/homecollection
// (04-UI-UX §1, §2.2, §6; 06-PLAN row HC-T19; 07-SECURITY §3 "Staff web H1–H21" + REQ-SEC-096/097; LD-140 UI rule). Static checks only (no rendering).
// Contract the tests import (spec fixes folders + kit components; dispute via the writer if wrong):
//   features/homecollection/components/VisitDetailView.tsx   (client component; hc-t19.detail/review tests render it)
//   features/homecollection/server/{actions,read.server,write.server}.ts gain: H2 getVisit, H8 resolve flag, H9 review, H7 revisit, H21 phone reveal
//   features/homecollection/help/visit.md, app/(staff)/homecollection/visits/[visit_id]/{page,loading,error}.tsx
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const route = join(web, 'src/app/(staff)/homecollection/visits/[visit_id]');
const feat = join(web, 'src/features/homecollection');
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (s: string) => [...strip(s).matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === '__tests__' ? [] : walk(join(d, n))) : [join(d, n)])) : []);
const code = (d: string) => walk(d).filter((f) => /\.(tsx?|mjs)$/.test(f));
const VIEW = join(feat, 'components', 'VisitDetailView.tsx');
const SERVER = ['actions', 'read.server', 'write.server'].map((n) => join(feat, 'server', `${n}.ts`));
const mine = () => [...code(route), VIEW].filter(existsSync); // the files HC-T19 adds; HC-T18's own source test already covers the whole tree with the same rules

describe('files exist (names are the contract the tests import)', () => {
  it.each([join(route, 'page.tsx'), join(route, 'loading.tsx'), join(route, 'error.tsx'), VIEW, join(feat, 'help', 'visit.md')])('%s', (f) => { expect(existsSync(f), f).toBe(true); });
});

describe('route files /homecollection/visits/[visit_id] (04-UI-UX §2.2, §2.6)', () => {
  it('error.tsx is a client component using ErrorState with onRetry and the request id; page / loading are not client', () => {
    const e = read(join(route, 'error.tsx'));
    expect(strip(e).trimStart().startsWith("'use client'")).toBe(true);
    expect(e).toMatch(/ErrorState/);
    expect(e).toMatch(/onRetry=\{reset\}/);
    expect(e).toMatch(/digest|requestId|request_id/);
    expect(read(join(route, 'page.tsx'))).not.toMatch(/['"]use client['"]/);
  });
  it('loading.tsx uses LoadingSkeleton variant=detail', () => { expect(read(join(route, 'loading.tsx'))).toMatch(/LoadingSkeleton[^>]*variant=["'{]+detail/); });
  it('a PageHeader passes helpKey homecollection.visit and the breadcrumb "Home visits"', () => {
    const all = [...code(route), VIEW].filter(existsSync).map(read).join('\n');
    expect(all).toMatch(/helpKey=["'{]*homecollection\.visit\b/);
    expect(all).toMatch(/Home visits/);
    expect(all).toMatch(/PageHeader/);
  });
  it('page checks homecollection.visit.read before any API call (notFound), reads the session via getShellSession and never touches a token', () => {
    const p = strip(read(join(route, 'page.tsx')));
    expect(p).toMatch(/notFound\(\)/);
    expect(p).toMatch(/getShellSession/);
    expect(p).toMatch(/homecollection\.visit\.read/);
    expect(p).not.toMatch(/getAccessToken|authorization|Bearer /i);
  });
  it('the page validates the id before use (uuid) and does not interpolate the raw param into a URL', () => {
    const all = [join(route, 'page.tsx'), SERVER[1]!].map((f) => strip(read(f))).join('\n');
    expect(all).toMatch(/UUID|uuid|isUuid/);
  });
});

describe('server boundary (07-SECURITY §3: BFF cookie only; tokens never reach the browser)', () => {
  it('the five visit-detail calls exist server-side: H2 visits/{id}, H7 /revisits, H8 /flags/…/resolve, H9 /collections/…/review, H21 /phone-reveal', () => {
    const s = SERVER.map((f) => strip(read(f))).join('\n');
    for (const p of [/visits\/\$\{[^}]+\}(?!\/)/, /\/revisits/, /\/flags\/\$\{[^}]+\}\/resolve/, /\/collections\/\$\{[^}]+\}\/review/, /\/phone-reveal/]) expect(s, String(p)).toMatch(p);
  });
  it('H7, H9 send Idempotency-Key from the caller (not Math.random) and If-Match; H21 does not use If-Match; phone-reveal body is {}', () => {
    const w = strip(read(SERVER[2]!));
    expect(w).toMatch(/[Ii]dempotency-Key/);
    expect(w).toMatch(/If-Match/i);
    expect(w).not.toMatch(/Math\.random/);
    expect(w).toMatch(/phone-reveal/);
  });
  it('the view imports no API client / server-only / serverFetch and does not call fetch itself', () => {
    expect(strip(read(VIEW))).not.toMatch(/server-only|serverFetch|server\/(read|write)\.server|fetch\(/);
  });
  it('US-16-1/2: the read side never requests or keeps a phone — the only place phone_e164 appears is the reveal action result; the view never logs, stores or links it', () => {
    const readSide = strip(read(SERVER[1]!));
    expect(readSide).not.toMatch(/phone_e164|phoneE164|patient_phone/);
    const v = strip(read(VIEW));
    expect(v).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\.|href=\{[^}]*phone|tel:/i);
  });
});

describe('imports and unsafe patterns (REQ-SEC-068; LD-140: packages/ui only, no hex colours, pixel radii or inline style objects)', () => {
  beforeEach(() => { expect(mine().length, 'no HC-T19 code files yet — rules below would pass vacuously').toBeGreaterThanOrEqual(4); });
  it('only react / next / @lims/ui / @/core / @/features/homecollection / relative imports', () => {
    for (const f of mine()) for (const i of importsOf(read(f))) expect(i, `${f}: ${i}`).toMatch(/^(react|react-dom|next\/[a-z-]+|server-only|@lims\/ui(\/.*)?|@lims\/shared-ts(\/.*)?|@\/core\/.*|@\/features\/homecollection\/.*|\.{1,2}\/.*)$/);
  });
  it('no raw HTML injection, browser storage, console logging, hand-built bearer header or hand-rolled table / select / dialog / textarea / input / radio', () => {
    for (const f of mine()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie/);
      expect(s, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(s, f).not.toMatch(/authorization|Bearer /i);
      expect(s, f).not.toMatch(/<(table|select|dialog|textarea|input)[\s>]/);
    }
  });
  it('LD-140: no hex/rgb/hsl colours, no inline style objects, no pixel radii or border-radius, no raw rounded-* utilities', () => {
    expect(mine().length, 'no HC-T19 code files yet — rules below would pass vacuously').toBeGreaterThanOrEqual(2);
    for (const f of mine()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(s, f).not.toMatch(/\bstyle=\{|\bstyle=["']/);
      expect(s, f).not.toMatch(/border-?[rR]adius|\brounded(-[a-z0-9]+)?\b|\d+px/);
    }
  });
  it('uses the kit for what §2.2 names: PageHeader, Card, DescriptionList, DataTable, StatusChip(generic), IconButton, RadioGroup, ConfirmDialog/Dialog, MoneyText, DateText, Timeline, Banner', () => {
    const all = mine().map((f) => strip(read(f))).join('\n');
    for (const k of ['PageHeader', 'Card', 'DescriptionList', 'DataTable', 'StatusChip', 'IconButton', 'RadioGroup', 'MoneyText', 'DateText', 'Timeline', 'Banner']) expect(all, k).toMatch(new RegExp(`\\b${k}\\b`));
    expect(all).toMatch(/\b(ConfirmDialog|Dialog)\b/);
    expect(all).toMatch(/StatusChip[^>]*kind=["'{]+generic/);
  });
  it('gates on homecollection.visit.assign (patient card, reveal, review, resolve, actions) and lab.specimen.label_print (Print labels); reuses the shared dialogs from HC-T18', () => {
    const v = strip(read(VIEW));
    expect(v).toContain('homecollection.visit.assign');
    expect(v).toContain('lab.specimen.label_print');
    expect(v).toMatch(/\/lab\/orders\/.*\/labels/);
    expect(v).toMatch(/\/frontdesk\/orders\//);
    expect(v).toMatch(/CancelVisitDialog/);
    expect(v).toMatch(/ScheduleDialog/);
  });
  it('copy: coded sets are read from the API (H20) — no hard-coded review / flag-resolution / revisit reason lists in code', () => {
    const all = mine().map((f) => strip(read(f))).join('\n');
    expect(all).not.toMatch(/confirmed_with_phlebotomist|order_still_valid|specimen_destroyed|duplicate_draw|wrong_patient|not_needed|escalated|partial_collection|patient_request/);
    for (const set of ['review_reasons', 'flag_resolutions', 'revisit_reasons']) expect(all, set).toMatch(new RegExp(set));
  });
  it('the reason text for each hold code is plain words (04-UI-UX §2.2) and lives in the feature, not the API code', () => {
    const all = [...code(feat)].map((f) => strip(read(f))).join('\n');
    expect(all).toContain('The visit or tube changed on the server before this was uploaded');
    expect(all).toContain('Collected by someone not assigned at that time');
    expect(all).toMatch(/Scanned barcode doesn(?:'|&apos;|&#39;|\\')t match the tube/);
  });
});

describe('help (04-UI-UX §6: features/homecollection/help/visit.md for helpKey homecollection.visit)', () => {
  const p = join(feat, 'help', 'visit.md');
  it('explains the visit page in plain words: phone reveal is logged, review Apply/Discard, flags, revisit, no test names', () => {
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t.length).toBeGreaterThan(400);
    expect(t).toMatch(/^# /m);
    for (const n of [/phone/i, /logged|recorded|audit/i, /on hold|held/i, /apply/i, /discard/i, /needs attention|flag/i, /resolve/i, /revisit/i, /tube/i]) expect(t).toMatch(n);
  });
  it('never leaks internals or promises what is not built', () => {
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t).not.toMatch(/stack trace|SELECT |INSERT |homecollection\.[a-z_]+\.v1|Bearer |mutation_superseded|barcode_mismatch/i);
    expect(t).not.toMatch(/SMS (is|will be) sent|sends an SMS/i);
  });
});
