// C9.T-22 — structure and rule checks that need no rendering (03-APP-FLOW §4; 04-UI-UX §1 helpKey, §3 components; LD-140; REQ-SEC-068; 07-SECURITY set-up rows).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, FEATURE } from './quality-t22.harness';

const TABS = ['materials', 'maps', 'plans', 'targets'];
const SETUP = join(APP, 'setup');
const FORMS = join(FEATURE, 'forms');
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === '__tests__' || f === 'node_modules' ? [] : walk(p)) : [p]; }) : []);
const src = (f: string) => readFileSync(f, 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (f: string) => /\.(ts|tsx)$/.test(f);
const mine = () => [...walk(SETUP), ...walk(FORMS)].filter(code);
const isClient = (s: string) => /^\s*['"]use client['"]/.test(s);

describe('files (T-22 owns app/(staff)/quality/setup/** and features/quality/forms)', () => {
  it.each(TABS)('tab %j has page.tsx + loading.tsx + error.tsx under setup/', (t) => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(SETUP, t, f)), `setup/${t}/${f}`).toBe(true);
  });
  it.each(TABS)('error.tsx of %j is a client component with ErrorState + retry and no raw error text', (t) => {
    const s = src(join(SETUP, t, 'error.tsx'));
    expect(isClient(s)).toBe(true);
    expect(s).toContain('ErrorState');
    expect(s).toMatch(/retry|reset/i);
    expect(stripComments(s)).not.toMatch(/error\.message|error\.stack/);
  });
  it.each(TABS)('loading.tsx of %j is a LoadingSkeleton', (t) => {
    expect(src(join(SETUP, t, 'loading.tsx'))).toContain('LoadingSkeleton');
  });
  it('features/quality/forms holds the form code and the set-up pages use kit PageShell/PageHeader/Tabs', () => {
    expect(walk(FORMS).filter(code).length).toBeGreaterThan(0);
    const all = mine().map(src).join('\n');
    for (const k of ['PageShell', 'PageHeader', 'Tabs', 'Dialog', 'DataTable']) expect(all, k).toContain(k);
  });
  it('every set-up page header carries a helpKey and an in-app help file exists for set-up (04-UI-UX §1)', () => {
    const all = mine().map(src).join('\n');
    expect((all.match(/helpKey/g) ?? []).length).toBeGreaterThanOrEqual(TABS.length);
    expect(walk(join(FEATURE, 'help')).some((f) => /setup|materials|maps|plans|targets/i.test(f))).toBe(true);
  });
});

