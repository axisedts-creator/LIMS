// ADMINPACK-2 (LD-260, LD-254 FOUNDER STEP): static checks that services/api/package.json carries the `identity:apply-role-pack` script
// and that the founder runbook exists with the exact command, env var names and result reading. Static only; synthetic; no secrets.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const API = join(REPO_ROOT, 'services', 'api');
const scripts = (JSON.parse(readFileSync(join(API, 'package.json'), 'utf8')).scripts ?? {}) as Record<string, string>;
const BOOT = scripts['identity:bootstrap-platform-admin'];
const APPLY = scripts['identity:apply-role-pack'];
const LOADER = 'node --import ../../tools/node-ts/register.mjs ';
const FILE = 'src/modules/identity/cli/apply-role-pack.ts';

// runbook: docs/runbooks/apply-role-pack.md when docs/runbooks exists, else the notes file
const RUNBOOK = existsSync(join(REPO_ROOT, 'docs', 'runbooks')) ? join(REPO_ROOT, 'docs', 'runbooks', 'apply-role-pack.md')
  : join(REPO_ROOT, '.orchestra', 'notes', 'ADMINPACK-2-runbook.md');

describe('ADMINPACK-2 package.json script identity:apply-role-pack', () => {
  it('the bootstrap script it is modelled on is still there', () => { expect(BOOT).toBeTypeOf('string'); });
  it('script exists', () => { expect(APPLY, 'missing script identity:apply-role-pack in services/api/package.json').toBeTypeOf('string'); });
  it('uses the same node-ts loader and points at the CLI file', () => { expect(APPLY).toBe(`${LOADER}${FILE}`); });
  it('the CLI file it points at exists', () => {
    const rel = (APPLY ?? '').split(/\s+/).pop() ?? '';
    expect(rel).toBe(FILE);
    expect(existsSync(join(API, rel))).toBe(true);
  });
  it('differs from the bootstrap script only in the file name', () => {
    expect(APPLY).toBeTypeOf('string');
    expect((BOOT ?? '').replace('bootstrap-platform-admin.ts', 'apply-role-pack.ts')).toBe(APPLY);
  });
  it('adds nothing else: scripts other than the new one keep their values', () => {
    expect(Object.keys(scripts).sort()).toEqual(['identity:apply-role-pack', 'identity:bootstrap-platform-admin', 'start', 'test', 'typecheck']);
    expect(scripts.test).toBe('vitest run');
    expect(scripts.typecheck).toBe('tsc -p tsconfig.json --noEmit');
  });
});

describe('ADMINPACK-2 founder runbook', () => {
  const md = existsSync(RUNBOOK) ? readFileSync(RUNBOOK, 'utf8') : '';
  const norm = md.replace(/\s+/g, ' ');
  it('exists', () => { expect(existsSync(RUNBOOK), `missing runbook ${RUNBOOK}`).toBe(true); });
  it('states the exact command for both packs from the repository root', () => {
    expect(norm).toContain('pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabcorp_default');
    expect(norm).toContain('pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabassist_standard');
  });
  it('names the libpq environment variables the CLI reads (names only)', () => {
    for (const v of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) expect(md).toContain(v);
  });
  it('explains how to find the tenant uuid and how to read created/updated/unchanged', () => {
    expect(md).toMatch(/tenant/i); expect(md).toMatch(/uuid/i);
    for (const w of ['created', 'updated', 'unchanged']) expect(md).toContain(w);
  });
  it('says the administrator must hold the pack role and sign in again', () => {
    expect(md).toMatch(/sign in again|sign-in again|log in again/i);
    expect(md).toMatch(/administrator/i);
  });
  it('contains no secret value, password assignment or real host', () => {
    expect(md).not.toMatch(/PG(PASSWORD|HOST|USER|DATABASE|PORT)\s*=\s*[^\s<`'"]/);   // placeholders in <...> are fine; real values are not
    expect(md).not.toMatch(/postgres(ql)?:\/\/\S+@/i);
    expect(md).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(md).not.toMatch(/-----BEGIN|AKIA[0-9A-Z]{12}|sk-[A-Za-z0-9]{16}/);
    expect(md).not.toMatch(/\b[a-z0-9-]+\.(com|net|org|io|in|np)\b/i);
  });
  it('the CLI itself is unchanged: still reads only the libpq PG* environment', () => {
    const cli = readFileSync(join(API, FILE), 'utf8');
    expect(cli).toContain('libpq PG* environment');
    expect(cli).not.toMatch(/process\.env\./);
  });
});
