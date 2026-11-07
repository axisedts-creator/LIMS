// T-15 (C3) — AC-11.5 wording grep: "No field, label, export column or event in C3 contains the word 'commission' (04 L19). A CI grep over C3 paths enforces it."
// (The CI/alert files that run this in the pipeline are T-36; this is the T-15 slice over the doctor code and every other C3-owned artefact that exists today.)
// Scope = C3-owned, non-test paths only: spec/ and test files legitimately quote the forbidden word. The scan fails if it finds the word in any C3 source,
// contract, event schema, migration, policy or generated client. It also refuses to pass vacuously (the file set must contain known C3 files).
// This guard may already pass before T-15 is implemented: it protects the new referrers service / mapper / handlers the writer is about to add.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const WORD = /commission/i;
const MODULE = join(REPO_ROOT, 'services/api/src/modules/catalog');
const FILES = [
  'contracts/openapi/catalog.yaml', 'contracts/events/catalog.changed.v1.schema.json', 'db/migrations/20261105001500_catalog__create_catalog_schema.sql', 'db/policies/catalog.sql',
  'packages/api-client-ts/src/catalog.ts', 'packages/api-client-dart/lib/catalog.dart',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(p);
  }
  return out;
}
const scanned = (): string[] => [...walk(MODULE), ...FILES.map((f) => join(REPO_ROOT, f)).filter(existsSync)];
export const offenders = (files: readonly string[], read: (f: string) => string = (f) => readFileSync(f, 'utf8')): string[] =>
  files.flatMap((f) => read(f).split(/\r?\n/).flatMap((line, i) => (WORD.test(line) ? [`${relative(REPO_ROOT, f)}:${i + 1}`] : [])));

describe('AC-11.5 — the word "commission" appears in no C3 field, label, export column, event or source file', () => {
  it('scan is not vacuous: it covers the catalog module sources and the C3 contract / event / migration / client files', () => {
    const files = scanned().map((f) => relative(REPO_ROOT, f).replaceAll('\\', '/'));
    expect(files).toEqual(expect.arrayContaining([
      'services/api/src/modules/catalog/index.ts', 'services/api/src/modules/catalog/service/masters.service.ts', 'contracts/openapi/catalog.yaml',
      'contracts/events/catalog.changed.v1.schema.json', 'db/migrations/20261105001500_catalog__create_catalog_schema.sql',
    ]));
    expect(files.some((f) => f.includes('__tests__'))).toBe(false);
    expect(files.length).toBeGreaterThan(15);
  });

  it('no match (case-insensitive) in any scanned file', () => {
    expect(offenders(scanned())).toEqual([]);
  });

  it('the scanner itself detects the word in any case and position (negative control)', () => {
    const fake = (text: string) => offenders(['x'], () => text);
    expect(fake('ok\nreferral Commission rate')).toEqual(['x:2'].map((s) => s.replace('x', relative(REPO_ROOT, 'x'))));
    expect(fake('COMMISSION')).toHaveLength(1);
    expect(fake('co-mission, committee, referral incentive')).toEqual([]);
  });

  it('the doctor schemas expose no commission-like property: Doctor, DoctorSummary, DoctorCreate, DoctorUpdate, DoctorCreated, DoctorMerge, DoctorSearchRequest', async () => {
    const { loadSpec } = await import('../../../../core/module.js');
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
    for (const n of ['Doctor', 'DoctorSummary', 'DoctorSummaryList', 'DoctorSummaryPage', 'DoctorCreate', 'DoctorUpdate', 'DoctorCreated', 'DoctorMerge', 'DoctorSearchRequest']) {
      expect(spec.components.schemas[n], n).toBeDefined();
      expect(JSON.stringify(spec.components.schemas[n]), n).not.toMatch(WORD);
    }
  });
});