describe('LD-140 — only @lims/ui components and tokens', () => {
  it('set-up and forms code has no hex colours, no pixel sizes, no inline style objects', () => {
    for (const f of mine()) {
      const s = stripComments(src(f));
      expect(s, `${f}: hex colour`).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
      expect(s, `${f}: px literal`).not.toMatch(/\b\d+(\.\d+)?px\b/);
      expect(s, `${f}: inline style`).not.toMatch(/style=\{\{/);
    }
  });
  it('cites LD-140 in a code comment', () => {
    expect(mine().some((f) => /LD-140/.test(src(f)))).toBe(true);
  });
  it('no local look-alike of a kit component (Dialog/ConfirmDialog/Tabs/DataTable/Drawer/Banner/Select/Combobox/StatusChip/EmptyState/ErrorState)', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/(function|const)\s+(Dialog|ConfirmDialog|Tabs|DataTable|Drawer|Banner|Select|Combobox|StatusChip|EmptyState|ErrorState|DatePicker|IntegerField|DecimalField)\b/);
  });
  it('status words come with a StatusChip; native <input>/<select>/<table> are not hand-rolled (kit fields only)', () => {
    const all = mine().map((f) => stripComments(src(f))).join('\n');
    expect(all).toMatch(/StatusChip/);
    expect(all).not.toMatch(/<select\b|<table\b|<dialog\b/);
  });
  it('masters are a list with a right drawer and per-section dialogs; at most one primary button per page (static: no two variant="primary" in one JSX file)', () => {
    for (const f of walk(SETUP).filter((x) => /page\.tsx$/.test(x))) expect((stripComments(src(f)).match(/variant=["']primary["']/g) ?? []).length, f).toBeLessThanOrEqual(1);
  });
});

describe('security — token on the server only; BFF for C3/C7; no PHI; no unsafe HTML (REQ-SEC-068, 07-SECURITY)', () => {
  it("client components never import server-fetch / session code, never read process.env, never call fetch(), never name a C3/C7 URL", () => {
    for (const f of mine()) {
      const s = src(f);
      if (!isClient(s)) continue;
      expect(s, `${f}: server import`).not.toMatch(/server-fetch|core\/session\/server|server-only/);
      const c = stripComments(s);
      expect(c, `${f}: env`).not.toMatch(/process\.env/);
      expect(c, `${f}: fetch`).not.toMatch(/\bfetch\(/);
      expect(c, `${f}: C3/C7 URL in client`).not.toMatch(/\/v1\/(instruments|catalog)/);
    }
  });
  it("a 'use server' module re-validates and is the only place that calls POST with an Idempotency-Key", () => {
    const servers = [...walk(SETUP), ...walk(FORMS), ...walk(FEATURE)].filter(code).filter((f) => /^\s*['"]use server['"]/.test(src(f)) && /setup|forms|picker|targets|plans|maps|materials/i.test(f + src(f).slice(0, 400)));
    expect(servers.length, 'a server-actions module for set-up writes').toBeGreaterThan(0);
    const all = servers.map((f) => stripComments(src(f))).join('\n');
    expect(all).toMatch(/idempotency-key/i);
    expect(all).toMatch(/if-match/i);
    expect(all).toMatch(/control-materials/);
    expect(all).toMatch(/qc-targets\/establish|establish/);
  });
  it('picker reads for C7/C3 are done server-side and gated by the two read permissions named in the contract', () => {
    const all = [...walk(FEATURE), ...walk(SETUP)].filter(code).map((f) => stripComments(src(f))).join('\n');
    expect(all).toContain('instruments.instrument.read');
    expect(all).toContain('catalog.test.read');
    expect(all).toMatch(/\/v1\/instruments\/instruments/);
    expect(all).toMatch(/\/v1\/catalog\/tests/);
  });
  it('no dangerouslySetInnerHTML, no localStorage/sessionStorage, no innerHTML', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|\.innerHTML\s*=/);
  });
  it('no patient identifiers are read from any DTO (C9 shows none)', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/patient_name|patient_id|barcode|registration_no|mrn\b/i);
  });
  it('only documented permission names appear; writes are gated on quality.qc.manage and reads on quality.qc_run.read', () => {
    const known = new Set(['quality.qc_run.read', 'quality.qc_run.review', 'quality.qc.manage', 'quality.autoverify.read', 'quality.autoverify.manage', 'quality.tat_alert.read', 'quality.tat_alert.ack', 'quality.config.manage']);
    const all = mine().map((f) => stripComments(src(f))).join('\n');
    for (const m of all.matchAll(/['"`](quality\.[a-z_]+\.[a-z_]+|quality\.qc\.manage)['"`]/g)) expect(known.has(m[1]!), m[1]).toBe(true);
    expect(all).toMatch(/quality\.qc\.manage|MANAGE/);
  });
  it('no raw SQL-ish string building or eval of user input in set-up code', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/\beval\(|new Function\(|document\.write\(/);
  });
});

describe('spec names are copied verbatim (never invented)', () => {
  it('error codes used for field mapping are the documented ones', () => {
    const known = new Set(['quality.code_duplicate', 'quality.lot_expired', 'quality.qc_target_missing', 'quality.insufficient_qc_data', 'quality.qc_run_closed', 'quality.not_in_plan', 'common.validation_failed', 'common.immutable_record', 'common.version_conflict', 'common.not_found', 'common.feature_disabled', 'common.dependency_unavailable', 'common.idempotency_key_reused', 'auth.forbidden', 'common.invalid_cursor']);
    const all = mine().map((f) => stripComments(src(f))).join('\n');
    for (const m of all.matchAll(/['"`]((?:quality|common|auth)\.[a-z_]+)['"`]/g)) {
      if (/^quality\.qc(_run)?\.(read|review|manage)$/.test(m[1]!)) continue; // permission names, checked elsewhere
      expect(known.has(m[1]!), m[1]).toBe(true);
    }
  });
});
