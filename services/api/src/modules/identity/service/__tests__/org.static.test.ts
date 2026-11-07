// T15 static checks on org.service.ts and the ten handler files (REQ-SEC-040/044; 07-SECURITY P-2, CR-C2-002 allowlist). No DB needed: the default repo's SQL is not
// executed by any test here (no LIMS_TEST_DATABASE_URL harness for T15), so these greps are the only guard on its text.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const svcPath = join(here, '..', 'org.service.ts');
const handlerDir = join(here, '..', '..', 'handlers');
const OPS = ['listBranches', 'createBranch', 'updateBranch', 'deactivateBranch', 'reactivateBranch', 'listCentres', 'createCentre', 'updateCentre', 'deactivateCentre', 'reactivateCentre'];
const src = () => readFileSync(svcPath, 'utf8');
const SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/;
const sqlLines = (s: string) => s.split(/\r?\n/).filter((l) => SQL.test(l) && /(core|identity|audit)\./.test(l));
const stmts = (s: string) => (s.match(/`[^`]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*`|'[^'\n]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'\n]*'/g) ?? []);

describe('org.service.ts text checks', () => {
  it('exists', () => { expect(existsSync(svcPath)).toBe(true); });
  it('no SQL string is built by interpolation (${...}) or concatenation', () => {
    const lines = sqlLines(src()); expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) { expect(l).not.toMatch(/\$\{/); expect(l).not.toMatch(/['"`]\s*\+\s*\w/); }
  });
  it('every statement on core.branches / core.collection_centres names tenant_id (on top of RLS)', () => {
    const t = stmts(src()).filter((x) => /core\.(branches|collection_centres)/.test(x));
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) expect(x).toMatch(/tenant_id/);
  });
  it('master data is never deleted (02-CV §5.6): no DELETE on branches / centres', () => {
    expect(src()).not.toMatch(/DELETE\s+FROM\s+core\.(branches|collection_centres)/i);
  });
  it('deactivating a centre or branch does not touch memberships (03-APP-FLOW §5): no write to core.memberships / membership_*', () => {
    expect(src()).not.toMatch(/(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+core\.membership/i);
  });
  it('touches only core.branches / core.collection_centres: never dead letters, platform staff or the environment', () => {
    expect(src()).not.toMatch(/core\.dead_letters|platform_staff|process\.env/);
  });
  it('no cap on the number of branches / centres (AC-C1.3): no count-and-compare on the create path, no max_* constant', () => {
    expect(src()).not.toMatch(/\b(MAX|LIMIT)_(BRANCH|CENTRE|CENTER)S?\b|\bmax(Branches|Centres)\b|too_many|limit_exceeded/i);
  });
  it('the branch row is locked (FOR SHARE / FOR UPDATE / FOR KEY SHARE) where a centre is created or moved, so a concurrent deactivateBranch cannot orphan an active centre under an inactive branch', () => {
    const t = stmts(src()).filter((x) => /FROM\s+core\.branches/i.test(x) && /FOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)|FOR\s+KEY\s+SHARE/i.test(x));
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) expect(x).toMatch(/tenant_id/);
  });
  it('duplicates are decided by the unique index (SQLSTATE 23505) mapped to identity.code_duplicate', () => {
    expect(src()).toMatch(/23505/); expect(src()).toMatch(/identity\.code_duplicate/);
  });
  it('code is never in an UPDATE ... SET list (immutable after create, 03-APP-FLOW §5)', () => {
    for (const x of stmts(src()).filter((s) => /UPDATE\s+core\.(branches|collection_centres)/i.test(s))) {
      const set = /SET([\s\S]*?)(WHERE|$)/i.exec(x)?.[1] ?? ''; expect(set).not.toMatch(/\b(branch_code|centre_code)\b/);
    }
  });
});

describe('handler files', () => {
  it.each(OPS)('handlers/%s.ts exists and is not the not-implemented stub', (op) => {
    const p = join(handlerDir, `${op}.ts`); expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).not.toMatch(/not implemented/);
  });
  it.each(OPS)('handlers/%s.ts takes tenant and actor from the context only (no body/query/params tenant read)', (op) => {
    const p = join(handlerDir, `${op}.ts`); if (!existsSync(p)) return expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).not.toMatch(/(body|query|params)\??\.(tenant_id|tenantId)|\[['"]tenant_id['"]\]/);
  });
  it('handlers/index.ts wires all ten operations', () => {
    const idx = readFileSync(join(handlerDir, 'index.ts'), 'utf8');
    for (const op of OPS) expect(idx).toContain(`from './${op}.js'`);
  });
});
