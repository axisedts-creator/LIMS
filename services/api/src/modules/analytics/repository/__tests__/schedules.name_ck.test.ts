// C8 AN-T16 — DB CHECK `analytics.schedules__name__ck` (05-SCHEMA §4; 08 A4.3/A5.4; 07-SECURITY S3: "direct INSERT violating schedules__name__ck -> 23514").
// No Postgres here: the CHECK expression is read from the migration and evaluated clause by clause (PostgreSQL `!~*` = case-insensitive no-match, `!~` = case-sensitive
// no-match; the patterns used are plain enough to mean the same in JS), over the SAME name table the service validator is tested with (domain/__tests__/scheduleNames.ts).
// The DB and the service must agree on every row: "DB CHECK + service" (plan row AN-T16). Real-PG enforcement stays covered by db/tests/analytics (pgTAP, needs docker).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { INVALID_NAMES, VALID_NAMES } from '../../domain/__tests__/scheduleNames.js';

const SQL = readFileSync(join(REPO_ROOT, 'db', 'migrations', '20261105002100_analytics__create_analytics_schema.sql'), 'utf8');
const block = /CONSTRAINT schedules__name__ck CHECK \(([\s\S]*?)\),\s*--/.exec(SQL)?.[1] ?? '';

interface Check { min: number; max: number; negatives: { re: RegExp; src: string; op: string }[] }
function parse(expr: string): Check {
  const len = /char_length\(name\)\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)/i.exec(expr);
  const negatives = [...expr.matchAll(/name\s+(!~\*?)\s+'([^']*)'/g)].map((m) => ({ op: m[1]!, src: m[2]!, re: new RegExp(m[2]!, m[1] === '!~*' ? 'i' : '') }));
  return { min: Number(len?.[1]), max: Number(len?.[2]), negatives };
}
const check = parse(block);
const dbAccepts = (name: string): boolean => {
  const n = [...name].length;                                        // char_length counts characters
  return n >= check.min && n <= check.max && check.negatives.every((x) => !x.re.test(name));
};

describe('schedules__name__ck in the migration', () => {
  it('exists and states the TRD §9.6 step 6 rules: 1..80 characters, no `://` / `www.` (any case), no `@`, no 7+ digit run', () => {
    expect(block).not.toBe('');
    expect([check.min, check.max]).toEqual([1, 80]);
    expect(check.negatives.map((x) => `${x.op} ${x.src}`).sort()).toEqual(['!~ @', '!~ [0-9]{7,}', '!~* ://', '!~* www\\.'].sort());
  });

  it.each(VALID_NAMES.map((n) => [n.length > 20 ? `${n.slice(0, 8)}…(${[...n].length} chars)` : JSON.stringify(n), n]))('the CHECK accepts %s', (_l, n) => {
    expect(dbAccepts(n)).toBe(true);
  });
  it.each(INVALID_NAMES.map((n) => [n.length > 20 ? `${n.slice(0, 8)}…(${[...n].length} chars)` : JSON.stringify(n), n]))('the CHECK rejects %s (SQLSTATE 23514)', (_l, n) => {
    expect(dbAccepts(n)).toBe(false);
  });
});
