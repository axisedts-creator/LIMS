// T0B-SWEEP-1 / LD-272: db/tests/run-suites.sh LIMS_PG_PREPARE_ONLY=1 mode, proved with a stub `docker`/`npx` on PATH (no Docker, no 10 minute run).
// Path A (variable set): prints one LIMS_PG_READY line, exit 0, keeps the container (no `docker rm`), runs no suite.
// Path B (variable unset): unchanged behaviour: lists/runs the suite given as argument, prints "# elapsed", removes the container on exit.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const BASH = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
let bin: string;
let log: string;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  run) echo fakecontainerid ;;
  port) echo "127.0.0.1:55432" ;;
  exec) case "$*" in *"-f db/tests/"*|*"-f $FAKE_SUITE"*) echo "ok 1 - stub" ;; esac ;;
esac
exit 0
`;
const FAKE_NPX = `#!/usr/bin/env bash
echo "npx $*" >> "$FAKE_LOG"
exit 0
`;

function run(env: Record<string, string>, args: string[] = []) {
  writeFileSync(log, '');
  const r = spawnSync(BASH, ['db/tests/run-suites.sh', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, FAKE_LOG: log, FAKE_SUITE: 'db/tests/x.test.sql', LIMS_SKIP_GEN: '1', LIMS_SKIP_SEEDS: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8') };
}

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'sweep-fake-bin-'));
  log = join(bin, 'calls.log');
  for (const [n, body] of [['docker', FAKE_DOCKER], ['npx', FAKE_NPX]] as const) { writeFileSync(join(bin, n), body, { mode: 0o755 }); chmodSync(join(bin, n), 0o755); }
});
afterAll(() => { rmSync(bin, { recursive: true, force: true }); });

describe('run-suites.sh LIMS_PG_PREPARE_ONLY=1', () => {
  it('prints exactly one LIMS_PG_READY <name> <port> <superPw> <apiPw> line and exits 0 before any suite', () => {
    const r = run({ LIMS_PG_PREPARE_ONLY: '1' });
    expect(r.code, r.out).toBe(0);
    const ready = r.out.split('\n').filter((l) => l.startsWith('LIMS_PG_READY'));
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatch(/^LIMS_PG_READY lims_t0b08_\d+ 55432 [A-Za-z0-9]{20} [A-Za-z0-9]{20}$/);
    expect(r.out).not.toMatch(/^# --- /m);
    expect(r.out).not.toMatch(/^# elapsed/m);
  });

  it('keeps the container (EXIT trap removed: no docker rm) and still ran bootstrap, migrations, storage stub', () => {
    const r = run({ LIMS_PG_PREPARE_ONLY: '1' });
    expect(r.calls).not.toMatch(/^docker rm /m);
    expect(r.calls).toMatch(/^docker run -d --name lims_t0b08_/m);
    expect(r.calls).toMatch(/00_roles\.sql/);
    expect(r.calls).toMatch(/CREATE SCHEMA IF NOT EXISTS storage/);
    expect(r.calls).toMatch(/^npx --no-install graphile-worker --schema-only/m);
  });

  it('only the value 1 enables the mode', () => {
    const r = run({ LIMS_PG_PREPARE_ONLY: '0' }, ['db/tests/x.test.sql']);
    expect(r.out).not.toMatch(/LIMS_PG_READY/);
    expect(r.out).toMatch(/^# --- db\/tests\/x\.test\.sql/m);
  });
});

describe('run-suites.sh without LIMS_PG_PREPARE_ONLY (unchanged, dry listing via stub docker)', () => {
  it('runs the listed suite, prints elapsed, exits 0 and removes the container', () => {
    const r = run({}, ['db/tests/x.test.sql']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/LIMS_PG_READY/);
    expect(r.out).toMatch(/^# --- db\/tests\/x\.test\.sql/m);
    expect(r.out).toMatch(/^# elapsed \d+s/m);
    expect(r.calls).toMatch(/^docker rm -f lims_t0b08_/m);
  });
});
