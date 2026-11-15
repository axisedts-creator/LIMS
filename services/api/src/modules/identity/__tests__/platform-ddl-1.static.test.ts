// PLATFORM-DDL-1 (LD-223): static proof of the two migrations, db/policies/identity.sql and the registry, because the pgTAP suite
// (db/tests/identity/PLATFORM-DDL-1_policies.test.sql) is not runnable in the lane. No DB, no network. Synthetic data only.
//   A  migration 20261115191000_identity__add_platform_policies.sql: exactly the 19 s5.3 policies the catalog lacked, names/predicates verbatim, additive only
//   B  migration 20261115192000_identity__add_provisioning_schema.sql: training_mode (CR C2.T16), tenant_contract_acceptances (CR C2.T22), append-only grants
//   C  db/policies/identity.sql holds every new policy 1:1 (AC-0B-2.3); db/meta/tables.yaml has the row and the column
// Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/platform-ddl-1.static.test.ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const MIG = join(ROOT, 'db/migrations');
const F1 = '20261115191000_identity__add_platform_policies.sql';
const F2 = '20261115192000_identity__add_provisioning_schema.sql';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/--[^\n]*/g, '');                       // SQL line comments
const norm = (s: string) => strip(s).replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim().toLowerCase();
const stmts = (s: string) => strip(s).split(';').map((x) => x.trim()).filter(Boolean);
const policies = (s: string) => stmts(s).filter((x) => /^create policy/i.test(x));

const S53: Array<[string, string]> = [
  ['platform_staff', 'select'], ['platform_staff', 'insert'], ['platform_staff', 'update'], ['platform_events', 'select'], ['platform_events', 'insert'], ['auth_events', 'select'],
  ['feature_flags', 'select'], ['feature_flags', 'update'], ['support_sessions', 'select'], ['support_sessions', 'insert'], ['support_sessions', 'update'],
  ['ird_annex_records', 'select'], ['ird_annex_records', 'insert'], ['ird_annex_records', 'update'], ['ird_annex_events', 'select'], ['ird_annex_events', 'insert'],
  ['ird_annex_documents', 'select'], ['ird_annex_documents', 'insert'], ['ird_annex_documents', 'update'],
];
const PRED = '(select app.is_platform_actor())';

describe('A: migration add_platform_policies (C2 05-SCHEMA s5.3)', () => {
  it('exists and sorts after 20261115180000 (LD-223) and after every file that already exists', () => {
    expect(existsSync(join(MIG, F1))).toBe(true); expect(existsSync(join(MIG, F2))).toBe(true);
    expect(F1 > '20261115180000').toBe(true); expect(F1 < F2).toBe(true);
    expect(readdirSync(MIG).filter((f) => f.startsWith('20261115191000') || f.startsWith('20261115192000')).sort()).toEqual([F1, F2]);   // one file per timestamp
  });
  it('creates exactly the 19 missing policies <table>__<command>__platform, each FOR <cmd> TO lims_app, predicate verbatim', () => {
    const sql = read(`db/migrations/${F1}`); const ps = policies(sql); expect(ps).toHaveLength(19);
    for (const [t, c] of S53) {
      const p = ps.find((x) => new RegExp(`^create policy ${t}__${c}__platform on identity\\.${t} for ${c} to lims_app\\b`, 'i').test(x.replace(/\s+/g, ' ')));
      expect(p, `${t}__${c}__platform`).toBeDefined(); const n = norm(p!);
      if (c === 'select') expect(n).toContain(`using(${PRED})`); else if (c === 'insert') expect(n).toContain(`with check(${PRED})`);
      else { expect(n).toContain(`using(${PRED})`); expect(n).toContain(`with check(${PRED})`); }
      if (c === 'select') expect(n).not.toContain('with check');
    }
  });
  it('s5.3 negatives: no auth_events INSERT, no ird_annex_events UPDATE, no DELETE policy, nothing for the 10 policies the catalog already has', () => {
    const names = policies(read(`db/migrations/${F1}`)).map((x) => /create policy (\S+)/i.exec(x)![1]);
    for (const n of ['auth_events__insert__platform', 'ird_annex_events__update__platform', 'tenant_settings__select__platform', 'tenant_settings__update__platform', 'sessions__select__platform',
      'mfa_factors__select__platform', 'invitations__select__platform']) expect(names).not.toContain(n);
    expect(names.filter((n) => /__delete__/.test(n))).toEqual([]); expect(new Set(names).size).toBe(19);
  });
  it('additive only: no DROP / ALTER POLICY / ALTER TABLE / GRANT / REVOKE / CREATE ROLE / DEFINER / DISABLE ROW LEVEL SECURITY, only CREATE POLICY statements', () => {
    const sql = strip(read(`db/migrations/${F1}`));
    for (const re of [/\bdrop\b/i, /alter\s+policy/i, /alter\s+table/i, /\bgrant\b/i, /\brevoke\b/i, /create\s+role/i, /security\s+definer/i, /disable\s+row/i, /bypassrls/i, /create\s+function/i, /create\s+table/i])
      expect(sql, String(re)).not.toMatch(re);
    const s = stmts(sql);   // 02-TRD:241: first statement is the mandatory role switch; everything after it is CREATE POLICY
    expect(s[0]).toMatch(/^set\s+local\s+role\s+lims_owner$/i);
    expect(s.slice(1).every((x) => /^create policy/i.test(x))).toBe(true);
  });
});

