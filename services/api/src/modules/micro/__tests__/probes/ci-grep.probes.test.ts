// C10 T-25 — S-14 CI grep for breakpoint values (07-SECURITY T-B5, AC-07.7, review m#31): the LIMS provider never ships licensed breakpoint tables.
//  (1) no INSERT into micro.breakpoint_* in db/seeds or db/migrations;
//  (2) no breakpoint band data (CSV with the band header, or SQL INSERTs into breakpoint_bands/rows) anywhere in the repo except the allowlist
//      `packages/test-fixtures/**/micro/synthetic_*` and `**/__tests__/**/synthetic_*`;
//  (3) every allowed file uses only `synthetic_` organism/antibiotic codes and carries `NOT CLINICAL` in every band note.
// The detectors are exported-free helpers below and are self-tested with planted violations, so the check can fail. Synthetic data only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const BAND_HEADER = /organism_scope\s*,\s*organism_code\s*,\s*antibiotic_code/i;
const BP_INSERT = /INSERT\s+INTO\s+"?micro"?\."?breakpoint_(sets|rows|bands|import_issues)"?/i;
const ALLOW = [/^packages\/test-fixtures\/(.*\/)?micro\/synthetic_[^/]*$/, /^(.*\/)?__tests__\/(.*\/)?synthetic_[^/]*$/];
const isAllowed = (p: string) => ALLOW.some((r) => r.test(p));
const SKIP = /^(node_modules|spec|\.orchestra|\.git|test-results)\//;

export function bandCsvViolations(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#'));
  const h = lines.findIndex((l) => BAND_HEADER.test(l));
  if (h < 0) return out;
  const cols = lines[h]!.split(',').map((c) => c.trim());
  const idx = (n: string) => cols.indexOf(n);
  for (const [i, l] of lines.slice(h + 1).entries()) {
    const c = l.split(',');
    const org = (c[idx('organism_code')] ?? '').trim(), abx = (c[idx('antibiotic_code')] ?? '').trim(), note = c[idx('note')] ?? '';
    if (org !== '' && !org.startsWith('synthetic_')) out.push(`row ${i + 1}: organism_code "${org}" is not synthetic_*`);
    if (!abx.startsWith('synthetic_')) out.push(`row ${i + 1}: antibiotic_code "${abx}" is not synthetic_*`);
    if (!note.includes('NOT CLINICAL')) out.push(`row ${i + 1}: note lacks NOT CLINICAL`);
  }
  return out;
}
export function bandSourceViolations(text: string): string[] {
  const out: string[] = [];
  if (!text.includes('NOT CLINICAL')) out.push('file lacks NOT CLINICAL');
  for (const m of text.matchAll(/\b(organism_code|antibiotic_code)\s*[:=]\s*(['"])([^'"]*)\2/g))
    if (m[3] !== '' && !m[3]!.startsWith('synthetic_')) out.push(`${m[1]} "${m[3]}" is not synthetic_*`);
  for (const m of text.matchAll(/\bnote\s*:\s*(['"])([^'"]*)\1/g)) if (!m[2]!.includes('NOT CLINICAL')) out.push(`note "${m[2]}" lacks NOT CLINICAL`);
  return out;
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean)
  .filter((p) => !SKIP.test(p));
const textFiles = tracked.filter((p) => /\.(csv|tsv|sql|ts|tsx|json|ya?ml|md)$/i.test(p));
const read = (p: string) => { try { return readFileSync(join(REPO_ROOT, p), 'utf8'); } catch { return ''; } };

describe('S-14 CI grep — detectors catch planted violations', () => {
  it('flags a non-synthetic code, a missing note and a band INSERT', () => {
    expect(bandCsvViolations('organism_scope,organism_code,antibiotic_code,method,note\norganism,esch_coli,ampicillin,mic,\n')).toHaveLength(3);
    expect(bandCsvViolations('organism_scope,organism_code,antibiotic_code,method,note\nany,,synthetic_abx,mic,NOT CLINICAL\n')).toEqual([]);
    expect(bandSourceViolations("export const x = { organism_code: 'esch_coli', note: 'S' }")).toHaveLength(3);
    expect(bandSourceViolations("// NOT CLINICAL\nconst r = { organism_code: 'synthetic_o', antibiotic_code: 'synthetic_a', note: 'NOT CLINICAL' }")).toEqual([]);
    expect(BP_INSERT.test('INSERT INTO micro.breakpoint_bands (id) VALUES (1)')).toBe(true);
    expect(isAllowed('packages/test-fixtures/a/micro/synthetic_set.csv')).toBe(true);
    expect(isAllowed('services/api/src/modules/micro/domain/__tests__/synthetic_bands.ts')).toBe(true);
    expect(isAllowed('db/seeds/breakpoints.csv')).toBe(false);
  });
});

describe('S-14 CI grep — repository', () => {
  it('scans a non-trivial file set', () => expect(textFiles.length).toBeGreaterThan(200));

  it('(1) no INSERT INTO micro.breakpoint_* in db/seeds or db/migrations', () => {
    const hits = tracked.filter((p) => /^db\/(seeds|migrations)\//.test(p)).filter((p) => BP_INSERT.test(read(p)));
    expect(hits).toEqual([]);
  });

  it('(2) no breakpoint band data outside the synthetic allowlist', () => {
    // data files only: csv/tsv/sql. Source files (the repository layer, tests building CSV from synthetic_/syn_ literals) legitimately mention the table names.
    const hits = tracked.filter((p) => /\.(csv|tsv|sql)$/i.test(p) && !isAllowed(p)).filter((p) => {
      const t = read(p);
      return BAND_HEADER.test(t) || BP_INSERT.test(t);
    });
    expect(hits, 'breakpoint band data found outside packages/test-fixtures/**/micro/synthetic_* and **/__tests__/**/synthetic_*').toEqual([]);
  });

  it('(2b) no CSV/TSV file at all carries band columns outside the allowlist (extension sweep incl. untracked fixtures dirs)', () => {
    const csv = tracked.filter((p) => /\.(csv|tsv)$/i.test(p) && !isAllowed(p));
    for (const p of csv) expect(BAND_HEADER.test(read(p)), p).toBe(false);
  });

  it('(3) every allowed file is synthetic_* only and NOT CLINICAL', () => {
    const allowed = tracked.filter(isAllowed);
    expect(allowed.length, 'the allowlist is not empty (domain/__tests__/synthetic_bands.ts exists)').toBeGreaterThan(0);
    for (const p of allowed) {
      const t = read(p);
      const v = /\.(csv|tsv)$/i.test(p) ? bandCsvViolations(t) : bandSourceViolations(t);
      expect(v, p).toEqual([]);
    }
  });
});
