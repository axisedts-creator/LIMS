// AG-T01 tests: agent module skeleton, toolchain pin, CI scripts.
// Run: node --test apps/bridge-agent/__tests__/ag-t01.test.mjs
// Spec: 02-TRD §2.1 (pins), §5.7 (TLS gate), §5.11 (nonprod tag), §16 CR-C7-013 (job commands).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync,
  writeFileSync, copyFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/bridge-agent
const p = (...s) => join(ROOT, ...s);
const read = (...s) => readFileSync(p(...s), 'utf8');
const BASH = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const fwd = (x) => x.replace(/\\/g, '/');
const sh = (script, args, opts = {}) =>
  spawnSync(BASH, [fwd(script), ...args], { encoding: 'utf8', timeout: 120000, ...opts });

function goFilesUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) out.push(...goFilesUnder(f));
    else if (f.endsWith('.go')) out.push(f);
  }
  return out;
}

describe('go.mod: module + toolchain pin (TRD §2.1)', () => {
  test('go.mod exists with a module line', () => {
    assert.ok(existsSync(p('go.mod')), 'apps/bridge-agent/go.mod missing');
    assert.match(read('go.mod'), /^module\s+\S+/m);
  });

  test('go >= 1.26 and toolchain line pinned (>= go directive)', () => {
    const mod = read('go.mod');
    const g = mod.match(/^go\s+(1\.(\d+)\.(\d+))\s*$/m);
    const t = mod.match(/^toolchain\s+go(1\.(\d+)\.(\d+))\s*$/m);
    assert.ok(g, '`go 1.26.x` directive (with patch) missing');
    assert.ok(t, '`toolchain go1.26.x` directive missing');
    assert.ok(Number(g[2]) >= 26, `go directive ${g[1]} < 1.26`);
    assert.ok(Number(t[2]) >= 26, `toolchain ${t[1]} < 1.26`);
    const gv = [Number(g[2]), Number(g[3])];
    const tv = [Number(t[2]), Number(t[3])];
    assert.ok(
      tv[0] > gv[0] || (tv[0] === gv[0] && tv[1] >= gv[1]),
      `toolchain ${t[1]} must be >= go directive ${g[1]}`,
    );
  });

  test('modernc.org/sqlite is pinned to exactly v1.61.1', () => {
    assert.match(read('go.mod'), /modernc\.org\/sqlite\s+v1\.61\.1\b/);
    assert.ok(existsSync(p('go.sum')), 'go.sum missing (pin must be resolved)');
    assert.match(read('go.sum'), /^modernc\.org\/sqlite v1\.61\.1 h1:/m);
    assert.match(read('go.sum'), /^modernc\.org\/sqlite v1\.61\.1\/go\.mod h1:/m);
  });

  test('other pinned libs, if present, match TRD §2.1', () => {
    const mod = read('go.mod');
    const x = mod.match(/golang\.org\/x\/sys\s+(v\S+)/);
    const s = mod.match(/go\.bug\.st\/serial\s+(v\S+)/);
    if (x) assert.equal(x[1], 'v0.49.0');
    if (s) assert.equal(s[1], 'v1.8.0');
  });

  test('no CGo-requiring sqlite driver', () => {
    assert.doesNotMatch(read('go.mod'), /mattn\/go-sqlite3/);
  });
});

describe('cmd/*/main.go stubs', () => {
  const cmdDir = p('cmd');
  const mains = () => existsSync(cmdDir)
    ? readdirSync(cmdDir).filter((d) => existsSync(join(cmdDir, d, 'main.go'))) : [];

  test('at least one cmd/<name>/main.go with package main + func main', () => {
    const m = mains();
    assert.ok(m.length >= 1, 'no apps/bridge-agent/cmd/*/main.go found');
    for (const d of m) {
      const src = readFileSync(join(cmdDir, d, 'main.go'), 'utf8');
      assert.match(src, /^package main\b/m, `${d}: not package main`);
      assert.match(src, /^func main\(\)/m, `${d}: no func main()`);
    }
  });

  test('sqlite driver is in the build graph (blank or named import)', () => {
    const hit = goFilesUnder(ROOT).some((f) =>
      /"modernc\.org\/sqlite"/.test(readFileSync(f, 'utf8')));
    assert.ok(hit, 'no .go file imports modernc.org/sqlite; the pin would not be proven by a build');
  });

  test('skeleton itself has no InsecureSkipVerify outside _test.go', () => {
    for (const f of goFilesUnder(ROOT).filter((x) => !x.endsWith('_test.go'))) {
      assert.doesNotMatch(readFileSync(f, 'utf8'), /InsecureSkipVerify/, f);
    }
  });
});

