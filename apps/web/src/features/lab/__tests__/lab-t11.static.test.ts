// C5.T-11 static guards (node env): route files + boundaries, server/client discipline, UI-kit defaults (no own scanner timings), no barcode in URLs / storage / HTML injection.
// 04-UI-UX §1/§3.2/§3.3/§4 (every page has loading + error; kit defaults), 07-SECURITY REQ-SEC-028/088/098, S-09, 03-APP-FLOW §3 (error = ErrorState with request id, no raw message).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const app = join(web, 'src', 'app', '(staff)', 'lab');
const feat = join(web, 'src', 'features', 'lab');
const PAGES = ['collect', 'receive'];
const SCREENS = ['CollectDispatch', 'ReceiveScreen'];
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return n === '__tests__' || n === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const src = (p: string) => readFileSync(p, 'utf8');
const component = (c: string) => join(feat, 'components', `${c}.tsx`);
const own = () => [...walk(feat), ...PAGES.flatMap((p) => walk(join(app, p)))].filter((f) => /\.(tsx?|mjs)$/.test(f));

describe('C5.T-11 routes (03-APP-FLOW §3.2/§3.3)', () => {
  it.each(PAGES)('app/(staff)/lab/%s/page.tsx exists and is a server component (no "use client", default export)', (p) => {
    const f = join(app, p, 'page.tsx');
    expect(existsSync(f)).toBe(true);
    const s = src(f);
    expect(s).not.toMatch(/^['"]use client['"]/m);
    expect(s).toMatch(/export default/);
  });

  it.each(SCREENS)('features/lab/components/%s.tsx exists and is a client component (interactive scan screen)', (c) => {
    expect(existsSync(component(c))).toBe(true);
    expect(src(component(c))).toMatch(/^['"]use client['"]/m);
    expect(src(component(c))).toMatch(new RegExp(`export (function|const) ${c}\\b`));
  });

  it.each(PAGES)('%s has loading.tsx (skeleton) and error.tsx (client boundary, no raw message/stack, shows the digest/request id) — 03-APP-FLOW §3', (p) => {
    const d = join(app, p);
    const has = (n: string) => existsSync(join(d, n)) || existsSync(join(app, n)); // a segment-level boundary at lab/ also counts
    expect(has('loading.tsx')).toBe(true);
    expect(has('error.tsx')).toBe(true);
    const errFile = existsSync(join(d, 'error.tsx')) ? join(d, 'error.tsx') : join(app, 'error.tsx');
    const s = src(errFile);
    expect(s).toMatch(/^['"]use client['"]/m);
    expect(s).not.toMatch(/error\.message|error\.stack/);
    expect(s).toMatch(/digest/);
  });

  it('BFF server actions file exists, is "use server", and server-only code is not imported by the client screens', () => {
    const a = join(feat, 'server', 'actions.ts');
    expect(existsSync(a)).toBe(true);
    expect(src(a)).toMatch(/^['"]use server['"]/m);
    for (const c of SCREENS) {
      const s = src(component(c));
      expect(s, c).toMatch(/\.\.\/server\/actions|@\/features\/lab\/server\/actions/);
      expect(s, c).not.toMatch(/server-fetch|server-only|\.server['"]|\bfetch\(/); // the bearer JWT must not reach the browser (REQ-SEC-068)
    }
  });
});

describe('UI kit defaults (04-UI-UX §3.3: "C5 sets no own timings"; C0 §2.4)', () => {
  it.each(SCREENS)('%s uses the kit BarcodeInput and passes none of the timing/behaviour overrides', (c) => {
    const s = src(component(c));
    expect(s).toMatch(/from ['"]@lims\/ui\/components\/BarcodeInput['"]/);
    expect(s).toMatch(/<BarcodeInput\b/);
    expect(s).not.toMatch(/scannerMaxInterKeyMs|minScanLength|submitKeys|allowManual|clearAfterScan|feedback\s*=/);
  });

  it('ReceiveScreen also uses useScanCapture (document-level capture) and switches it off while a dialog is open', () => {
    const s = src(component('ReceiveScreen'));
    expect(s).toMatch(/useScanCapture\s*\(/);
    expect(s).toMatch(/enabled\s*:/);
    expect(s).toMatch(/Close the dialog before scanning/);
  });

  it('no hand-rolled keydown timing (performance.now / Date.now inter-key logic) in the screens — the kit owns scanner detection', () => {
    for (const c of SCREENS) expect(src(component(c)), c).not.toMatch(/performance\.now|Date\.now\(\)\s*-\s*last/);
  });
});

describe('REQ-SEC-028/088/098, S-09 — no barcode in URLs, no storage of identifiers, no HTML injection', () => {
  it('no barcode / registration_no query parameter or path interpolation anywhere in the lab web code', () => {
    for (const f of own()) {
      const s = src(f);
      expect(s, f).not.toMatch(/[?&](barcode|registration_no|registrationNo)=/);
      expect(s, f).not.toMatch(/specimens\/lookup\?/);
      expect(s, f).not.toMatch(/\/specimens\/\$\{[^}]*(barcode|registration)/i);
      expect(s, f).not.toMatch(/encodeURIComponent\(\s*[\w.]*(barcode|registration)/i);
      expect(s, f).not.toMatch(/(router|history)\.\w+\([^)]*(barcode|registration)/i);
    }
  });

  it('CollectDispatch uses no browser storage at all; no screen uses sessionStorage / indexedDB / document.cookie', () => {
    expect(src(component('CollectDispatch'))).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    for (const c of SCREENS) expect(src(component(c)), c).not.toMatch(/sessionStorage|indexedDB|document\.cookie/);
  });

  it('ReceiveScreen persists only the receiving location (a localStorage key that names the location, never the barcode/registration number)', () => {
    const s = src(component('ReceiveScreen'));
    const writes = [...s.matchAll(/localStorage\.setItem\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    for (const w of writes) {
      expect(w).toMatch(/location|centre|center/i);
      expect(w).not.toMatch(/barcode|registration|specimen/i);
    }
  });

  it('no dangerouslySetInnerHTML / innerHTML / eval / new Function; no console output of scanned values', () => {
    for (const f of own()) {
      const s = src(f);
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/);
      expect(s, f).not.toMatch(/console\.(log|info|debug|warn|error)\(/);
    }
  });
});
