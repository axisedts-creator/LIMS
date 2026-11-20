// SEC-HDR-1 (LD-238, audit 10.1) shared test helpers for the web, portal and partner header tests. Synthetic data only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** `camera=(self), microphone=()` -> { camera: '(self)', microphone: '()' } (allowlist text compared as written, whitespace squeezed). */
export function parsePermissionsPolicy(v: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (v ?? '').split(/,\s*(?=[a-z][a-z-]*\s*=)/i)) {
    const m = /^\s*([a-z][a-z-]*)\s*=\s*(.*?)\s*$/i.exec(part);
    if (m) out[m[1]!.toLowerCase()] = m[2]!.replace(/\s+/g, ' ');
  }
  return out;
}

/** A nonce differs per request; the CSP is compared with every `'nonce-...'` replaced by `'nonce-N'`. */
export const stripNonce = (csp: string): string => csp.replace(/'nonce-[^']+'/g, "'nonce-N'");

const isTestPath = (p: string): boolean => /[\\/](__tests__|tests|e2e|__mocks__)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules' && n !== '.next') walk(p, out); } else if (/\.[cm]?[jt]sx?$/.test(n) && !isTestPath(p)) out.push(p);
  }
  return out;
}

export type Feature = 'camera' | 'microphone' | 'geolocation' | 'payment';
const USES: Record<Feature, RegExp> = {
  camera: /getUserMedia|BarcodeDetector|navigator\s*\.\s*mediaDevices/,
  microphone: /getUserMedia\s*\([^)]*audio/s,
  geolocation: /navigator\s*\.\s*geolocation|\bgeolocation\s*\.\s*(?:getCurrentPosition|watchPosition)/,
  payment: /new\s+PaymentRequest\b/,
};

/** Which browser features the app's own (non-test) source uses; value = repo-relative files. */
export function featuresUsedBy(app: 'web' | 'portal' | 'partner'): Record<Feature, string[]> {
  const root = join(REPO, 'apps', app, 'src');
  const out: Record<Feature, string[]> = { camera: [], microphone: [], geolocation: [], payment: [] };
  for (const f of walk(root)) {
    const t = readFileSync(f, 'utf8');
    for (const k of Object.keys(USES) as Feature[]) if (USES[k].test(t)) out[k].push(f.slice(REPO.length).replace(/\\/g, '/'));
  }
  return out;
}

/** The Permissions-Policy an app must send: a feature is `(self)` only where the app's code uses it, else `()`. */
export function expectedPermissions(app: 'web' | 'portal' | 'partner'): Record<Feature, string> {
  const u = featuresUsedBy(app);
  const o = {} as Record<Feature, string>;
  for (const k of Object.keys(u) as Feature[]) o[k] = u[k].length ? '(self)' : '()';
  return o;
}

const SAFE_REFERRER = ['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'];

/** The three headers LD-238 adds to every web, portal and partner response (HTML, redirect, problem+json). */
export function assertHardened(h: Headers, app: 'web' | 'portal' | 'partner', label: string, referrer?: string): void {
  const fail = (m: string) => { throw new Error(`${app} ${label}: ${m}`); };
  if (h.get('x-frame-options') !== 'DENY') fail(`X-Frame-Options must be DENY, got ${JSON.stringify(h.get('x-frame-options'))}`);
  const r = h.get('referrer-policy');
  if (referrer ? r !== referrer : !r || !SAFE_REFERRER.includes(r.toLowerCase())) fail(`Referrer-Policy ${JSON.stringify(r)} (want ${referrer ?? SAFE_REFERRER.join('|')})`);
  const pp = parsePermissionsPolicy(h.get('permissions-policy'));
  const want = expectedPermissions(app);
  for (const k of Object.keys(want) as Feature[]) if (pp[k] !== want[k]) fail(`Permissions-Policy ${k} must be ${want[k]}, got ${JSON.stringify(pp[k])} (header ${JSON.stringify(h.get('permissions-policy'))})`);
}

/** Next merges `next.config` headers() rules with middleware headers; this resolves the rules the way Next does (path-to-regexp over `source`). */
export async function configHeadersFor(
  cfg: { headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> },
  path: string,
  requireFromHere: (id: string) => unknown,
): Promise<Headers> {
  const out = new Headers();
  if (typeof cfg.headers !== 'function') return out;
  const { pathToRegexp } = requireFromHere('next/dist/compiled/path-to-regexp') as { pathToRegexp: (s: string) => RegExp };
  for (const r of await cfg.headers()) if (pathToRegexp(r.source).test(path)) for (const h of r.headers) out.append(h.key, h.value);
  return out;
}
