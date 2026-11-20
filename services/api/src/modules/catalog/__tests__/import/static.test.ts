// T0B-TESTIMPORT-1 (done_when 1, 2, 3) static checks, no database: the six import operations are registered and no longer pending, the permission floor is catalog.test.manage,
// a library (if any) is pinned and not the advisory-ridden xlsx 0.18.5, docs/ops/CATALOG-IMPORT.md records the audit, and the pinned template columns cover the contract schemas.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { handlers } from '../../handlers/index.js';
import { COLUMNS, DATA_SHEETS, EXCLUDED, OPS } from './columns.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));

const schemas = spec.components.schemas as Record<string, { properties?: Record<string, any> }>;

describe('registration (done_when 1)', () => {
  it('every import operation is in the contract, has a handler, and none is pending any more', () => {
    for (const op of OPS) {
      const found = Object.values(spec.paths as Record<string, Record<string, any>>).flatMap((p) => Object.values(p)).find((x: any) => x?.operationId === op);
      expect(found, `${op} in catalog.yaml`).toBeTruthy();
      expect(typeof (handlers as Record<string, unknown>)[op], `${op} handler`).toBe('function');
      expect((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [], `${op} not pending`).not.toContain(op);
    }
  });
  it('permission floor of all six is catalog.test.manage (tenant context); the commit and upload need an Idempotency-Key', () => {
    const ops = Object.values(spec.paths as Record<string, Record<string, any>>).flatMap((p) => Object.values(p)).filter((x: any) => OPS.includes(x?.operationId));
    expect(ops).toHaveLength(6);
    for (const o of ops as any[]) { expect(o['x-permission'], o.operationId).toBe('catalog.test.manage'); expect(o['x-context']).toBe('tenant'); }
    for (const id of ['validateCatalogImport', 'commitCatalogImport']) expect((ops as any[]).find((o) => o.operationId === id)['x-idempotency']).toBe('required');
  });
});

describe('library choice and docs (done_when 2)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'services/api/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  const SHEET_LIBS = /^(xlsx|exceljs|xlsx-populate|read-excel-file|write-excel-file|node-xlsx|sheetjs|jszip|fflate|adm-zip|yauzl|unzipper|fast-xml-parser|sax|xml2js|saxes|@xmldom\/xmldom)$/;
  it('any spreadsheet / zip / XML dependency is pinned to an exact version (no ^ ~ * > or tag)', () => {
    for (const [name, v] of Object.entries(deps).filter(([n]) => SHEET_LIBS.test(n))) expect(v, `${name} pin`).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('never the npm "xlsx" 0.18.5 (open high advisories: prototype pollution and ReDoS; the audit in CATALOG-IMPORT.md must say why the pick is clean)', () => {
    expect(deps['xlsx'] ?? '').not.toBe('0.18.5');
  });
  const doc = join(REPO_ROOT, 'docs/ops/CATALOG-IMPORT.md');
  it('docs/ops/CATALOG-IMPORT.md exists and records the dependency audit, the pick, the limits, the draft-only rule and the error codes', () => {
    expect(existsSync(doc), 'docs/ops/CATALOG-IMPORT.md').toBe(true);
    const t = readFileSync(doc, 'utf8').toLowerCase();
    for (const needle of ['advisor', 'audit', '5 mb', '5000', 'zip bomb', 'formula', 'draft', 'never publish', 'catalog.import_invalid_file', 'catalog.import_template_outdated', 'catalog.import_too_large', 'catalog.import_has_errors', 'catalog.import_batch_expired', 'catalog.import_already_committed'])
      expect(t, `doc mentions "${needle}"`).toContain(needle);
    for (const lib of Object.keys(deps).filter((n) => SHEET_LIBS.test(n))) expect(t, `doc explains the choice of ${lib}`).toContain(lib.toLowerCase());
  });
});

describe('template field lists cover the contract (done_when 3, no drift)', () => {
  const fed = new Set(DATA_SHEETS.flatMap((s) => COLUMNS[s].flatMap((c) => c.fields)));
  const SCHEMAS = ['TestCreate', 'AnalyteCreate', 'AnalyteVersionDraftInput', 'RangeBand', 'CriticalBand', 'PanelCreate', 'PanelMember'];
  const isFed = (schema: string, prop: string) => [...fed].some((f) => f === `${schema}.${prop}` || f.startsWith(`${schema}.${prop}.`));
  it.each(SCHEMAS)('every property of %s is fed by a pinned column or excluded with a reason', (schema) => {
    const missing = Object.keys(schemas[schema]!.properties ?? {}).filter((p) => !isFed(schema, p) && !(`${schema}.${p}` in EXCLUDED));
    expect(missing, `${schema} properties with no template column`).toEqual([]);
  });
  it('the seven stage TAT columns are exactly the seven StageTatTarget stages', () => {
    const stages = (schemas['StageTatTarget']!.properties!['stage'].enum as string[]).sort();
    expect([...fed].filter((f) => f.startsWith('StageTatTarget.stage=')).map((f) => f.split('=')[1]!).sort()).toEqual(stages);
  });
  it('the pinned columns name only real contract properties (guards a typo in columns.ts)', () => {
    for (const f of fed) {
      const [schema, prop] = f.split('=')[0]!.split('.') as [string, string];
      expect(schemas[schema]?.properties, `${f}: schema`).toBeTruthy();
      expect(Object.keys(schemas[schema]!.properties!), f).toContain(prop);
    }
    for (const k of Object.keys(EXCLUDED)) { const [s, p] = k.split('.') as [string, string]; expect(Object.keys(schemas[s]!.properties!), k).toContain(p); }
  });
  it('labels are unique within a sheet', () => { for (const s of DATA_SHEETS) { const l = COLUMNS[s].map((c) => c.label); expect(new Set(l).size, s).toBe(l.length); } });
});
