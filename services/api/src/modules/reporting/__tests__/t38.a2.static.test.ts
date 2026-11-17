// C6-T38 — 02-TRD §14 row "08 Addendum A2" (a), (d), (g) at DDL/seed/source level (no Postgres in this harness; the live-DB twin is db/tests/reporting/C6-T38.a2.test.sql).
// Sources: 05-SCHEMA §2.3 (report_versions smart_summary_* + report_versions__smart_summary__ck), §2.x otp_challenges (code_hmac bytea, octet_length = 32), §8 (g_message_templates);
// 07-SECURITY items 8, 8a; 08 Addendum A2.3/A2.4/A2.6/A2.8, A5.5.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';
import { otpHmac, verifyOtp } from '../domain/otp.js';

const rd = (dir: string, re: RegExp) => readdirSync(join(REPO_ROOT, dir)).filter((f) => re.test(f)).sort().map((f) => readFileSync(join(REPO_ROOT, dir, f), 'utf8')).join('\n');
const ddl = rd('db/migrations', /_reporting__.*\.sql$/);
const seed = rd('db/seeds', /^004_reporting__g_message_templates\.sql$/);
const flat = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
/** body of `CONSTRAINT <name> CHECK ( ... )` with balanced parentheses. */
function check(name: string): string {
  const t = flat(ddl); const i = t.indexOf(`CONSTRAINT ${name} CHECK (`); if (i < 0) return '';
  let d = 0; const start = t.indexOf('(', i);
  for (let k = start; k < t.length; k++) { if (t[k] === '(') d++; else if (t[k] === ')' && --d === 0) return t.slice(start + 1, k); }
  return '';
}
const table = (name: string) => flat(ddl.match(new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\);`))?.[0] ?? '');

describe('A2(a) report_versions smart_summary_* all-or-none (DDL)', () => {
  const T = table('reporting\\.report_versions');
  it('three nullable columns with the spec types: jsonb / uuid / text', () => {
    expect(T).toMatch(/smart_summary_json jsonb(,| )/); expect(T).toMatch(/smart_summary_id uuid(,| )/); expect(T).toMatch(/smart_summary_version text(,| )/);
    expect(T).not.toMatch(/smart_summary_(json|id|version) (jsonb|uuid|text) NOT NULL/);
  });
  it('report_versions__smart_summary__ck: all-NULL OR all-set with object + 1..32 length; no per-column FK on smart_summary_id', () => {
    const c = check('report_versions__smart_summary__ck'); expect(c).not.toBe('');
    const [none, some] = c.split(/\)\s*OR\s*\(/);
    for (const k of ['smart_summary_json', 'smart_summary_id', 'smart_summary_version']) {
      expect(none).toContain(`${k} IS NULL`); expect(some).toContain(`${k} IS NOT NULL`);
    }
    expect(some).toMatch(/jsonb_typeof\(smart_summary_json\) = 'object'/); expect(some).toMatch(/char_length\(smart_summary_version\) BETWEEN 1 AND 32/);
    expect(none).not.toMatch(/ OR /);                                                // the all-NULL branch is a pure AND: no 1-of-3 / 2-of-3 escape
    expect(some).not.toMatch(/ OR /);
    expect(flat(ddl)).not.toMatch(/smart_summary_id uuid REFERENCES/);               // 05-SCHEMA: no FK (smartreport schema)
  });
  it('the three columns are NOT in the report_versions mutable-column list -> UPDATE raises (app.enforce_mutable_columns)', () => {
    const m = flat(ddl).match(/CREATE TRIGGER report_versions__mutable_columns BEFORE UPDATE ON reporting\.report_versions FOR EACH ROW EXECUTE FUNCTION app\.enforce_mutable_columns\(([^)]*)\)/);
    expect(m).not.toBeNull(); expect(m![1]).toContain("'status'");                   // guards an empty parse
    expect(m![1]).not.toMatch(/smart_summary/);
  });
});

describe('A2(d) otp_challenges.code_hmac bytea 32 bytes (DDL + domain/otp.ts)', () => {
  it('column is bytea (not text/hex) and CHECK octet_length = 32 (NULL allowed only for the cleared state)', () => {
    expect(table('reporting\\.otp_challenges')).toMatch(/code_hmac bytea(,| )/);
    expect(check('otp_challenges__hmac__ck')).toMatch(/^code_hmac IS NULL OR octet_length\(code_hmac\) = 32$/);
  });
  it('no source hex-decodes an HMAC (08 A5.5): domain/otp.ts + portal.service.ts compare bytes with timingSafeEqual', () => {
    const base = join(import.meta.dirname, '..');
    const otp = readFileSync(join(base, 'domain/otp.ts'), 'utf8'); const portal = readFileSync(join(base, 'service/portal.service.ts'), 'utf8');
    expect(otp).toContain('timingSafeEqual'); expect(otp).not.toMatch(/\bdecode\(|Buffer\.from\([^)]*hex/);
    expect(portal).not.toMatch(/decode\([^)]*hmac|hmac[^;\n]*'hex'|code_hmac\s*=\s*decode/i);
  });
  it('verifyOtp: 31- and 33-byte stored values are rejected (never throw); a 32-byte match verifies; a flipped bit does not', () => {
    const key = new Uint8Array(32).fill(7); const ID = '0190c500-0000-7000-8000-000000000001'; const good = otpHmac(key, ID, '123456');
    expect(good).toHaveLength(32); expect(verifyOtp(key, ID, '123456', good)).toBe(true);
    expect(verifyOtp(key, ID, '123456', good.slice(0, 31))).toBe(false);
    expect(verifyOtp(key, ID, '123456', new Uint8Array([...good, 0]))).toBe(false);
    const bad = good.slice(); bad[0] = bad[0]! ^ 1; expect(verifyOtp(key, ID, '123456', bad)).toBe(false);
  });
});

describe('A2(g)/(e) template analytics.report_ready (seed + code CHECK)', () => {
  const codeRe = new RegExp(check('g_message_templates__code__ck').match(/code ~ '([^']+)'/)?.[1] ?? '$^');
  it('the CHECK regex (from the DDL) accepts analytics.report_ready; the old analytics_report_ready is not a valid code', () => {
    expect(codeRe.test('analytics.report_ready')).toBe(true); expect(codeRe.test('analytics_report_ready')).toBe(false);
  });
  it('seeded once, purpose scheduled_report_ready, email only, params lab_name(short_text) + schedule_name(label_text) + url(staff_url); old code not seeded anywhere', () => {
    const row = seed.match(/\('analytics\.report_ready', '([a-z_]+)', ARRAY\[([^\]]*)\], '(\[.*?\])'/);
    expect(row).not.toBeNull(); expect(row![1]).toBe('scheduled_report_ready'); expect(row![2]!.replace(/'/g, '')).toBe('email');
    expect(JSON.parse(row![3]!)).toEqual([{ name: 'lab_name', kind: 'short_text' }, { name: 'schedule_name', kind: 'label_text' }, { name: 'url', kind: 'staff_url' }]);
    expect(seed.match(/'analytics\.report_ready'/g)).toHaveLength(1); expect(seed + ddl).not.toContain('analytics_report_ready');
  });
  it('purpose scheduled_report_ready is allowed by both purpose CHECKs (08 R13)', () => {
    expect(check('g_message_templates__purpose__ck')).toContain("'scheduled_report_ready'"); expect(check('deliveries__purpose__ck')).toContain("'scheduled_report_ready'");
  });
});