describe('build/ci.sh contract (CR-C7-013)', () => {
  const ci = () => p('build', 'ci.sh');

  test('exists, LF-only, has shebang', () => {
    assert.ok(existsSync(ci()), 'build/ci.sh missing');
    const raw = readFileSync(ci(), 'utf8');
    assert.ok(raw.startsWith('#!'), 'missing shebang');
    assert.ok(!raw.includes('\r'), 'CRLF line endings break bash on CI');
  });

  test('implements build, sessions, tls-gate, release-tag-check', () => {
    const s = readFileSync(ci(), 'utf8');
    for (const sub of ['build', 'sessions', 'tls-gate', 'release-tag-check']) {
      assert.match(s, new RegExp(`\\b${sub}\\b`), `subcommand ${sub} missing`);
    }
  });

  test('build step runs vet, staticcheck, gofmt -l, static windows/amd64 build, go test', () => {
    const s = readFileSync(ci(), 'utf8');
    assert.match(s, /go vet/);
    assert.match(s, /staticcheck/);
    assert.match(s, /gofmt -l/);
    assert.match(s, /GOOS=windows/);
    assert.match(s, /GOARCH=amd64/);
    assert.match(s, /CGO_ENABLED=0/);
    assert.match(s, /go build[^\n]*\.\/cmd\/\.\.\./);
    assert.match(s, /go test/);
    assert.match(s, /set -[a-z]*e/, 'must fail fast (set -e)');
  });

  test('release-tag-check refuses nonprod builds', () => {
    assert.match(readFileSync(ci(), 'utf8'), /nonprod/);
  });

  test('unknown subcommand exits non-zero', () => {
    const r = sh(ci(), ['definitely-not-a-subcommand']);
    assert.notEqual(r.status, 0);
  });

  test('release-tag-check: no arg or missing file exits non-zero', () => {
    assert.notEqual(sh(ci(), ['release-tag-check']).status, 0);
    assert.notEqual(sh(ci(), ['release-tag-check', join(tmpdir(), 'no-such-agent.exe')]).status, 0);
  });

  test('tls-gate passes on the real tree', () => {
    const r = sh(ci(), ['tls-gate']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  describe('tls-gate behaviour on a planted tree (script resolves root from its own location)', () => {
    let tmp;
    const plant = (rel, body) => {
      const f = join(tmp, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, body);
    };
    const gate = () => sh(join(tmp, 'build', 'ci.sh'), ['tls-gate'], { cwd: tmp });

    before(() => {
      tmp = mkdtempSync(join(tmpdir(), 'agt01-'));
      mkdirSync(join(tmp, 'build'));
      copyFileSync(ci(), join(tmp, 'build', 'ci.sh'));
    });
    after(() => rmSync(tmp, { recursive: true, force: true }));

    test('clean tree passes', () => {
      plant('internal/ok/ok.go', 'package ok\n');
      assert.equal(gate().status, 0);
    });
    test('InsecureSkipVerify only in _test.go passes', () => {
      plant('internal/ok/ok_test.go', 'package ok\nvar _ = tlsCfg{InsecureSkipVerify: true}\n');
      assert.equal(gate().status, 0);
    });
    test('InsecureSkipVerify in non-test .go fails', () => {
      plant('internal/bad/bad.go', 'package bad\nvar c = tlsCfg{InsecureSkipVerify: true}\n');
      const r = gate();
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /InsecureSkipVerify|bad\.go/);
    });
    test('fails also when hidden in a nested cmd/ dir and when spaced `InsecureSkipVerify : true`', () => {
      rmSync(join(tmp, 'internal', 'bad'), { recursive: true, force: true });
      assert.equal(gate().status, 0, 'precondition: bad file removed');
      plant('cmd/x/y/z.go', 'package main\nfunc f(){ _ = tlsCfg{InsecureSkipVerify : true} }\n');
      assert.notEqual(gate().status, 0);
    });
  });
});

describe('build/ci-windows.ps1 contract', () => {
  test('exists and runs the windows-tagged tests for secrets, svc, update', () => {
    assert.ok(existsSync(p('build', 'ci-windows.ps1')), 'build/ci-windows.ps1 missing');
    const s = read('build', 'ci-windows.ps1');
    assert.match(s, /go test -tags windows/);
    for (const pkg of ['secrets', 'svc', 'update']) {
      assert.match(s, new RegExp(`\\./internal/${pkg}/\\.\\.\\.`), `${pkg} package missing`);
    }
    assert.match(s, /\$LASTEXITCODE/, 'must propagate native exit code');
  });
});

describe('build test: windows/amd64 static binary (done_when)', () => {
  let out;
  let goOk;
  before(() => {
    goOk = spawnSync('go', ['version'], { encoding: 'utf8' });
    out = mkdtempSync(join(tmpdir(), 'agt01-bin-'));
  });
  after(() => rmSync(out, { recursive: true, force: true }));

  test('go toolchain is available and >= 1.26', () => {
    assert.equal(goOk.status, 0, 'go not found on PATH (install pinned toolchain)');
    const m = goOk.stdout.match(/go1\.(\d+)/);
    assert.ok(m && Number(m[1]) >= 26, goOk.stdout);
  });

  test('GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/... succeeds', () => {
    const r = spawnSync('go', ['build', '-o', out + '/', './cmd/...'], {
      cwd: ROOT, encoding: 'utf8', timeout: 540000,
      env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const exes = readdirSync(out).filter((f) => f.endsWith('.exe'));
    assert.ok(exes.length >= 1, 'no .exe produced');
    for (const e of exes) {
      const b = readFileSync(join(out, e));
      assert.equal(b.toString('latin1', 0, 2), 'MZ', `${e}: not a PE file`);
      const pe = b.readUInt32LE(0x3c);
      assert.equal(b.toString('latin1', pe, pe + 4), 'PE\0\0');
      assert.equal(b.readUInt16LE(pe + 4), 0x8664, `${e}: not amd64`);
      const txt = b.toString('latin1');
      assert.match(txt, /CGO_ENABLED=0/, `${e}: not built CGO-free`);
      assert.match(txt, /modernc\.org\/sqlite\s+v1\.61\.1/, `${e}: sqlite v1.61.1 not linked`);
      assert.doesNotMatch(txt, /\bnonprod\b.*-tags|-tags=[^\n]*nonprod/, `${e}: default build must not carry nonprod`);
    }
  });
});
