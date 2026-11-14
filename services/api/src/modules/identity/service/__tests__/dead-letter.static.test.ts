// T24 static checks (07-SECURITY D-T12, D-T18; 08 A8.6, A10.4): C2 has no SQL, repository or grant on core.dead_letters; the __platform policies stay tenant-rows-only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const mod = join(dirname(fileURLToPath(import.meta.url)), '..', '..');   // modules/identity
const service = join(mod, 'service', 'dead-letter.service.ts');
const OPS = ['listDeadLetters', 'getDeadLetter', 'replayDeadLetter', 'discardDeadLetter'];
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === '__tests__' || f === 'node_modules' ? [] : walk(p)) : /\.ts$/.test(f) ? [p] : []; });
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sqlLines = (s: string) => code(s).split(/\r?\n/).filter((l) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/.test(l) && /(core|identity|audit|app)\./.test(l));

describe('D-T12 single write path: dead-letter.service.ts + the four handlers', () => {
  const s = code(read(service));
  it('the service exists, holds no SQL, imports no repository and no db driver, reads no env', () => {
    expect(existsSync(service)).toBe(true);
    expect(sqlLines(s)).toEqual([]); expect(s).not.toMatch(/from\s+['"][^'"]*repository\//); expect(s).not.toMatch(/from\s+['"](pg|postgres|slonik|kysely)['"]/);
    expect(s).not.toMatch(/\.query\s*\(/); expect(s).not.toMatch(/process\.env/);
  });
  it('it calls only ctx.core.deadLetters.{list,get,replay,discard} and authorises with PlatformAuthz.assertPlatform(platform.dead_letter.manage); never IdentityPort.assertRole', () => {
    for (const m of ['list', 'get', 'replay', 'discard']) expect(s).toMatch(new RegExp(`core\\.deadLetters\\.${m}\\s*\\(`));
    expect(s).toMatch(/assertPlatform\s*\(/); expect(s).toContain('platform.dead_letter.manage'); expect(s).not.toMatch(/assertRole\s*\(/);
  });
  it('the view trail uses dead_letter.view / dead_letter_viewed; the free-text note and job payload are never logged', () => {
    expect(s).toContain('dead_letter.view'); expect(s).toContain('dead_letter_viewed'); expect(s).toMatch(/withTenantScope\s*\(/);
    expect(s).not.toMatch(/log\.(info|warn|error|debug)\([^)]*(reasonText|reason_text|jobPayload|job_payload)/);
    expect(s).not.toMatch(/job_?payload/i);   // the service neither reads nor names the payload: it whitelists the DeadLetterRow keys
  });
  it('the dead-letter operations are NOT on the core withTenantScope allowlist for writes beyond getDeadLetter (replay/discard run under platform claims in core)', () => {
    const allow = read(join(mod, '..', '..', 'core', 'db', 'allowlists.ts'));
    expect(allow).toMatch(/['"]getDeadLetter['"]/);   // 08 A25 D-214: the one tenant-scope write is the dead_letter.view trail
    for (const op of ['replayDeadLetter', 'discardDeadLetter', 'listDeadLetters']) expect(allow).not.toMatch(new RegExp(`['"]${op}['"]`));
  });
  describe.each(OPS)('handler %s', (op) => {
    const f = join(mod, 'handlers', `${op}.ts`); const t = code(read(f));
    it('exists, holds no SQL, does not authorise on its own, reads no env, imports no repository', () => {
      expect(existsSync(f)).toBe(true); expect(sqlLines(t)).toEqual([]); expect(t).not.toMatch(/assertRole\s*\(/); expect(t).not.toMatch(/process\.env/); expect(t).not.toMatch(/repository\//);
    });
    it('is registered in handlers/index.ts (imported and in the implemented map)', () => {
      const idx = read(join(mod, 'handlers', 'index.ts'));
      expect(idx).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${op}\\b[^}]*\\}\\s*from\\s*'\\./${op}\\.js'`)); expect(code(idx)).toMatch(new RegExp(`implemented[\\s\\S]*\\b${op}\\b[\\s\\S]*\\};`));
    });
  });
});

describe('D-T12 repo-wide: no SQL naming core.dead_letters / dl_* DEFINERs in modules/** (only services/api/src/core/**)', () => {
  it('nothing under services/api/src/modules (non-test) names core.dead_letters or app.dl_', () => {
    const root = join(mod, '..');
    const hits = walk(root).filter((p) => /core\.dead_letters|app\.dl_(list_platform|resolve|insert_platform)/.test(code(read(p)))).map((p) => relative(root, p));
    expect(hits).toEqual([]);
  });
  it("C2's own SQL (db/migrations/*identity*, db/policies/identity*.sql, db/grants) has no GRANT on core.dead_letters", () => {
    const dirs = ['db/migrations', 'db/policies', 'db/grants'].map((d) => join(REPO_ROOT, d)).filter(existsSync);
    const files = dirs.flatMap((d) => readdirSync(d).map((f) => join(d, f)).filter((p) => /\.sql$/.test(p) && statSync(p).isFile()));
    const bad: string[] = [];
    for (const p of files) {
      const rel = relative(REPO_ROOT, p).replace(/\\/g, '/');
      if (!/identity|C2/i.test(rel)) continue;   // C0's grants (core.sql, core__*) are C0's, not C2's
      const sql = read(p).replace(/--.*$/gm, '');
      if (/\bGRANT\b[^;]*\bON\b[^;]*core\.dead_letters/i.test(sql)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});

describe('D-T18 __platform policies on core.dead_letters admit tenant rows only (08 A10.4; behaviour proven in db/tests T0B-05/T0B-08/T0B-10.C2_policies)', () => {
  const sql = read(join(REPO_ROOT, 'db', 'policies', 'core.sql')).replace(/--.*$/gm, '');
  const stmts = sql.split(';').map((x) => x.replace(/\s+/g, ' ').trim());
  const pol = (name: string) => stmts.filter((x) => new RegExp(`CREATE POLICY ${name}\\b`).test(x));
  it.each(['dead_letters__select__platform', 'dead_letters__update__platform'])('%s is for lims_app, USING tenant_id IS NOT NULL AND the platform-actor test', (name) => {
    const p = pol(name); expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/TO lims_app/); expect(p[0]).toMatch(/USING \(tenant_id IS NOT NULL AND \(SELECT app\.is_platform_actor\(\)\)\)/);
    if (/FOR UPDATE/.test(p[0]!)) expect(p[0]).toMatch(/WITH CHECK \(tenant_id IS NOT NULL AND \(SELECT app\.is_platform_actor\(\)\)\)/);
  });
  it('there is no INSERT / DELETE __platform policy and no policy that lets lims_app see NULL-tenant rows', () => {
    expect(pol('dead_letters__(insert|delete)__platform')).toHaveLength(0);
    const appPolicies = stmts.filter((x) => /CREATE POLICY dead_letters__\w+ ON core\.dead_letters/.test(x) && /TO lims_app/.test(x));
    for (const p of appPolicies) expect(p).not.toMatch(/tenant_id IS NULL/);
  });
});
