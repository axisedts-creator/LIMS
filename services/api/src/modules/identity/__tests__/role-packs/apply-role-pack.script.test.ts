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
  // review item 3: core.tenants is FORCE RLS, so a plain psql lookup as lims_api returns zero rows; the runbook must name a lookup that works
  it('names a tenant lookup that works under FORCE RLS (platform console, or psql only with BYPASSRLS)', () => {
    expect(md).toContain('/platform/tenants');
    if (/psql/i.test(md)) expect(md).toMatch(/BYPASSRLS/);
  });
  // review item 2: PGUSER must be the API login role, not "a role allowed to write"
  it('names lims_api as the PGUSER role (role name only)', () => { expect(md).toContain('lims_api'); });
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

// ADMINPACK-4 (LD-265): `.orchestra/notes/ADMINPACK-4-runbook.md` replaces the connection steps of the ADMINPACK-2 / -3 runbooks for the founder.
// Static checks only. The PowerShell block must run as pasted: no <placeholder>, no literal secret, password only through Read-Host -AsSecureString.
describe('ADMINPACK-4 founder runbook (.orchestra/notes/ADMINPACK-4-runbook.md)', () => {
  const R4 = join(REPO_ROOT, '.orchestra', 'notes', 'ADMINPACK-4-runbook.md');
  const md = existsSync(R4) ? readFileSync(R4, 'utf8') : '';
  const norm = md.replace(/\s+/g, ' ');
  const blocks = [...md.matchAll(/```(?:powershell|ps1|pwsh)\s*\n([\s\S]*?)```/gi)].map((m) => m[1]!);
  const ps = blocks.join('\n');
  const BASE = 'pnpm --filter @lims/api identity:apply-role-pack --tenant $tenant --pack elabcorp_default --add-missing corp_admin';

  it('exists and has at least one PowerShell code block', () => { expect(existsSync(R4), `missing ${R4}`).toBe(true); expect(blocks.length).toBeGreaterThan(0); });
  it('says it replaces the connection steps of the ADMINPACK-2 and ADMINPACK-3 runbooks', () => { expect(md).toContain('ADMINPACK-2'); expect(md).toContain('ADMINPACK-3'); expect(md).toMatch(/replace/i); });
  it('reads SUPABASE_POOLER_HOST and SUPABASE_PROJECT_REF from C:\\LIMS-cloud-secrets\\supabase-test.env', () => {
    expect(ps).toContain('C:\\LIMS-cloud-secrets\\supabase-test.env'); expect(ps).toContain('SUPABASE_POOLER_HOST'); expect(ps).toContain('SUPABASE_PROJECT_REF');
    expect(ps).toMatch(/Get-Content/i);
  });
  it('sets PGHOST, PGPORT 5432, PGDATABASE postgres, PGSSLMODE require, PGUSER lims_api.<ref> (from the variable)', () => {
    expect(ps).toMatch(/\$env:PGHOST\s*=\s*\S/); expect(ps).toMatch(/\$env:PGPORT\s*=\s*['"]?5432['"]?/); expect(ps).toMatch(/\$env:PGDATABASE\s*=\s*['"]postgres['"]/);
    expect(ps).toMatch(/\$env:PGSSLMODE\s*=\s*['"]require['"]/); expect(ps).toMatch(/\$env:PGUSER\s*=\s*"lims_api\.\$\{?\w+\}?"/);
  });
  it('prompts for the password with Read-Host -AsSecureString; PGPASSWORD is never a literal and never printed', () => {
    expect(ps).toMatch(/Read-Host[^\n]*-AsSecureString/i);
    expect(ps).toContain('PGPASSWORD'); expect(ps).not.toMatch(/PGPASSWORD\s*=\s*['"][^$'"]/);
    expect(ps).not.toMatch(/(Write-Host|Write-Output|Out-File|Set-Content|Add-Content|echo)[^\n]*(PGPASSWORD|\$pw|\$pass)/i);
  });
  it('sets NODE_EXTRA_CA_CERTS to the Supabase CA file and says where to get it (dashboard Database settings, SSL Configuration)', () => {
    expect(ps).toMatch(/\$env:NODE_EXTRA_CA_CERTS\s*=\s*\S/); expect(md).toMatch(/Database settings/i); expect(md).toMatch(/SSL Configuration/i);
    expect(md).toMatch(/\.crt|\.pem|certificate/i);
  });
  it('prompts for the tenant uuid (Read-Host) and the commands use $tenant, not a placeholder', () => {
    expect(ps).toMatch(/\$tenant\s*=\s*Read-Host/i); expect(ps).toContain('--tenant $tenant');
  });
  it('shows --list, then the dry run, then the --yes command (in that order), all from the repository root', () => {
    const list = 'pnpm --filter @lims/api identity:apply-role-pack --tenant $tenant --pack elabcorp_default --list';
    for (const c of [list, BASE, `${BASE} --yes`]) expect(norm).toContain(c);
    expect(norm.indexOf(list)).toBeLessThan(norm.indexOf(`${BASE} --yes`)); expect(norm.indexOf(BASE + ' --yes')).toBeGreaterThan(norm.indexOf(BASE));
    expect(md).toMatch(/repository root|repo root/i);
  });
  it('the PowerShell block has no <placeholder> and no unfilled "..." text', () => {
    expect(ps).not.toMatch(/<[A-Za-z][^>\n]*>/); expect(ps).not.toMatch(/\bYOUR[_ -]|\bTODO\b|\bxxx+\b|\.\.\.\s*$/im);
  });
  it('says the shell window must be closed afterwards (the password lives in its environment)', () => {
    expect(md).toMatch(/close (this|the|that) (PowerShell )?(shell|window|terminal)/i); expect(md).toMatch(/password/i);
  });
  it('explains the refused: reasons (all six) and the db: line, and that --list changes nothing', () => {
    for (const r of ['args', 'role_not_in_pack', 'role_missing_in_lab', 'role_is_system_default', 'unassignable_code', 'privileged_without_mfa']) expect(md).toContain(r);
    expect(md).toMatch(/db:/); expect(md).toMatch(/read-only|changes nothing|writes nothing|nothing is written/i);
  });
  it('contains no secret value, real host, ip address, connection string or key material', () => {
    expect(md).not.toMatch(/postgres(ql)?:\/\/\S+@/i); expect(md).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(md).not.toMatch(/-----BEGIN|AKIA[0-9A-Z]{12}|sk-[A-Za-z0-9]{16}|eyJ[A-Za-z0-9_-]{20,}/); expect(md).not.toMatch(/aws-\d+-[a-z0-9-]+\.pooler/i);
    expect(md).not.toMatch(/PG(PASSWORD|HOST|USER)\s*=\s*['"]?[A-Za-z0-9][^\s$'"]*['"]?\s*$/m);
  });
});

describe('ADMINPACK-4 package scope', () => {
  it('no new package.json script and no new dependency: the script list is the ADMINPACK-2 list', () => {
    expect(Object.keys(scripts).sort()).toEqual(['identity:apply-role-pack', 'identity:bootstrap-platform-admin', 'start', 'test', 'typecheck']);
    expect(APPLY).toBe(`${LOADER}${FILE}`);
  });
});
