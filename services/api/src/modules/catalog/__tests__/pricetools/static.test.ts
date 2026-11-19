// T0B-PRICETOOLS-1 (done_when 1, 3, 6) static checks, no database: the seven operations have handlers and none is pending, permission floors and idempotency of the contract,
// no second spreadsheet library, the price tool sources never use floating point for money and never log file content.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';

const OPS = ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList', 'comparePriceLists', 'listPriceListImportBatches'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

describe('registration (done_when 1, FIRST PRIORITY: the module boot check passes)', () => {
  it.each(OPS)('%s has a handler and is no longer pending', (id) => {
    expect(typeof (handlers as Record<string, unknown>)[id], `${id} handler`).toBe('function');
    expect((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [], `${id} not pending`).not.toContain(id);
  });
  it('every spec operation of catalog has a handler or is pending, and no handler is invented', () => {
    const ids = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean)) as string[];
    const pend = ((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? []) as string[];
    expect(ids.filter((id) => !(id in handlers) && !pend.includes(id))).toEqual([]);
    expect(Object.keys(handlers).filter((id) => !ids.includes(id))).toEqual([]);
  });
});

describe('contract facts the handlers rely on', () => {
  it('permissions: writes need catalog.price_list.manage, history and compare need catalog.price_list.read; all tenant context', () => {
    for (const id of ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList']) expect(opOf(id)['x-permission'], id).toBe('catalog.price_list.manage');
    for (const id of ['comparePriceLists', 'listPriceListImportBatches']) expect(opOf(id)['x-permission'], id).toBe('catalog.price_list.read');
    for (const id of OPS) expect(opOf(id)['x-context'], id).toBe('tenant');
  });
  it('dry run, commit, bulk update and copy need an Idempotency-Key; template, compare and history do not', () => {
    for (const id of ['dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList']) expect(String(opOf(id)['x-idempotency']), id).toMatch(/required/);
    for (const id of ['downloadPriceListTemplate', 'comparePriceLists', 'listPriceListImportBatches']) expect(String(opOf(id)['x-idempotency']), id).not.toMatch(/required/);
  });
  it('no price tool publishes: publishing stays publishPriceListVersion with catalog.price_list.manage', () => {
    expect(opOf('publishPriceListVersion')['x-permission']).toBe('catalog.price_list.manage');
    for (const id of ['commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList']) expect(JSON.stringify(opOf(id).requestBody ?? {}), id).not.toMatch(/publish/i);
  });
});

/** every non test source file of the catalog module (the writer chooses the file names) */
function sources(dir = join(REPO_ROOT, 'services/api/src/modules/catalog')): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (n === '__tests__') continue; if (statSync(p).isDirectory()) out.push(...sources(p)); else if (p.endsWith('.ts')) out.push(p); }
  return out;
}
const priceSources = () => sources().filter((f) => /pric(e|ing)|bulk|compar/i.test(f.replace(/.*catalog[\\/]/, '')) && !/CatalogPort|quote|priceMatch/i.test(f));

describe('implementation rules (done_when 3, 4, 6) read from the source', () => {
  it('no second spreadsheet / zip / xml library: the only one in the package is write-excel-file (analytics export); the catalog reader / writer is in-repo (import/xlsx.ts), a new library needs a ruling', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'services/api/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    const libs = Object.keys(pkg.dependencies ?? {}).filter((n) => /^(xlsx|exceljs|xlsx-populate|read-excel-file|write-excel-file|node-xlsx|sheetjs|jszip|fflate|adm-zip|yauzl|unzipper|fast-xml-parser|sax|xml2js|saxes|@xmldom\/xmldom)$/.test(n));
    expect(libs).toEqual(['write-excel-file']);
  });
  it('the price tool code reuses the TESTIMPORT reader (imports it) and has files of its own for the price tools', () => {
    const files = priceSources();
    expect(files.length, 'price tool source files').toBeGreaterThan(0);
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all, 'reads workbooks through the existing reader (import/xlsx)').toMatch(/from ['"][^'"]*import\/xlsx(\.js)?['"]|from ['"]\.\/xlsx(\.js)?['"]|from ['"]\.\.\/import\/xlsx/);
  });
  it('money is never floating point in the price tool sources: no parseFloat, no Math.round on a price, no toFixed', () => {
    for (const f of priceSources()) {
      const t = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      expect(t, `${f}: parseFloat`).not.toMatch(/parseFloat\s*\(/);
      expect(t, `${f}: toFixed`).not.toMatch(/\.toFixed\s*\(/);
      expect(t, `${f}: Math.round`).not.toMatch(/Math\.round\s*\(/);
    }
  });
  it('the price tool sources never write file content or cell values to a log (no personal data in logs)', () => {
    for (const f of priceSources()) {
      const t = readFileSync(f, 'utf8');
      for (const m of t.matchAll(/\blog\w*\.(info|warn|error|debug)\s*\(([^)]*)\)/g)) expect(m[2], `${f}: ${m[0]}`).not.toMatch(/\b(bytes|buffer|file\b|row\b|cell|rows)\b/i);
    }
  });
  it('the existing upload path is used: no new fs / path writes of uploads in the price tool sources', () => {
    for (const f of priceSources()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/writeFile(Sync)?\s*\(|createWriteStream\s*\(/);
  });
});

describe('probe kit and EXPECTED rows name the two new tables everywhere (registry.static)', () => {
  const PROBES = 'services/api/src/modules/catalog/__tests__/probes';
  const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
  const tables = ['price_list_import_batch', 'price_list_import_error'];
  it.each([[`${PROBES}/pricetools.kit.ts`], [`${PROBES}/pricetools.tables.live.test.ts`], ['db/tests/fixtures/probe-rows/catalog.sql'], ['db/meta/tables.yaml'], ['db/policies/catalog.sql']])('%s names both tables', (file) => {
    expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
    for (const n of tables) expect(text(file), `${file}: ${n}`).toContain(n);
  });
});