describe('B: migration add_provisioning_schema (CR C2.T16, C2.T22, C2.T22-detail; 08 A33-3)', () => {
  const sql = () => read(`db/migrations/${F2}`); const n = () => norm(sql());
  it('adds tenant_settings.training_mode boolean NOT NULL DEFAULT false and a trigger that refuses an UPDATE that changes it', () => {
    expect(n()).toContain('alter table identity.tenant_settings add column training_mode boolean not null default false');
    expect(n()).toMatch(/create trigger \S+ before update[^;]*on identity\.tenant_settings/);
    expect(n()).toMatch(/is distinct from[^;]*training_mode|training_mode[^;]*is distinct from|training_mode\s*<>/);
    expect(n()).toMatch(/raise exception/);
  });
  it('creates identity.tenant_contract_acceptances with the CR C2.T22 columns and checks', () => {
    const s = n(); expect(s).toContain('create table identity.tenant_contract_acceptances');
    for (const c of ['id uuid not null', 'tenant_id uuid not null', 'document text not null', 'version text not null', 'accepted_by_name text not null', 'accepted_by_title text not null',
      'accepted_at timestamptz not null', 'recorded_by uuid not null', 'created_at timestamptz not null default now()', 'created_by uuid not null']) expect(s, c).toContain(c);
    expect(s).toMatch(/primary key\(id\)/); expect(s).toMatch(/foreign key\(tenant_id\)references core\.tenants\(id\)/);
    expect(s).toMatch(/document in\('tos','dpa'\)/); expect(s).toMatch(/char_length\(version\)between 1 and 32/); expect(s).toMatch(/char_length\(accepted_by_name\)between 1 and 120/);
    expect(s).toMatch(/char_length\(accepted_by_title\)between 1 and 80/);
    expect(s).not.toMatch(/updated_at|updated_by/);                                   // append-only: no update bookkeeping
  });
  it('RLS enabled AND forced; owner lims_owner; policies select/insert __tenant + select __platform; no UPDATE / DELETE policy', () => {
    const s = n(); expect(s).toContain('alter table identity.tenant_contract_acceptances enable row level security'); expect(s).toContain('alter table identity.tenant_contract_acceptances force row level security');
    expect(s).toMatch(/alter table identity\.tenant_contract_acceptances owner to lims_owner|set role lims_owner|authorization lims_owner/);
    const ps = policies(sql()).filter((x) => /tenant_contract_acceptances/.test(x)); const names = ps.map((x) => /create policy (\S+)/i.exec(x)![1]).sort();
    expect(names).toEqual(['tenant_contract_acceptances__insert__tenant', 'tenant_contract_acceptances__select__platform', 'tenant_contract_acceptances__select__tenant']);
    const by = (k: string) => norm(ps.find((x) => x.includes(k))!);
    expect(by('select__platform')).toContain(`using(${PRED})`); expect(by('select__platform')).toContain('for select to lims_app');
    expect(by('select__tenant')).toContain('tenant_id=(select app.current_tenant_id())'); expect(by('select__tenant')).toContain('(select app.is_staff_or_system())');
    expect(by('insert__tenant')).toContain('with check(tenant_id=(select app.current_tenant_id())'); expect(by('insert__tenant')).toContain('(select app.is_staff_or_system())');
  });
  it('grants: SELECT and INSERT to lims_app only, never UPDATE / DELETE / TRUNCATE / ALL, nothing to PUBLIC', () => {
    const g = stmts(sql()).filter((x) => /^grant\b/i.test(x) && /tenant_contract_acceptances/.test(x)).map((x) => x.replace(/\s+/g, ' ').toLowerCase());
    expect(g.length).toBeGreaterThan(0); for (const x of g) { expect(x).not.toMatch(/update|delete|truncate|\ball\b|public|references|trigger/); expect(x).toMatch(/to lims_app\b/); }
    expect(g.join(' ')).toMatch(/select/); expect(g.join(' ')).toMatch(/insert/);
  });
  it('no CREATE ROLE, no SECURITY DEFINER, no DROP, no change to an existing policy / grant / function (additive, plain PostgreSQL for Atlas)', () => {
    const s = strip(sql()); for (const re of [/create\s+role/i, /security\s+definer/i, /\bdrop\b/i, /alter\s+policy/i, /\brevoke\b/i, /disable\s+row/i, /bypassrls/i, /create\s+or\s+replace/i, /\\ir\b|\\i\b/])
      expect(s, String(re)).not.toMatch(re);
  });
});

