// C2-T28 the two CI scripts of 02-TRD §13 "CI jobs for C0-0A" (08 A13 P-14; CR-C2-019; jobs already wired in .github/workflows/pr.yml).
//   identity-service-key-grep (CR-C2-014): `node services/api/src/modules/identity/__tests__/ci/service-key-grep.mjs` — exit non-zero if the GoTrue service-key env var is READ outside
//     services/api/src/modules/identity/gotrue/gateway.http.ts (07-SECURITY service-key confinement).
//   identity-no-dead-letter-sql (D-T12): `node tools/lint/no-foreign-schema-sql.ts --fixture <…>/no-dead-letter-sql.fixture.json` — C2 owns only the fixture; the runner is C0-0A's.
// ASSUMED (spec silent): service-key-grep.mjs takes an optional first argument = tree root to scan (default: the repo root, derived from the script's own location), like analytics' no-commission.sh;
//   it scans services/, apps/, packages/ source files (.ts .tsx .js .mjs .cjs .dart .go .py .sh .yml .yaml, not .md), skips test files (**/__tests__/**, *.test.*; e.g. gotrue/__tests__/mapping.test.ts names the variable in a regex) and node_modules, prints the offending path, exits 1.
//   A "read" = the variable name appearing in code outside gateway.http.ts (env access in any form, incl. bracket access and destructuring).
// Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/ci
// Fails now: service-key-grep.mjs and the fixture do not exist; 6 identity files (handlers/*, cli/bootstrap-platform-admin.ts) read the variable themselves — they must obtain the gateway from gotrue/gateway.http.ts instead.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const KEY = ['LIMS', 'IDENTITY', 'GOTRUE', 'SERVICE', 'KEY'].join('_');   // never spelled whole in this file: the real-repo scan must stay clean
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'service-key-grep.mjs');
const FIXTURE = join(HERE, 'no-dead-letter-sql.fixture.json');
const GATEWAY = 'services/api/src/modules/identity/gotrue/gateway.http.ts';
const run = (root?: string) => spawnSync(process.execPath, root ? [SCRIPT, root] : [SCRIPT], { encoding: 'utf8', timeout: 120_000 });

const roots: string[] = [];
const scratch = () => { const r = mkdtempSync(join(tmpdir(), 'lims-skg-')); roots.push(r); return r; };
const put = (root: string, rel: string, text: string) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('identity-service-key-grep (CR-C2-014)', () => {
  it('the script exists', () => { expect(existsSync(SCRIPT), SCRIPT).toBe(true); });

  it('the real repo is clean: exit 0 (only gotrue/gateway.http.ts reads the service key)', () => {
    const r = run();
    expect(r.error).toBeUndefined();
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('a tree with no service-key read, and a tree where only gateway.http.ts reads it, exit 0', () => {
    const empty = scratch();
    put(empty, 'services/api/src/a.ts', 'export const a = 1;\n');
    expect(run(empty).status).toBe(0);
    const ok = scratch();
    put(ok, GATEWAY, `export const key = process.env['${KEY}'];\n`);
    put(ok, 'services/api/src/modules/identity/handlers/x.ts', "export const url = process.env['LIMS_IDENTITY_GOTRUE_URL'];\n");   // other vars are fine
    put(ok, 'services/api/src/modules/identity/gotrue/mapping.md', `Env: \`${KEY}\`\n`);                                                  // docs may name it
    expect(run(ok).status).toBe(0);
  });

  it.each([
    ['dot access in a handler', 'services/api/src/modules/identity/handlers/a.ts', `const k = process.env.${KEY};\n`],
    ['bracket access in a handler', 'services/api/src/modules/identity/handlers/b.ts', `const k = process.env['${KEY}'] ?? '';\n`],
    ['destructuring', 'services/api/src/modules/identity/service/c.ts', `const { ${KEY}: k } = process.env;\n`],
    ['another module', 'services/api/src/modules/billing/d.ts', `const k = process.env.${KEY};\n`],
    ['the worker', 'services/worker/src/jobs/identity/tasks/e.ts', `const k = process.env.${KEY};\n`],
    ['an app (.mjs)', 'apps/web/src/server/f.mjs', `export const k = process.env.${KEY};\n`],
    ['a package (.js)', 'packages/shared-ts/src/g.js', `module.exports = process.env.${KEY};\n`],
    ['the sibling file next to the gateway', 'services/api/src/modules/identity/gotrue/gateway.fake.ts', `const k = process.env.${KEY};\n`],
    ['a same-named file elsewhere', 'services/api/src/modules/billing/gotrue/gateway.http.ts', `const k = process.env.${KEY};\n`],
  ])('planted read: %s -> exit non-zero, offending path printed', (_n, rel, text) => {
    const root = scratch();
    put(root, GATEWAY, `export const key = process.env['${KEY}'];\n`);   // the allowed read must not mask the planted one
    put(root, rel, text);
    const r = run(root);
    expect(r.error).toBeUndefined();
    expect(r.status, 'must fail').not.toBe(0);
    expect(r.status).not.toBeNull();
    expect((r.stdout + r.stderr).replace(/\\/g, '/')).toContain(rel);
  });

  it('never prints a key VALUE (the scan reports paths only)', () => {
    const root = scratch();
    put(root, 'services/api/src/h.ts', `const k = process.env.${KEY}; const v = 'svc-key-PLANTED-VALUE-123';\n`);
    const r = run(root);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain('svc-key-PLANTED-VALUE-123');
  });
});

describe('identity-no-dead-letter-sql fixture (D-T12)', () => {
  it('no-dead-letter-sql.fixture.json exists and is a non-empty JSON object/array (runner = C0-0A tools/lint/no-foreign-schema-sql.ts --fixture)', () => {
    expect(existsSync(FIXTURE), FIXTURE).toBe(true);
    const j = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(j !== null && typeof j === 'object' && Object.keys(j).length > 0).toBe(true);
  });
});
