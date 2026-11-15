// WEB-AUTH-REDIRECT-2 (LD-203, 2026-11-15; AC-0D-7.2; REQ-SEC-068): REAL server proof.
// Builds apps/web (pnpm --filter @lims/web build), starts `next start` on a free 127.0.0.1 port, requests over loopback only, stops it.
// Synthetic data, no external network, no cookie, no secret. The unit tests call middleware() directly and missed the 500.
// Run: .orchestra/notes/WEB-AUTH-REDIRECT-2-verify.cmd
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const webDir = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const repoRoot = resolve(webDir, '../..');
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

let server: ChildProcess | undefined;
let base = '';
let log = '';

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

const get = (path: string, accept: string) => fetch(`${base}${path}`, { redirect: 'manual', headers: { accept } });

beforeAll(async () => {
  const b = spawnSync('pnpm --filter @lims/web build', { cwd: repoRoot, shell: true, encoding: 'utf8', timeout: 800_000 });
  if (b.status !== 0) throw new Error(`pnpm --filter @lims/web build exited ${b.status}\n${(b.stdout ?? '').split('\n').slice(-15).join('\n')}\n${b.stderr ?? ''}`);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const nextBin = resolve(webDir, 'node_modules/next/dist/bin/next');
  server = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: webDir,
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => (log += d));
  server.stderr?.on('data', (d) => (log += d));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`next start exited ${server.exitCode}\n${log}`);
    try {
      await fetch(`${base}/auth/login`, { redirect: 'manual' });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`next start not ready in 60 s\n${log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

afterAll(() => {
  if (!server || server.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f']);
  else server.kill('SIGKILL');
});

describe('real next start: document requests without a session (AC-0D-7.2)', () => {
  for (const path of ['/', '/dashboard', '/no-such-page']) {
    it(`GET ${path} Accept text/html → 307, Location to /auth/login on the request origin, never 500`, async () => {
      const res = await get(path, HTML);
      expect(res.status, log).toBe(307);
      const loc = res.headers.get('location') ?? '';
      const u = new URL(loc, base);
      expect(u.pathname).toBe('/auth/login');
      expect(u.search).toBe('');
      expect(u.origin).toBe(base);
    });
  }

  it('the redirect keeps CSP (report-only, nonce), nosniff, no-store; sets no cookie (REQ-SEC-068)', async () => {
    const res = await get('/dashboard', HTML);
    expect(res.status).toBe(307);
    expect(res.headers.get('content-security-policy-report-only') ?? '').toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a hostile query string or spoofed forwarded host never reaches Location (no open redirect)', async () => {
    const res = await fetch(`${base}/?next=https://evil.example/x`, { redirect: 'manual', headers: { accept: HTML, 'x-forwarded-host': 'evil.example' } });
    expect(res.status).toBe(307);
    expect(res.headers.get('location') ?? '').not.toMatch(/evil/i);
    const u = new URL(res.headers.get('location') ?? '', base);
    expect(u.pathname).toBe('/auth/login');
    expect(u.origin).toBe(base);
  });
});

describe('real next start: JSON and public paths', () => {
  for (const path of ['/', '/dashboard', '/no-such-page']) {
    it(`GET ${path} Accept application/json → 401 problem+json auth.unauthenticated`, async () => {
      const res = await get(path, 'application/json');
      expect(res.status, log).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('location')).toBeNull();
      expect(await res.json()).toMatchObject({ status: 401, code: 'auth.unauthenticated' });
    });
  }

  for (const path of ['/auth/login', '/auth/session-expired']) {
    it(`GET ${path} Accept text/html → 200 (no loop)`, async () => {
      const res = await get(path, HTML);
      expect(res.status, log).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    });
  }
});
