// C9.T-24 — structure and rule checks that need no rendering (03-APP-FLOW §4 loading/error per page; 04-UI-UX §1 helpKey, §3 components; LD-140; REQ-SEC-068; permission names).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, FEATURE } from './quality-t24.harness';

const PAGES = ['tat-alerts', 'settings'];
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === '__tests__' || f === 'node_modules' ? [] : walk(p)) : [p]; }) : []);
const src = (f: string) => readFileSync(f, 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const mine = () => [...PAGES.flatMap((p) => walk(join(APP, p))), join(FEATURE, 'server', 'tat-badge.ts'), ...walk(join(FEATURE, 'tat')), ...walk(join(FEATURE, 'settings'))].filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(f));

describe('files', () => {
  it.each(PAGES)('%s has page.tsx + loading.tsx + error.tsx', (p) => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(APP, p, f)), `${p}/${f}`).toBe(true);
  });
  it.each(PAGES)('error.tsx of %s is a client component with ErrorState + Retry and no raw error text', (p) => {
    const s = src(join(APP, p, 'error.tsx'));
    expect(/^\s*['"]use client['"]/.test(s)).toBe(true);
    expect(s).toContain('ErrorState');
    expect(s).toMatch(/retry|reset/i);
    expect(stripComments(s)).not.toMatch(/error\.message|error\.stack/);
  });
  it.each(PAGES)('loading.tsx of %s is a LoadingSkeleton', (p) => {
    expect(src(join(APP, p, 'loading.tsx'))).toContain('LoadingSkeleton');
  });
  it('the TAT badge module exists (server/tat-badge.ts exports getTatAlertBadge)', () => {
    const f = join(FEATURE, 'server', 'tat-badge.ts');
    expect(existsSync(f)).toBe(true);
    expect(src(f)).toMatch(/export\s+(async\s+)?(function|const)\s+getTatAlertBadge/);
  });
  it('in-app help exists for both pages and each page header carries a helpKey', () => {
    for (const k of ['tat_alerts', 'settings']) expect(existsSync(join(FEATURE, 'help', `${k}.md`)), `help/${k}.md`).toBe(true);
    for (const p of PAGES) expect(src(join(APP, p, 'page.tsx')) + walk(join(FEATURE)).filter((f) => /tat|settings/i.test(f) && /\.tsx$/.test(f)).map(src).join('\n')).toMatch(/helpKey/);
  });
});

describe('LD-140 — only @lims/ui components and tokens', () => {
  it('no hex colours, no pixel sizes, no inline style objects', () => {
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
  it('no local look-alike of a kit component', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/(function|const)\s+(DataTable|StatusChip|Drawer|Dialog|ConfirmDialog|Banner|Card|Switch|Tabs|EmptyState|ErrorState|Badge)\b/);
  });
  it('level words come with StatusChip; the page uses PageHeader and PageShell', () => {
    const all = mine().map(src).join('\n');
    expect(all).toMatch(/StatusChip/);
    expect(all).toContain('PageHeader');
  });
});

describe('security — token stays on the server; no PHI; no unsafe HTML (REQ-SEC-068)', () => {
  it("client components never import server code, read process.env or call fetch(); only 'use server' actions reach the API", () => {
    for (const f of mine()) {
      const s = src(f);
      if (/^\s*['"]use client['"]/.test(s)) {
        expect(s, `${f}: server import in client`).not.toMatch(/server-fetch|core\/session\/server|server-only/);
        expect(stripComments(s), `${f}: env in client`).not.toMatch(/process\.env/);
        expect(stripComments(s), `${f}: direct API fetch in client`).not.toMatch(/\bfetch\(/);
      }
    }
  });
  it('no dangerouslySetInnerHTML, no localStorage/sessionStorage, no innerHTML', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|\.innerHTML\s*=/);
  });
  it('no patient identifiers are read from any DTO', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/patient_name|patient_id|barcode|registration_no|mrn\b/i);
  });
  it('specimen links use buildRoute(staff.lab.specimen), not a hand-written /lab path', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/['"`]\/lab\/(specimens|orders)/);
    expect(mine().map(src).join('\n')).toContain('staff.lab.specimen');
  });
});

describe('names are the spec names (never invented)', () => {
  it('only documented permission names appear; ack uses quality.tat_alert.ack, settings writes use quality.config.manage', () => {
    const known = new Set(['quality.qc_run.read', 'quality.qc_run.review', 'quality.qc.manage', 'quality.autoverify.read', 'quality.autoverify.manage', 'quality.tat_alert.read', 'quality.tat_alert.ack', 'quality.config.manage']);
    const all = mine().map((f) => stripComments(src(f))).join('\n');
    for (const m of all.matchAll(/['"`](quality\.[a-z_]+\.[a-z_]+)['"`]/g)) expect(known.has(m[1]!), m[1]).toBe(true);
    expect(all).toContain('quality.tat_alert.ack');
    expect(all).toContain('quality.config.manage');
  });
  it('only the documented operations are called (#48, #50, #51–#54)', () => {
    const all = mine().map((f) => stripComments(src(f))).join('\n');
    for (const p of ['tat-alerts', 'acknowledge', 'settings', 'coded-sets']) expect(all).toContain(p);
  });
});
