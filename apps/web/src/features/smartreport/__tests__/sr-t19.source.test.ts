// C14.T19 — structure / security of the SR-02 route files (app/(staff)/smartreport/summaries/[summary_id]/{page,loading,error}.tsx) and the feature sources
// (07-SECURITY REQ 081/088: text only, no raw HTML, no PHI in URLs or storage, token stays server side; LD-140: kit components and tokens only, no hex colours / inline style objects).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const app = fileURLToPath(new URL('../../../app/(staff)/smartreport/', import.meta.url));
const feat = fileURLToPath(new URL('../', import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; });
const sources = () => walk(feat).filter((p) => /\.(ts|tsx)$/.test(p));
const dir = join(app, 'summaries', '[summary_id]');
const routeFiles = () => ['page', 'loading', 'error'].map((f) => join(dir, `${f}.tsx`)).filter(existsSync);
/** The SR-02 sources: route files + feature files that mention the summary detail (review, approve, history, results used). */
const sr02 = () => [...routeFiles(), ...sources().filter((p) => /summary[-_.]?(review|detail)|SummaryReview|SummaryDetail|summary\.review|summaries-detail|\[summary_id\]/i.test(p) || /Results used|Approve this summary\?/.test(readFileSync(p, 'utf8')))];

describe('route files', () => {
  it('summaries/[summary_id]/{page,loading,error}.tsx exist', () => {
    for (const f of ['page', 'loading', 'error']) expect(existsSync(join(dir, `${f}.tsx`)), `${f}.tsx`).toBe(true);
  });

  it('page.tsx is a server component with a default export (no "use client"); error.tsx is a client component; loading.tsx is not', () => {
    const page = readFileSync(join(dir, 'page.tsx'), 'utf8');
    expect(page).not.toMatch(/['"]use client['"]/);
    expect(strip(page)).toMatch(/export default/);
    expect(readFileSync(join(dir, 'error.tsx'), 'utf8')).toMatch(/['"]use client['"]/);
    expect(readFileSync(join(dir, 'loading.tsx'), 'utf8')).not.toMatch(/['"]use client['"]/);
  });
});

describe('SR-02 sources', () => {
  it('there is SR-02 code to inspect', () => { expect(sr02().length).toBeGreaterThan(1); });

  it('no raw HTML injection, no browser storage, no hand-built bearer header, no eval', () => {
    for (const p of sr02()) {
      const s = strip(readFileSync(p, 'utf8'));
      expect(s, p).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(s, p).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(s, p).not.toMatch(/Bearer /);
    }
  });

  it('LD-140: composed from @lims/ui only — no hex colours, rgb(), inline style objects, raw <table>', () => {
    for (const p of sr02().filter((x) => x.endsWith('.tsx'))) {
      const s = strip(readFileSync(p, 'utf8'));
      expect(s, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
      expect(s, p).not.toMatch(/style=\{\{/);
      expect(s, p).not.toMatch(/<table[\s>]/);
    }
  });

  it('uses the kit for the screen: ConfirmDialog (approve/reject), Banner, Timeline (History), DataTable (Results used), TimeSeriesChart (trends), StatusChip', () => {
    const joined = sr02().map((p) => strip(readFileSync(p, 'utf8'))).join('\n');
    for (const c of ['ConfirmDialog', 'Banner', 'Timeline', 'DataTable', 'TimeSeriesChart', 'StatusChip']) expect(joined, c).toMatch(new RegExp(`@lims/ui/components/${c}`));
  });

  it('the order-results link is built with the generated route id (staff.lab.order_results), not a hand-written path with a PHI field', () => {
    const joined = sr02().map((p) => strip(readFileSync(p, 'utf8'))).join('\n');
    expect(joined).toMatch(/staff\.lab\.order_results|\/lab\/orders\/\$\{/);
    expect(joined).toMatch(/lab\.result\.read/);
  });

  it('PHI (registration no., patient name) is never put into a URL', () => {
    for (const p of sources().filter((x) => /\.tsx?$/.test(x))) expect(strip(readFileSync(p, 'utf8')), p).not.toMatch(/(push|replace|href)[^\n;]*\$\{[^}]*(registration_no|patient_display_name|registrationNo)/);
  });

  it('data access stays on the server: the summary read imports server-only; client components never fetch or touch /v1/ or the token', () => {
    const serverFiles = sources().filter((p) => /[\\/]server[\\/]/.test(p) && /smartreport\/summaries\/\$\{|smartreport\/summaries\/`/.test(readFileSync(p, 'utf8')));
    expect(serverFiles.length).toBeGreaterThan(0);
    for (const p of serverFiles) expect(readFileSync(p, 'utf8'), p).toMatch(/import ['"]server-only['"]/);
    for (const p of sr02().filter((x) => x.endsWith('.tsx') && /['"]use client['"]/.test(readFileSync(x, 'utf8')))) expect(strip(readFileSync(p, 'utf8')), p).not.toMatch(/serverFetch|server-fetch|\bfetch\(|\/v1\/|getAccessToken/);
  });

  it('server actions for approve/reject re-check ids and the attestation literal before calling the API (actions are public endpoints)', () => {
    const acts = sources().filter((p) => /'use server'/.test(readFileSync(p, 'utf8')) && /approve|reject/i.test(readFileSync(p, 'utf8')) && /summar/i.test(readFileSync(p, 'utf8')));
    expect(acts.length).toBeGreaterThan(0);
    const s = acts.map((p) => strip(readFileSync(p, 'utf8'))).join('\n');
    expect(s).toMatch(/UUID_RE|isUuid|uuid/i);
    expect(s).toMatch(/attestation:\s*true/);
  });
});
