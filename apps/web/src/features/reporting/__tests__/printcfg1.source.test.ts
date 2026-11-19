// T0D-PRINTCFG-1 static checks (node environment, tester-owned): the parts jsdom cannot prove. Routes, the admin/platform/(auth) pages and the rs-c2 pins are
// guarded by the rs-c2 static test that verify.cmd runs last; the 20 file cap and 1366 x 768 fit are listed as not machine-checked in the notes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const features = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/src/features/
const web = fileURLToPath(new URL('../../../../', import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '__tests__' || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx|css)$/.test(n)) out.push(p);
  }
  return out;
}
const src = (feature: string) => walk(join(features, feature)).map((p) => ({ p, t: readFileSync(p, 'utf8') }));
const reporting = src('reporting');
const billing = src('billing');
const all = [...reporting, ...billing];
const rel = (p: string) => p.replace(features, '');

describe('typed text is plain text, never HTML (done_when 6)', () => {
  it('no reporting or billing source injects HTML', () => {
    const bad = all.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write\(/.test(f.t)).map((f) => rel(f.p));
    expect(bad).toEqual([]);
  });
});

describe('typed server calls exist in the feature server folders (brief: reporting/server and billing/server typed calls)', () => {
  const reportingServer = reporting.filter((f) => /reporting[\\/]server[\\/]/.test(f.p));
  const billingServer = billing.filter((f) => /billing[\\/]server[\\/]/.test(f.p));
  it('reporting/server calls the five new operations by their contract paths', () => {
    const t = reportingServer.map((f) => f.t).join('\n');
    for (const path of ['/v1/reporting/print-profiles', '/v1/reporting/print-profiles/preview', '/v1/reporting/signatory-profiles']) expect(t.includes(path), path).toBe(true);
  });
  it('the signature image goes through the existing branding upload route (no new upload route)', () => {
    expect(all.some((f) => f.t.includes('/v1/identity/settings/branding-assets'))).toBe(true);
  });
  it('billing/server forwards the print style to printInvoice', () => {
    const t = billingServer.map((f) => f.t).join('\n');
    expect(/style/.test(t)).toBe(true);
    expect(/plain_bw/.test(t)).toBe(true);
  });
  it('files that call the new paths re-check ids as UUIDs before they reach a path or query', () => {
    const calling = reportingServer.filter((x) => /signatory-profiles|print-profiles/.test(x.t));
    expect(calling.length).toBeGreaterThan(0);
    expect(calling.filter((f) => !/UUID_RE|uuid/i.test(f.t)).map((f) => rel(f.p))).toEqual([]);
  });
});

describe('signature image limits are in the browser code (done_when 2)', () => {
  const comp = reporting.filter((f) => /reporting[\\/]components[\\/]/.test(f.p)).map((f) => f.t).join('\n');
  it('shrinks to 600 x 200 and caps at 300 KB', () => {
    // booleans, not toMatch: a failing toMatch would dump every component source into the report
    expect(/\b600\b/.test(comp)).toBe(true);
    expect(/\b200\b/.test(comp)).toBe(true);
    expect(/300\s*\*\s*1024|307_?200|300 ?KB/.test(comp)).toBe(true);
  });
});

describe('no new dependency for image shrinking or pictures', () => {
  it('apps/web/package.json adds no image library (browser canvas is enough)', () => {
    const pkg = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    const names = Object.keys(pkg.dependencies ?? {});
    expect(names.filter((n) => /^(canvas|sharp|jimp|pica|browser-image-compression|compressorjs|cropperjs|react-image-crop|html2canvas)$/.test(n))).toEqual([]);
  });
});
