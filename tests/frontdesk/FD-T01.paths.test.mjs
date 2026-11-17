// FD-T01 — "CI path check green": the six skeleton files exist, are owned by C4, and pass CI gate 1 (tools/lint/check-paths.ts)
// for a c04/* branch; the gate still fails closed for a core path. Run: node --test tests/frontdesk/FD-T01.paths.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FILES = [
  'services/api/src/modules/frontdesk/index.ts',
  'services/api/src/modules/frontdesk/permissions.ts',
  'services/api/src/modules/frontdesk/config.ts',
  'services/api/src/modules/frontdesk/handlers/index.ts',
  'services/worker/src/jobs/frontdesk/index.ts',
  'apps/web/src/features/frontdesk/nav.manifest.ts',
];
const tmp = mkdtempSync(join(tmpdir(), 'fd-t01-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function gate(files, branch = 'c04/frontdesk-skeleton') {
  const f = join(tmp, `files-${n}.txt`), b = join(tmp, `body-${n++}.txt`);
  writeFileSync(f, files.join('\n') + '\n');
  writeFileSync(b, 'FD-T01 module skeletons\n');
  const r = spawnSync(process.execPath, [join(root, 'tools/lint/check-paths.ts'), '--branch', branch, '--files', f, '--body', b], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

for (const f of FILES) test(`file exists: ${f}`, () => assert.ok(existsSync(join(root, f)), `${f} must exist`));

test('path check passes for the six FD-T01 files on a C4 branch', () => {
  const r = gate(FILES);
  assert.equal(r.code, 0, r.out);
});

test('path check rejects the same files from another chunk branch (ownership is C4)', () => {
  const r = gate(FILES, 'c05/not-mine');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /owned by C4/);
});

test('path check still rejects a core path from a C4 branch (no ownership leak)', () => {
  const r = gate([...FILES, 'services/api/src/core/module.ts']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /services\/api\/src\/core\/module\.ts/);
});
