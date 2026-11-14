// T-Q5 — structure / security of app/(display)/{layout.tsx,queue-display/**} (CR-C16-001: no staff shell, no session, CSP as shell;
// 04-UI-UX §9.2 QueueBoard (CR-C16-016); 03-APP-FLOW §7 states; 07-SECURITY cookie attributes, REQ-SEC-088/089/091/092).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const group = fileURLToPath(new URL('../../../app/(display)/', import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] =>
  existsSync(d) ? readdirSync(d).flatMap((n) => (n === '__tests__' ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)])) : [];
const files = () => walk(group).filter((f) => /\.(ts|tsx)$/.test(f));
const src = (f: string) => strip(readFileSync(f, 'utf8'));
const displayOnly = () => files().map(src).join('\n');
// LD-145: the kit QueueBoard owns the stale banner text, so the state texts are read from the (display) sources plus the kit component.
const kit = fileURLToPath(new URL('../../../../../../packages/ui/src/components/QueueBoard/QueueBoard.tsx', import.meta.url));
const all = () => [displayOnly(), existsSync(kit) ? src(kit) : ''].join('\n');
const importsOf = (s: string) => [...s.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('(display) group layout', () => {
  const layout = join(group, 'layout.tsx');
  it('layout.tsx, queue-display/page.tsx and queue-display/api/board/route.ts exist', () => {
    expect(existsSync(layout)).toBe(true);
    expect(existsSync(join(group, 'queue-display/page.tsx'))).toBe(true);
    expect(existsSync(join(group, 'queue-display/api/board/route.ts'))).toBe(true);
  });
  it('has no staff shell, session, permission or nav imports (a staff session on a public TV is a risk — 07 T-D1)', () => {
    const s = src(layout);
    for (const i of importsOf(s)) expect(i, i).not.toMatch(/core\/(shell|session|permissions|nav|errors)|AppShell|Providers/);
    expect(s).not.toMatch(/getShellSession|getAccessToken|AppShell|PermissionDenied|matchStaffRoute|hasPermission/);
  });
  it('renders children and is not a client component', () => {
    const s = readFileSync(layout, 'utf8');
    expect(s).toMatch(/children/);
    expect(strip(s).trimStart().startsWith("'use client'")).toBe(false);
  });
});

describe('queue-display page (states and board)', () => {
  it('shows the four states with the spec texts', () => {
    const s = all();
    expect(s).toContain('Ask a lab administrator to pair this screen');
    expect(s).toContain('This screen is no longer paired');
    expect(s).toMatch(/Connecting/);
    expect(s).toMatch(/Connection lost/);
    expect(s).toMatch(/showing last update/i);
    for (const c of ['live', 'stale', 'unpaired']) expect(s, c).toContain(`'${c}'`);
  });
  it('the (display) sources do not carry their own stale banner (kit QueueBoard owns it; no duplicate live region)', () => {
    expect(files().length).toBeGreaterThan(0);
    expect(displayOnly()).not.toContain('Connection lost');
  });
  it('renders the board through the kit QueueBoard (CR-C16-016), not a local look-alike', () => {
    expect(all()).toMatch(/import\s[^;]*\bQueueBoard\b[^;]*from\s+['"]@lims\/ui/);
  });
  it('polls the same-origin BFF every 5 s with If-None-Match, goes stale after 3 failed polls, and treats 401 as unpaired', () => {
    const s = all();
    expect(s).toMatch(/queue-display\/api\/board/);
    expect(s).toMatch(/5_?000/);
    expect(s).toMatch(/if-none-match/i);
    expect(s).toMatch(/\b3\b/);
    expect(s).toMatch(/401/);
  });
  it('no raw HTML injection, no browser storage / document.cookie, no bearer header, no staff session imports in any (display) file', () => {
    expect(files().length).toBeGreaterThan(0);
    const s = all();
    expect(s).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie/);
    expect(s).not.toMatch(/authorization|Bearer /i);
    expect(s).not.toMatch(/getShellSession|getAccessToken|core\/session|core\/shell/);
  });
  it('shows no patient fields (labels, counters, queues only — US-EN-22.5)', () => {
    expect(files().length).toBeGreaterThan(0);
    expect(all()).not.toMatch(/patient|phone|full_?name|birth/i);
  });
});

describe('display cookie pairing (07-SECURITY; 02-TRD §4.10)', () => {
  // ASSUMPTION: the cookie is set by server code under (display)/queue-display/** (T-Q5 done_when lists its attributes).
  const setters = () => files().map(src).filter((s) => /__Secure-lims_qdisp/.test(s) && /\.set\(|set-cookie/i.test(s));
  it('some file under (display)/queue-display sets __Secure-lims_qdisp', () => {
    expect(setters().length).toBeGreaterThan(0);
  });
  it('with HttpOnly, Secure, SameSite=Strict, Path=/queue-display, Max-Age 31536000 and no Domain', () => {
    expect(setters().length).toBeGreaterThan(0);
    for (const s of setters()) {
      expect(s).toMatch(/httpOnly\s*:\s*true|;\s*HttpOnly/i);
      expect(s).toMatch(/secure\s*:\s*true|;\s*Secure/i);
      expect(s).toMatch(/sameSite\s*:\s*['"]strict['"]|SameSite=Strict/i);
      expect(s).toMatch(/path\s*:\s*['"]\/queue-display['"]|Path=\/queue-display/);
      expect(s).toMatch(/31_?536_?000/);
      expect(s).not.toMatch(/domain\s*:|;\s*Domain=/i);
    }
  });
  it('never uses a __Host- cookie (browsers reject __Host- with a non-/ path) and never exposes the token to client code', () => {
    expect(files().length).toBeGreaterThan(0);
    const s = all();
    expect(s).not.toMatch(/__Host-lims_qdisp/);
    expect(s).not.toMatch(/NEXT_PUBLIC_/);
  });
});
