// T0B-PARTYSET-1 done_when (3): "auto_release_reports is read by the existing release path (default off, additive)".
// WHY STATIC: the release suites run on a fake database (services/worker/.../consumers.helpers.ts) that does not model the partners schema (a query on partners.* returns no row), so a
// behavioural test of the party flag cannot be pinned without inventing fixtures the writer may not extend (writers may not edit test files). This file pins the wiring only:
//   (a) the existing release module (reporting, non test sources) reads partners.party_commercial_setting.auto_release_reports,
//   (b) the existing tenant switch and its skip reason `auto_release_manual` are still there (additive: nothing removed),
//   (c) the read is tenant scoped (the query binds a tenant id) and the flag has no default-on fallback in code.
// The behavioural proof (party flag on -> auto release proceeds although the tenant setting says manual; off / no row -> skipped as before) is listed in
// .orchestra/notes/T0B-PARTYSET-1-tests.md as NOT covered; the lead may ask for a real PG17 release fixture by CR.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));   // services/api/src/modules/reporting
const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return f === '__tests__' || f === 'node_modules' ? [] : sources(p);
  return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
});
const files = sources(ROOT).map((p) => ({ p, s: readFileSync(p, 'utf8') }));

describe('auto release reads the party flag (additive)', () => {
  it('a non test source of the reporting module reads auto_release_reports from party_commercial_setting', () => {
    const hits = files.filter((f) => /auto_release_reports/.test(f.s) && /party_commercial_setting/.test(f.s));
    expect(hits.map((h) => h.p), 'no reporting source reads partners.party_commercial_setting.auto_release_reports').not.toEqual([]);
  });
  it('the read binds the tenant (tenant_id in the same statement) and never defaults the flag to true', () => {
    const hit = files.find((f) => /auto_release_reports/.test(f.s) && /party_commercial_setting/.test(f.s));
    expect(hit, 'no reader found').toBeDefined();
    const sql = hit!.s.split(/`|'|"/).filter((t) => /party_commercial_setting/.test(t) && /auto_release_reports/.test(t));
    expect(sql.length, 'the statement text must hold both names').toBeGreaterThan(0);
    for (const s of sql) expect(s).toMatch(/tenant_id/);
    expect(hit!.s).not.toMatch(/auto_release_reports\s*(\?\?|\|\|)\s*true/);
  });
  it('the existing tenant level switch and its skip reason are untouched', () => {
    const release = files.find((f) => /release\.service\.ts$/.test(f.p));
    expect(release, 'release.service.ts').toBeDefined();
    expect(release!.s).toMatch(/auto_release_manual/);
    expect(release!.s).toMatch(/auto_release \?\? 'when_eligible'/);
  });
});
