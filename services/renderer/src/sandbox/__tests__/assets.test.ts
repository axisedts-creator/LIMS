// C6-T12 — recorded decisions, image hardening and the container "no network" test (02-TRD §5.2; REQ-SEC-087/129/130).
// done_when: "malformed corpus rejected; merged page numbering correct; no network in container test".
// The runtime container checks need a reachable Docker daemon and network for the build; without one they are reported
// with a console warning (same convention as devanagari.test.ts) and the static checks still run.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const renderer = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(renderer(p), 'utf8');
const sandboxSrc = () =>
  readdirSync(renderer('src/sandbox'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ f, s: read(`src/sandbox/${f}`) }));

describe('src/sandbox/DECISIONS.md (qpdf options from the 12.4.2 manual, 02-TRD §5.2)', () => {
  const d = () => read('src/sandbox/DECISIONS.md');
  it('exists and pins qpdf 12.4.2 and @cantoo/pdf-lib 2.11.1', () => {
    expect(d()).toContain('12.4.2');
    expect(d()).toContain('2.11.1');
    expect(d()).toContain('@cantoo/pdf-lib');
  });
  it('records an option (or an explicit "none") for each of the five sanitise steps, with `--` flags from the manual', () => {
    const t = d();
    for (const step of [/magic/i, /structural|check/i, /encrypt/i, /linear/i, /page count|page-count|pages/i]) expect(t).toMatch(step);
    expect(t).toContain('--linearize');
    expect(new Set(t.match(/--[a-z][a-z0-9-]+/g)).size).toBeGreaterThanOrEqual(4);
  });
  it('states that qpdf is invoked with an argument array, never through a shell', () => {
    expect(d()).toMatch(/argument array|argv|no shell|never through a shell/i);
  });
});

describe('sandbox source (never a shell, never the network, never Chromium)', () => {
  it('src/sandbox/server.ts exists', () => {
    expect(existsSync(renderer('src/sandbox/server.ts'))).toBe(true);
  });
  it('qpdf is spawned with an argument array: no `shell: true`, no exec()/execSync()', () => {
    const files = sandboxSrc();
    expect(files.length).toBeGreaterThan(0);
    for (const { f, s } of files) {
      expect(s, f).not.toMatch(/shell\s*:\s*true/);
      expect(s, f).not.toMatch(/\bexec(Sync)?\s*\(/);
      expect(s, f).not.toMatch(/import\s*\{[^}]*\bexec(Sync)?\b[^}]*\}\s*from\s*['"](node:)?child_process['"]/);
    }
  });
  it('no outbound client and no Chromium: no fetch/http.request/net.connect, no playwright, no ../pool or ../render import', () => {
    for (const { f, s } of sandboxSrc()) {
      expect(s, f).not.toMatch(/\bfetch\s*\(|https?\.(request|get)\s*\(|net\.(connect|createConnection)|\bWebSocket\b/);
      expect(s, f).not.toMatch(/playwright|from\s+['"]\.\.\/(pool|render|guard)(\.js)?['"]/);
    }
  });
  it('the auth token is compared in constant time', () => {
    expect(sandboxSrc().map((x) => x.s).join('\n')).toMatch(/timingSafeEqual/);
  });
});

describe('Dockerfile.sandbox (REQ-SEC-087, REQ-SEC-129/130)', () => {
  const d = () => read('Dockerfile.sandbox');
  it('every base image is pinned by digest', () => {
    const froms = d().match(/^FROM\s+\S+/gm) ?? [];
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
  it('installs qpdf 12.4.2 and no browser', () => {
    expect(d()).toMatch(/qpdf/);
    expect(d()).toContain('12.4.2');
    expect(d()).not.toMatch(/playwright|chromium/i);
  });
  it('runs as a numeric non-root user and starts the sandbox server', () => {
    const u = /^USER\s+(\d+)(?::\d+)?\s*$/m.exec(d());
    expect(u).not.toBeNull();
    expect(Number(u![1])).toBeGreaterThan(0);
    expect(d()).toMatch(/^CMD\s.*sandbox\/server/m);
  });
  it('holds no secrets: token-ish ENV/ARG are *_FILE paths only', () => {
    for (const line of d().split('\n').filter((l) => /^\s*(ENV|ARG)\s/.test(l) && /TOKEN|SECRET|PASSWORD|KEY/i.test(l))) expect(line).toMatch(/_FILE\b/);
  });
  it('package.json pins @cantoo/pdf-lib to exactly 2.11.1', () => {
    expect(JSON.parse(read('package.json')).dependencies['@cantoo/pdf-lib']).toBe('2.11.1');
  });
});

const dockerUp = spawnSync('docker', ['info'], { timeout: 20_000 }).status === 0;
if (!dockerUp) console.warn('[C6-T12] SKIP container no-network test: Docker daemon not reachable; run where Docker is up');

describe.skipIf(!dockerUp)('container test: built image, --network none (done_when "no network in container test")', () => {
  const IMG = 'lims-c6t12-sandbox:test';
  const run = (args: string[]) =>
    spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/work', ...args], { encoding: 'utf8', timeout: 120_000 });

  it('builds from services/renderer/Dockerfile.sandbox', () => {
    execFileSync('docker', ['build', '-f', 'services/renderer/Dockerfile.sandbox', '-t', IMG, '.'], { cwd: repoRoot, stdio: 'pipe', timeout: 800_000 });
  });
  it('qpdf in the image is 12.4.2', () => {
    const r = run(['--entrypoint', 'qpdf', IMG, '--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('12.4.2');
  });
  it('outbound connections fail (IP and DNS)', () => {
    const probe = (u: string) =>
      run(['--entrypoint', 'node', IMG, '-e', `fetch(${JSON.stringify(u)},{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0),()=>process.exit(7))`]);
    expect(probe('http://1.1.1.1/').status).toBe(7);
    expect(probe('http://example.com/').status).toBe(7);
  });
  it('runs as non-root on a read-only root filesystem', () => {
    const id = run(['--entrypoint', 'id', IMG, '-u']);
    expect(id.status).toBe(0);
    expect(id.stdout.trim()).not.toBe('0');
    expect(run(['--entrypoint', 'sh', IMG, '-c', 'touch /usr/ro-probe']).status).not.toBe(0);
  });
  it('the work tmpfs is writable (jobs can run)', () => {
    expect(run(['--entrypoint', 'sh', IMG, '-c', 'touch /work/ok']).status).toBe(0);
  });
});