describe('C: db/policies/identity.sql 1:1 copy (AC-0B-2.3) and db/meta/tables.yaml', () => {
  it('every CREATE POLICY of both migrations appears in db/policies/identity.sql, same text modulo whitespace', () => {
    const cat = new Set(policies(read('db/policies/identity.sql')).map(norm)); const mine = [...policies(read(`db/migrations/${F1}`)), ...policies(read(`db/migrations/${F2}`))];
    expect(mine).toHaveLength(22); for (const p of mine) expect(cat.has(norm(p)), norm(p).slice(0, 70)).toBe(true);
  });
  it('db/policies/identity.sql gained nothing else: policy names stay unique and the pre-existing platform policies are still present', () => {
    const names = policies(read('db/policies/identity.sql')).map((x) => /create policy (\S+) on (\S+)/i.exec(x)!.slice(1, 3).join(' ')); expect(new Set(names).size).toBe(names.length);
    for (const n of ['tenant_settings__select__platform', 'tenant_settings__update__platform', 'sessions__select__platform', 'mfa_factors__insert__platform', 'invitations__update__platform', 'platform_staff__select__owner_only',
      'ird_annex_records__select__tenant', 'ird_annex_records__select__tenant_platform_ref']) expect(names.some((x) => x.startsWith(`${n} `)), n).toBe(true);
  });
  it('tables.yaml: identity.tenant_contract_acceptances row (class, tenant scope, audited) and training_mode in identity.tenant_settings', () => {
    const y = read('db/meta/tables.yaml'); const row = y.split('\n').find((l) => l.includes('"identity.tenant_contract_acceptances"'));
    expect(row, 'tables.yaml row').toBeDefined(); expect(row!).toMatch(/"centre_scoped":false/); expect(row!).toMatch(/"audited":true/);
    for (const c of ['id', 'tenant_id', 'document', 'version', 'accepted_by_name', 'accepted_by_title', 'accepted_at', 'recorded_by', 'created_at', 'created_by']) expect(row!, c).toContain(`"${c}":`);
    expect(row!).not.toMatch(/"shared_with"/);                                            // identity tables are not shared except sessions / mfa_factors
    const ts = y.split('\n').find((l) => l.includes('"identity.tenant_settings"'))!; expect(ts).toContain('"training_mode":');
  });
  it('the generated isolation registry lists the new table (so check-registry / gen-isolation-probes see it)', () => {
    expect(read('db/tests/isolation/_registry.sql')).toContain('tenant_contract_acceptances');
    expect(existsSync(join(ROOT, 'db/tests/isolation/identity.tenant_contract_acceptances.test.sql'))).toBe(true);
  });
  it('the pgTAP file of this task exists and covers all 19 policies by name', () => {
    const t = read('db/tests/identity/PLATFORM-DDL-1_policies.test.sql'); for (const [tb, c] of S53) expect(t).toContain(`('${tb}', '${c.toUpperCase()}'`);
  });
});
