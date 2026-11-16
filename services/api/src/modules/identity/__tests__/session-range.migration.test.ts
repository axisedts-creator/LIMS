// T0B-SESSRANGE-1 (LD-304, CR-C0-LOGIN-1): static checks of the new migration file under db/migrations (the behavioural half is the pgTAP suite
// db/tests/identity/T0B-SESSRANGE-1_tenant_settings_ranges.test.sql, which needs docker). The migration is written and tested here, NOT applied to any cloud database (founder step, push-cloud.ps1).
// Expected now: no migration after 20261116040000 names the two tenant_settings checks, so the file-level tests fail; the "sessions side untouched" tests pass.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';

const DIR = join(REPO_ROOT, 'db', 'migrations');
const LAST_KNOWN = '20261116040000'; // 20261116040000_identity__grant_login_context_to_worker.sql, the newest migration when the task was written
const ALL = readdirSync(DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); // code only, comments do not count
const NEW = ALL.filter((f) => f.slice(0, 14) > LAST_KNOWN && /tenant_settings__idle__ck/.test(read(f)) && /tenant_settings__absolute__ck/.test(read(f)));

describe('the migration file', () => {
  it('there is exactly one new migration that names both tenant_settings__idle__ck and tenant_settings__absolute__ck', () => {
    expect(NEW).toHaveLength(1);
  });
  const file = NEW[0];
  const sql = file ? strip(read(file)) : '';
  const raw = file ? read(file) : '';
  const norm = sql.replace(/\s+/g, ' ');

  it('is named <14 digit timestamp>_identity__<snake_case>.sql and sorts after every existing migration', () => {
    expect(file, 'no migration file').toBeDefined();
    expect(file).toMatch(/^\d{14}_identity__[a-z0-9_]+\.sql$/);
    expect(ALL[ALL.length - 1]).toBe(file);
  });
  it('cites LD-304 and CR-C0-LOGIN-1 in its header comment (lead decision rule)', () => {
    expect(raw).toMatch(/LD-304/); expect(raw).toMatch(/CR-C0-LOGIN-1/);
  });
  it('clamps existing rows FIRST: an UPDATE of identity.tenant_settings comes before the first ADD CONSTRAINT', () => {
    const upd = norm.search(/UPDATE\s+identity\.tenant_settings/i); const add = norm.search(/ADD\s+CONSTRAINT/i);
    expect(upd, 'no UPDATE identity.tenant_settings').toBeGreaterThanOrEqual(0); expect(add, 'no ADD CONSTRAINT').toBeGreaterThanOrEqual(0); expect(upd).toBeLessThan(add);
  });
  it('the clamp covers both columns and all four limits (15, 30, 1, 12) and only touches rows outside the range (no blanket rewrite)', () => {
    const upd = norm.match(/UPDATE\s+identity\.tenant_settings[\s\S]*?;/i)?.[0] ?? '';
    for (const word of ['idle_timeout_minutes', 'absolute_session_hours']) expect(upd, word).toContain(word);
    for (const n of ['15', '30', '1', '12']) expect(upd, `limit ${n}`).toMatch(new RegExp(`\\b${n}\\b`));
    expect(upd, 'needs a WHERE so in-range rows (and their version) are not rewritten').toMatch(/\bWHERE\b/i);
  });
  it('adds the two checks under the SAME names with the ranges idle 15..30 and absolute 1..12', () => {
    expect(norm).toMatch(/tenant_settings__idle__ck\s+CHECK\s*\(\s*idle_timeout_minutes\s+BETWEEN\s+15\s+AND\s+30\s*\)/i);
    expect(norm).toMatch(/tenant_settings__absolute__ck\s+CHECK\s*\(\s*absolute_session_hours\s+BETWEEN\s+1\s+AND\s+12\s*\)/i);
  });
  it('is idempotent: each constraint is dropped IF EXISTS before it is added, or its addition is guarded by a pg_constraint lookup', () => {
    for (const name of ['tenant_settings__idle__ck', 'tenant_settings__absolute__ck']) {
      const dropped = new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${name}`, 'i').test(norm);
      const guarded = /pg_constraint/i.test(norm) && new RegExp(`conname\\s*=\\s*'${name}'`, 'i').test(norm);
      expect(dropped || guarded, `${name} is neither dropped IF EXISTS nor guarded`).toBe(true);
    }
  });
  it('touches only identity.tenant_settings: no other ALTER TABLE / UPDATE / DELETE / DROP TABLE, no GRANT, no policy, no function', () => {
    const tables = [...norm.matchAll(/\b(?:ALTER\s+TABLE(?:\s+ONLY)?|UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());
    expect(tables.length).toBeGreaterThan(0); expect(new Set(tables)).toEqual(new Set(['identity.tenant_settings']));
    expect(norm).not.toMatch(/\b(GRANT|REVOKE|CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+POLICY|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|DROP\s+TABLE|TRUNCATE|DISABLE\s+(ROW\s+LEVEL\s+SECURITY|TRIGGER)|NO\s+FORCE)\b/i);
  });
  it('does not touch the session checks, password / retention / link-ttl rules or any other settings column (LD-304 item 5)', () => {
    expect(norm).not.toMatch(/sessions__idle__ck|sessions__absolute__ck|identity\.sessions/i);
    expect(norm).not.toMatch(/password_min_length|tenant_settings__pwlen__ck|report_link_ttl_days|retention_|rate_limit|mfa/i);
  });
  it('does not widen anything: no limit above 30 minutes or 12 hours in the check text', () => {
    expect(norm).not.toMatch(/BETWEEN\s+\d+\s+AND\s+(?!30\b|12\b)\d+/i);
  });
  it('carries no real personal data or secret (synthetic only)', () => {
    expect(raw).not.toMatch(/password\s*=|secret|token\s*=|@[a-z0-9-]+\.(com|org|np)\b/i);
  });
});

describe('the session side is NOT widened (04-consolidated-decisions A8; LD-304 item 5)', () => {
  it('the baseline schema still holds sessions__idle__ck 15..30 for tenant_staff / platform / partner and sessions__absolute__ck <= created_at + 12 hours for non-patients', () => {
    const base = read('20261105001300_identity__create_identity_schema.sql').replace(/\s+/g, ' ');
    expect(base).toMatch(/kind IN \('tenant_staff','platform','partner'\) AND idle_timeout_minutes BETWEEN 15 AND 30/);
    expect(base).toMatch(/kind <> 'patient' AND absolute_expires_at <= created_at \+ interval '12 hours'/);
  });
  it('no migration after the baseline redefines either session check', () => {
    const later = ALL.filter((f) => f.slice(0, 14) > '20261105001300').filter((f) => /sessions__(idle|absolute)__ck/.test(strip(read(f))));
    expect(later).toEqual([]);
  });
  it('the baseline tenant_settings checks are the ones the new migration restores (idle 15..30, absolute 1..12)', () => {
    const base = read('20261105001300_identity__create_identity_schema.sql').replace(/\s+/g, ' ');
    expect(base).toMatch(/tenant_settings__idle__ck CHECK \(idle_timeout_minutes BETWEEN 15 AND 30\)/);
    expect(base).toMatch(/tenant_settings__absolute__ck CHECK \(absolute_session_hours BETWEEN 1 AND 12\)/);
  });
});
