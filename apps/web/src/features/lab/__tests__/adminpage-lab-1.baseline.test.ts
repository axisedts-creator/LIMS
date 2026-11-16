// ADMINPAGE-LAB-1: rs-c4.baseline.json (tester-owned, apps/web/src/features/frontdesk/__tests__/) changes "only where the signature of a touched manifest moved".
// rs-c4 covers the frontdesk and billing features only (logic hashes: frontdesk + billing nav.manifest.ts; signatures: their feature and app folders). This task edits the lab
// manifest, lab pages, core/i18n/messages.ts and contracts/routes.yaml, none of which is in the signature, so the baseline must stay byte-identical to the tree before the task.
// If the writer's change ever moves it, the tester regenerates it with `node apps/web/src/features/frontdesk/__tests__/rs-c4.signature.ts --write` and updates this test with the reason.
// The existing rs-c4.static.test.ts (run by the verify command) proves the baseline equals the tree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = import.meta.dirname; // apps/web/src/features/lab/__tests__
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..');
const BASE = '0a54fee0f';
const REL = 'apps/web/src/features/frontdesk/__tests__/rs-c4.baseline.json';
const norm = (s: string) => s.replace(/\r\n/g, '\n');

describe('rs-c4.baseline.json is untouched by the lab pages', () => {
  it('byte-identical (CRLF-insensitive) to the baseline committed before this task', () => {
    const was = norm(execFileSync('git', ['show', `${BASE}:${REL}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const now = norm(readFileSync(join(ROOT, REL), 'utf8'));
    expect(now).toBe(was);
  });

  it('no lab file is in the baseline (it must not silently start covering this feature)', () => {
    const text = readFileSync(join(ROOT, REL), 'utf8');
    expect(text).not.toMatch(/features\/lab|\(staff\)\/lab/);
  });
});
