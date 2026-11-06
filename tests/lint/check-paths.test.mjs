// T0A-02: path-ownership gate (CI gate 1) + CR-reference check + CODEOWNERS generation.
// Run: node --test tests/lint/check-paths.test.mjs
//
// CLI contract the implementation must follow (spec gives only `--branch $HEAD_REF`; the rest is a test-side choice):
//   node tools/lint/check-paths.ts --branch <HEAD_REF> --files <file> --body <file>
//     --files : newline-separated changed paths, repo-relative (`git diff --name-only --no-renames base...head`)
//     --body  : PR body text file
//   Owner of a branch: `c<NN>/<topic>` -> C<N> (leading zeros dropped, `c05` -> C5); `c00-0a|b|c|d/<topic>` -> C0-0A..D.
//   Owned paths come from tools/lint/ownership.yaml (most specific rule wins).
//   Exit 0 = pass. Exit 1 = gate failure, message (stdout or stderr) names owner + offending path.
//   Exit != 0 on bad usage / unreadable input / unknown branch prefix (fail closed, never pass).
//   CR check: if any changed path matches db/**, contracts/**, packages/** or **/core/**, the body must contain a line
//   `Refs: CR-C<n>-<nnn>` (one or more ids, comma/space separated); else fail with "contract change without CR reference".
//   Generator: --codeowners-out <file> writes CODEOWNERS from ownership.yaml (and no gate run needed); the committed
//   .github/CODEOWNERS must equal that output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'tools/lint/check-paths.ts');
const tmp = mkdtempSync(join(tmpdir(), 'check-paths-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function run({ branch, files = [], body = '', raw }) {
  assert.ok(existsSync(script), 'tools/lint/check-paths.ts must exist');
  const f = join(tmp, `files-${n}.txt`), b = join(tmp, `body-${n}.txt`);
  n++;
  writeFileSync(f, files.join('\n') + '\n');
  writeFileSync(b, body);
  const args = raw ?? ['--branch', branch, '--files', f, '--body', b];
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const pass = (r) => assert.equal(r.code, 0, `expected pass, got ${r.code}: ${r.out}`);
const fail = (r) => { assert.equal(r.code, 1, `expected gate failure (exit 1), got ${r.code}: ${r.out}`); return r.out; };

const BILLING = 'services/api/src/modules/billing/index.ts';
const LAB = 'services/api/src/modules/lab/index.ts';

// --- AC-0A-1.1 / 1.2 ---
test('AC-0A-1.1 c05/x touching billing fails, names owner C4 and the path', () => {
  const out = fail(run({ branch: 'c05/x', files: [BILLING] }));
  assert.match(out, /\bC4\b/);
  assert.ok(out.includes(BILLING), out);
});

test('AC-0A-1.2 c05/x touching only lab/** passes', () => {
  pass(run({ branch: 'c05/x', files: [LAB, 'services/api/src/modules/lab/sub/deep/a.ts'] }));
});

test('mixed own + foreign: fails, reports only the foreign path', () => {
  const out = fail(run({ branch: 'c05/x', files: [LAB, BILLING] }));
  assert.ok(out.includes(BILLING));
  assert.ok(!out.includes(LAB), 'own path must not be reported as offending');
});

test('owner chunk mismatch the other way: c04/x touching lab names C5', () => {
  const out = fail(run({ branch: 'c04/x', files: [LAB] }));
  assert.match(out, /\bC5\b/);
});

test('c04/topic touching only billing passes', () => {
  pass(run({ branch: 'c04/invoice-cancel', files: [BILLING] }));
});

test('C0 workstreams are separate owners: c00-0a/x touching db/ fails naming C0-0B', () => {
  const out = fail(run({ branch: 'c00-0a/x', files: ['db/migrations/0001_x.sql'], body: 'Refs: CR-C0-001' }));
  assert.match(out, /C0-0B/);
});

test('c00-0a/x touching tools/lint/** passes', () => {
  pass(run({ branch: 'c00-0a/gate', files: ['tools/lint/check-paths.ts'] }));
});

test('path with no owner (gap) fails', () => {
  fail(run({ branch: 'c00-0a/x', files: ['totally/unowned/file.txt'] }));
});

test('empty diff passes', () => {
  pass(run({ branch: 'c05/x', files: [] }));
});

// --- AC-0A-1.3 CR reference ---
const DB = 'db/migrations/0002_y.sql';
test('AC-0A-1.3 db/ change without Refs: CR- fails with the required message', () => {
  const out = fail(run({ branch: 'c00-0b/x', files: [DB], body: 'Adds a column.' }));
  assert.match(out, /contract change without CR reference/);
});

test('contracts/ change without Refs fails; with Refs passes', () => {
  const files = ['contracts/openapi/billing.yaml'];
  assert.match(fail(run({ branch: 'c00-0c/x', files, body: '' })), /contract change without CR reference/);
  pass(run({ branch: 'c00-0c/x', files, body: 'Summary\n\nRefs: CR-C4-003\n' }));
});

test('Refs line: multiple ids, CRLF body, not first line all accepted', () => {
  pass(run({ branch: 'c00-0b/x', files: [DB], body: 'Title\r\n\r\nRefs: CR-C4-003, CR-C5-001\r\n' }));
});

test('malformed Refs rejected: bare "Refs: CR-", wrong id shape, id not on a Refs line', () => {
  for (const body of ['Refs: CR-', 'Refs: CR-C4', 'Refs: none', 'see CR-C4-003 for context', 'Refs:']) {
    fail(run({ branch: 'c00-0b/x', files: [DB], body }));
  }
});

test('packages/** and **/core/** changes also require a CR reference', () => {
  assert.match(fail(run({ branch: 'c00-0a/x', files: ['packages/shared-ts/src/a.ts'], body: '' })),
    /contract change without CR reference/);
  assert.match(fail(run({ branch: 'c02/x', files: ['services/api/src/modules/identity/core/a.ts'], body: '' })),
    /contract change without CR reference/);
  pass(run({ branch: 'c02/x', files: ['services/api/src/modules/identity/core/a.ts'], body: 'Refs: CR-C2-001' }));
});

test('non-contract change needs no CR reference', () => {
  pass(run({ branch: 'c05/x', files: [LAB], body: '' }));
});

test('ownership failure and missing CR both reported when both apply', () => {
  const out = fail(run({ branch: 'c05/x', files: [BILLING, DB], body: '' }));
  assert.match(out, /contract change without CR reference/);
  assert.ok(out.includes(BILLING));
});

// --- adversarial ---
test('spoofed / malformed branch prefixes never pass', () => {
  for (const branch of ['main', 'evil/x', 'c05', 'C05/x', 'c5/x', 'c05-evil/x', 'c99/x', 'c00-0z/x', 'c00/x', 'c05/../c04/x', '', 'refs/heads/c05/x']) {
    const r = run({ branch, files: [LAB] });
    assert.notEqual(r.code, 0, `branch "${branch}" must not pass: ${r.out}`);
  }
});

test('path traversal / backslashes / leading ./ are normalised before matching', () => {
  fail(run({ branch: 'c05/x', files: ['services/api/src/modules/lab/../billing/index.ts'] }));
  fail(run({ branch: 'c05/x', files: ['services\\api\\src\\modules\\billing\\index.ts'] }));
  fail(run({ branch: 'c05/x', files: ['./' + BILLING] }));
  pass(run({ branch: 'c05/x', files: ['./' + LAB] }));
});

test('fail closed: missing args, missing files/body input, unknown flags', () => {
  assert.notEqual(run({ raw: [] }).code, 0);
  assert.notEqual(run({ raw: ['--branch', 'c05/x'] }).code, 0);
  assert.notEqual(run({ raw: ['--branch', 'c05/x', '--bogus'] }).code, 0);
  assert.notEqual(run({ raw: ['--branch', 'c05/x', '--files', join(tmp, 'nope.txt'), '--body', join(tmp, 'nope2.txt')] }).code, 0);
  // db change + unreadable body must not pass
  const f = join(tmp, 'f-only.txt');
  writeFileSync(f, DB + '\n');
  assert.notEqual(run({ raw: ['--branch', 'c00-0b/x', '--files', f, '--body', join(tmp, 'nope.txt')] }).code, 0);
});

test('unrelated text in a Refs-looking line is not an injection hole: path names with spaces/newlines in list are compared literally', () => {
  fail(run({ branch: 'c05/x', files: ['services/api/src/modules/lab/a.ts', 'services/api/src/modules/billing/b ts.ts'] }));
});

// --- CODEOWNERS generation ---
function generate() {
  assert.ok(existsSync(script), 'tools/lint/check-paths.ts must exist');
  const out = join(tmp, `CODEOWNERS-${n++}`);
  const r = spawnSync(process.execPath, [script, '--codeowners-out', out], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `generator failed: ${r.stdout}${r.stderr}`);
  return readFileSync(out, 'utf8');
}
const entries = (txt) => txt.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => l.trim().split(/\s+/));

test('CODEOWNERS: generated header, one owner handle per rule, distinct handles per chunk', () => {
  const txt = generate();
  assert.match(txt, /^#.*generated/im, 'must carry a "generated" header comment');
  const e = entries(txt);
  assert.ok(e.length > 100, `expected a line per ownership rule, got ${e.length}`);
  for (const [pat, ...owners] of e) {
    assert.ok(owners.length >= 1 && owners.every((o) => o.startsWith('@')), `line for ${pat} needs @owner(s)`);
  }
  const find = (frag) => e.find(([p]) => p.includes(frag));
  const billing = find('modules/billing'), lab = find('modules/lab'), db = find('db/'), contracts = find('contracts/');
  for (const [name, row] of Object.entries({ billing, lab, db, contracts })) assert.ok(row, `no CODEOWNERS line for ${name}`);
  const handles = [billing, lab, db, contracts].map((r) => r.slice(1).join(' '));
  assert.equal(new Set(handles).size, 4, `chunks C4, C5, C0-0B, C0-0C need distinct owners: ${handles}`);
  assert.ok(billing[0].startsWith('/'), 'patterns anchored at repo root');
});

test('CODEOWNERS: deterministic and every ownership.yaml pattern is covered', () => {
  assert.equal(generate(), generate());
  const yaml = readFileSync(join(root, 'tools/lint/ownership.yaml'), 'utf8');
  const pats = [...yaml.matchAll(/pattern:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/gm)].map((m) => m[1].replace(/^\//, ''));
  assert.ok(pats.length > 100);
  const lines = entries(generate()).map(([p]) => p.replace(/^\//, ''));
  const missing = pats.filter((p) => !lines.includes(p));
  assert.deepEqual(missing, [], 'ownership patterns missing from CODEOWNERS');
});

test('CODEOWNERS: committed .github/CODEOWNERS equals generated output (no drift)', () => {
  const file = join(root, '.github/CODEOWNERS');
  assert.ok(existsSync(file), '.github/CODEOWNERS must exist');
  assert.equal(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), generate().replace(/\r\n/g, '\n'));
});

test('CODEOWNERS: specific rules come after general ones (last match wins)', () => {
  const pats = entries(generate()).map(([p]) => p);
  // a line that is a strict prefix-glob of another must precede it
  for (let i = 0; i < pats.length; i++) {
    for (let j = 0; j < i; j++) {
      const general = pats[i].replace(/\*\*$/, '');
      if (pats[i].endsWith('/**') && pats[j] !== pats[i] && pats[j].startsWith(general) && pats[j].length > pats[i].length) {
        assert.fail(`${pats[j]} (more specific) appears before ${pats[i]}`);
      }
    }
  }
});
