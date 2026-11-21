// C9.T-21 — structure and rule checks that need no rendering (03-APP-FLOW §4 "every page has loading.tsx, error.tsx"; 04-UI-UX §1 helpKey, §3 components; LD-140; REQ-SEC-068).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, FEATURE } from './quality-t21.harness';

const PAGES = ['', 'runs', 'qc-runs/[qc_run_id]', 'lj', 'observations'];
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === '__tests__' || f === 'node_modules' ? [] : walk(p)) : [p]; }) : []);
const src = (f: string) => readFileSync(f, 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const featureFiles = () => walk(FEATURE).filter((f) => /\.(ts|tsx)$/.test(f) && !/nav\.manifest\.ts$/.test(f));
const appFiles = () => walk(APP).filter((f) => /\.(ts|tsx)$/.test(f));
const mine = () => [...featureFiles(), ...appFiles()];

describe('files (T-21 owns app/(staff)/quality/** and features/quality/**)', () => {
  it.each(PAGES)('page %j has page.tsx + loading.tsx + error.tsx', (p) => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(APP, p, f)), `${p}/${f}`).toBe(true);
  });
  it.each(PAGES)('error.tsx of %j is a client component that renders ErrorState with Retry and shows no raw error text', (p) => {
    const s = src(join(APP, p, 'error.tsx'));
    expect(s.trimStart().startsWith("'use client'") || s.trimStart().startsWith('"use client"')).toBe(true);
    expect(s).toContain('ErrorState');
    expect(s).toMatch(/retry|reset/i);
    expect(stripComments(s)).not.toMatch(/error\.message|error\.stack/);
  });
  it.each(PAGES)('loading.tsx of %j is a LoadingSkeleton', (p) => {
    expect(src(join(APP, p, 'loading.tsx'))).toContain('LoadingSkeleton');
  });
  it('in-app help exists under features/quality/help and every page header carries a helpKey (04-UI-UX §1)', () => {
    expect(walk(join(FEATURE, 'help')).length).toBeGreaterThan(0);
    const all = mine().map(src).join('\n');
    expect((all.match(/helpKey/g) ?? []).length).toBeGreaterThanOrEqual(PAGES.length);
    expect(all).toContain('PageHeader');
    expect(all).toContain('PageShell');
  });
});

describe('LD-140 — only @lims/ui components and tokens', () => {
  it('feature + page code has no hex colours, no pixel sizes, no inline style objects', () => {
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
  it('no local look-alike of a kit component (DataTable/StatusChip/Drawer/ConfirmDialog/Banner/ControlChart) is defined here', () => {
    for (const f of featureFiles()) {
      const s = stripComments(src(f));
      expect(s, f).not.toMatch(/(function|const)\s+(DataTable|StatusChip|Drawer|ConfirmDialog|Banner|ControlChart|EmptyState|ErrorState)\b/);
    }
  });
  it('status words come with the chip: StatusChip is used for run/observation outcomes', () => {
    expect(mine().map(src).join('\n')).toMatch(/StatusChip/);
  });
});

describe('security — token stays on the server; no PHI; no unsafe HTML (REQ-SEC-068, 04-UI-UX §1 PHI)', () => {
  it("client components never import server-fetch / session code or read process.env; only 'use server' actions call the API", () => {
    for (const f of mine()) {
      const s = src(f);
      if (/^\s*['"]use client['"]/.test(s)) {
        expect(s, `${f}: server import in client`).not.toMatch(/server-fetch|core\/session\/server|server-only/);
        expect(stripComments(s), `${f}: env in client`).not.toMatch(/process\.env/);
        expect(stripComments(s), `${f}: direct API fetch in client`).not.toMatch(/\bfetch\(/);
      }
    }
  });
  it('no dangerouslySetInnerHTML, no localStorage/sessionStorage of QC data, no innerHTML', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|\.innerHTML\s*=/);
  });
  it('no patient identifiers are read from any DTO (C9 shows none)', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/patient_name|patient_id|barcode|registration_no|mrn\b/i);
  });
  it('links to C5 pages use buildRoute(staff.lab.*), not hand-written paths', () => {
    for (const f of mine()) expect(stripComments(src(f)), f).not.toMatch(/['"`]\/lab\/(specimens|orders)/);
  });
});

describe('route ids and permissions are the spec names (never invented)', () => {
  it('only the documented permission names appear', () => {
    const known = new Set(['quality.qc_run.read', 'quality.qc_run.review', 'quality.qc.manage', 'quality.autoverify.read', 'quality.autoverify.manage', 'quality.tat_alert.read', 'quality.tat_alert.ack', 'quality.config.manage']);
    for (const f of mine()) for (const m of stripComments(src(f)).matchAll(/['"`](quality\.[a-z_]+\.[a-z_]+|quality\.qc\.manage)['"`]/g)) {
      if (/^quality\.(qc_run|qc|autoverify|tat_alert|config)\./.test(m[1]!)) expect(known.has(m[1]!), `${f}: ${m[1]}`).toBe(true);
    }
  });
});
