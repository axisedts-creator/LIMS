// AN-T21 — SQL probes P6, P7, P12 (07-SECURITY §5), static half: the canonical policy set db/policies/analytics.sql and the migration grants are parsed and every
// table is checked against the 05-SCHEMA §3 matrix. The live half (real roles, claims, rows) is the generated pgTAP in db/tests/isolation/analytics.*.test.sql (C0 T0B-10);
// this file fails in plain vitest the moment a policy or grant drifts, with no database needed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf8');
const POLICIES = read('db', 'policies', 'analytics.sql');
const MIGRATION = read('db', 'migrations', '20261105002100_analytics__create_analytics_schema.sql');

interface Policy { name: string; table: string; cmd: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'; to: string; using: string; check: string }
const POLICY_LIST: Policy[] = [...POLICIES.matchAll(/CREATE POLICY (\w+) ON analytics\.(\w+) FOR (\w+) TO (\w+)([\s\S]*?);\s*(?=\nCREATE POLICY|\s*$)/g)].map((m) => {
  const body = m[5]!;
  const using = /USING\s*\(([\s\S]*?)\)\s*(?:WITH CHECK|$)/.exec(body)?.[1] ?? '';
  const check = /WITH CHECK\s*\(([\s\S]*)\)\s*$/.exec(body.trim())?.[1] ?? '';
  return { name: m[1]!, table: m[2]!, cmd: m[3] as Policy['cmd'], to: m[4]!, using: using || (m[3] === 'SELECT' || m[3] === 'DELETE' ? body : ''), check: check || (m[3] === 'INSERT' ? body : '') };
});
const TABLES = [...MIGRATION.matchAll(/CREATE TABLE analytics\.(\w+)/g)].map((m) => m[1]!);
const CLASS_G = TABLES.filter((t) => t.startsWith('g_cs_'));
const TENANT_TABLES = TABLES.filter((t) => !CLASS_G.includes(t));
const CLASS_R = ['daily_orders', 'daily_centre_volume', 'daily_referrer_volume', 'daily_income', 'daily_department_income', 'daily_collections', 'daily_referrer_billing',
  'daily_results', 'daily_specimens', 'daily_rejections', 'daily_critical_values', 'tat_facts', 'daily_releases', 'daily_deliveries', 'daily_interface_messages', 'report_backlog'];
const SYSTEM = "(SELECT app.current_actor_type()) = 'system'";
const STAFF = '(SELECT app.is_staff_or_system())';
const forTable = (t: string) => POLICY_LIST.filter((p) => p.table === t);
const policy = (t: string, cmd: Policy['cmd']) => forTable(t).filter((p) => p.cmd === cmd);
const grants = (t: string): string[] => [...MIGRATION.matchAll(new RegExp(`GRANT ([A-Z, ]+) ON (?:[\\w.,\\s]*?)analytics\\.${t}\\b[\\w.,\\s]* TO lims_app`, 'g'))].flatMap((m) => m[1]!.split(',').map((s) => s.trim()));

describe('parser sanity (so the probes below cannot pass on an empty parse)', () => {
  it('finds 26 tenant tables, 2 class G tables, 16 class R tables and every policy', () => {
    expect(TENANT_TABLES.length).toBe(26);
    expect(CLASS_G.sort()).toEqual(['g_cs_families', 'g_cs_report_codes']);
    expect(CLASS_R.every((t) => TENANT_TABLES.includes(t))).toBe(true);
    expect(POLICY_LIST.length).toBeGreaterThanOrEqual(80);
    expect(POLICIES.match(/^CREATE POLICY/gm)!.length).toBe(POLICY_LIST.length);
  });
});

describe('P6 every owned table: ENABLE + FORCE RLS, tenant predicate, centre predicate on class R (NULL centre invisible to scoped claims), INSERT checks tenant', () => {
  it.each(TENANT_TABLES)('%s: ENABLE and FORCE ROW LEVEL SECURITY', (t) => {
    expect(MIGRATION).toContain(`ALTER TABLE analytics.${t} ENABLE ROW LEVEL SECURITY;`);
    expect(MIGRATION).toContain(`ALTER TABLE analytics.${t} FORCE ROW LEVEL SECURITY;`);
  });
  it('class G (g_cs_*) tables are the only ones without RLS and have no policy', () => {
    for (const t of CLASS_G) { expect(forTable(t)).toEqual([]); expect(MIGRATION).not.toContain(`ALTER TABLE analytics.${t} ENABLE ROW LEVEL SECURITY`); }
  });
  it.each(TENANT_TABLES)('%s: every policy is TO lims_app, filters on the session tenant, and is never USING (true)', (t) => {
    const ps = forTable(t);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      const text = `${p.using} ${p.check}`;
      expect(p.to, p.name).toBe('lims_app');
      expect(text, p.name).toContain('tenant_id = (SELECT app.current_tenant_id())');
      expect(text, p.name).not.toMatch(/\btrue\b/i);
    }
  });
  it.each(CLASS_R)('%s: SELECT requires has_all_centres OR (centre_id IS NOT NULL AND centre_id = ANY(current_centre_ids()::uuid[]))', (t) => {
    const [sel] = policy(t, 'SELECT');
    expect(sel, t).toBeDefined();
    expect(sel!.using).toContain('(SELECT app.has_all_centres())');
    expect(sel!.using).toContain('centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])');
  });
  it('no policy compares tenant_id to a parameter, GUC string or literal (tenant only from app.current_tenant_id())', () => {
    for (const p of POLICY_LIST) expect(`${p.using}${p.check}`, p.name).not.toMatch(/tenant_id\s*=\s*('|\$\d|current_setting)/);
  });
  it('INSERT policies are WITH CHECK on the session tenant (a tenant B row cannot be inserted under tenant A claims)', () => {
    for (const p of POLICY_LIST.filter((x) => x.cmd === 'INSERT')) expect(p.check, p.name).toContain('tenant_id = (SELECT app.current_tenant_id())');
  });
});

describe('P7 user claims cannot write rollups / bookkeeping; purge only after expiry; grant matrix', () => {
  const SYSTEM_ONLY_INSERT = [...CLASS_R, 'order_index', 'export_files', 'refresh_runs', 'report_runs', 'report_run_recipients'];
  it.each(SYSTEM_ONLY_INSERT)('%s: INSERT requires actor_type = system', (t) => {
    const ins = policy(t, 'INSERT');
    expect(ins.length, t).toBe(1);
    expect(ins[0]!.check).toContain(SYSTEM);
  });
  it.each([...CLASS_R, 'export_files', 'report_runs', 'report_run_recipients', 'refresh_runs', 'order_index'])('%s: DELETE policy requires actor_type = system', (t) => {
    const del = policy(t, 'DELETE');
    expect(del.length, t).toBe(1);
    expect(del[0]!.using).toContain(SYSTEM);
  });
  it.each(['refresh_runs', 'order_index', 'report_runs', 'report_run_recipients'])('%s: class E retention delete only after expires_at < now() (P-18(c): future expiry -> 0 rows)', (t) => {
    expect(policy(t, 'DELETE')[0]!.using).toContain('expires_at < now()');
  });
  it('exports DELETE needs system AND requested_at older than 400 days (a fresh row is never purgeable)', () => {
    expect(policy('exports', 'DELETE')[0]!.using).toContain(SYSTEM);
    expect(policy('exports', 'DELETE')[0]!.using).toMatch(/requested_at < now\(\) - interval '400 days'/);
  });
  it.each(CLASS_R)('%s: class R has no UPDATE policy and no UPDATE grant', (t) => {
    expect(policy(t, 'UPDATE')).toEqual([]);
    expect(grants(t)).not.toContain('UPDATE');
    expect(grants(t).sort()).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });
  it('refresh_state: a user INSERT/UPDATE is only possible for family = _manual; every other row is system-only; no DELETE grant', () => {
    const ins = policy('refresh_state', 'INSERT'); const upd = policy('refresh_state', 'UPDATE');
    expect(ins.map((p) => p.name).sort()).toEqual(['refresh_state__insert__tenant', 'refresh_state__insert__tenant_manual']);
    for (const p of [...ins, ...upd]) {
      const guarded = p.name.endsWith('_manual') ? `${p.using}${p.check}`.includes("family = '_manual'") : `${p.using}${p.check}`.includes(SYSTEM);
      expect(guarded, p.name).toBe(true);
    }
    expect(policy('refresh_state', 'DELETE')).toEqual([]);
    expect(grants('refresh_state')).not.toContain('DELETE');
  });
  it('schedules, schedule_recipients, refresh_state: lims_app has no DELETE privilege and no DELETE policy (class M, deactivate only)', () => {
    for (const t of ['schedules', 'schedule_recipients', 'refresh_state']) { expect(grants(t), t).not.toContain('DELETE'); expect(policy(t, 'DELETE'), t).toEqual([]); }
  });
  it('report_runs / report_run_recipients / exports / export_files rows are visible only to system, the recipient/owner, or the requester', () => {
    expect(policy('exports', 'SELECT')[0]!.using).toContain('requested_by_membership_id = (SELECT nullif(app.current_claims() ->> \'membership_id\', \'\')::uuid)');
    expect(policy('export_files', 'SELECT')[0]!.using).toContain('e.requested_by_membership_id');
    expect(policy('report_runs', 'SELECT')[0]!.using).toContain('r.membership_id');
    expect(policy('report_runs', 'SELECT')[0]!.using).toContain('s.owner_membership_id');
    expect(policy('report_run_recipients', 'SELECT')[0]!.using).toContain('s.owner_membership_id');
  });
  it('exports INSERT: own membership only and status queued (a user cannot create a ready export or one for someone else)', () => {
    const c = policy('exports', 'INSERT')[0]!.check;
    expect(c).toContain("status = 'queued'");
    expect(c).toContain('requested_by_membership_id');
  });
  it('lims_analytics (reserved BI role) and anon/public get no grant on analytics.*; no SECURITY DEFINER anywhere in the C8 migration', () => {
    expect(MIGRATION).not.toMatch(/GRANT [^;]*TO (lims_analytics|anon|PUBLIC|authenticated)\b/i);
    expect(MIGRATION).not.toMatch(/CREATE[^;]*SECURITY DEFINER/i);
  });
});

describe('P12 partner, portal and patient claims read 0 rows from every analytics table (08 A17 P-16)', () => {
  it.each(TENANT_TABLES)('%s: every policy of every command carries the staff-or-system actor guard', (t) => {
    for (const p of forTable(t)) expect(`${p.using}${p.check}`, p.name).toContain(STAFF);
  });
  it('the guard is a conjunct (AND), never an alternative: no policy ORs it with another term at top level', () => {
    for (const p of POLICY_LIST) {
      const text = `${p.using}${p.check}`.replace(/\s+/g, ' ');
      expect(text, p.name).not.toMatch(/\(SELECT app\.is_staff_or_system\(\)\)\s+OR\b/);
      expect(text, p.name).not.toMatch(/\bOR\s+\(SELECT app\.is_staff_or_system\(\)\)/);
    }
  });
  it('the generated pgTAP isolation probes exist for every one of the 26 tenant tables (db/tests/isolation)', () => {
    const files = new Set(readdirSync(join(REPO_ROOT, 'db', 'tests', 'isolation')));
    expect(TENANT_TABLES.filter((t) => !files.has(`analytics.${t}.test.sql`))).toEqual([]);
  });
});
