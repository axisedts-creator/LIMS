// T0B-TESTIMPORT-1 harness: reuses the T0B-TESTMGMT-1 harness (real handlers over a PG17 RLS tx, ajv against catalog.yaml). Upload body = reporting convention { file: {filename, mimeType, bytes}, mode }.
// Run through tests/catalog/T0B-TESTIMPORT-1.pg.sh (throwaway PG17, migrated through 20261117180000_catalog__add_import_batches.sql; lane/C0-0C must be merged: the contract and that migration live there).
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { TENANT_A, call, fails, ownerRows, req, schemaErrors, superTx, tag, uid, world, im, type Called, type CallOpts, type World } from '../testmgmt/helpers.js';
import { golden, readWorkbook, workbook, type Data, type Golden, type WbOpts } from './xlsx.js';

export * from '../testmgmt/helpers.js';
export const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
export const MANAGE = ['catalog.test.manage', 'catalog.test.read'] as const; // deliberately WITHOUT catalog.reference_range.publish: the import must never need it

export const upload = (bytes: Uint8Array, o: CallOpts & { mode?: 'create_only' | 'update'; name?: string; key?: string } = {}): Promise<Called> =>
  call('validateCatalogImport', req({ headers: { 'idempotency-key': o.key ?? uid() }, body: { file: { filename: o.name ?? 'tests-synthetic.xlsx', mimeType: XLSX_CT, bytes }, ...(o.mode ? { mode: o.mode } : {}) } }), o);
export const uploadFails = (bytes: Uint8Array, o: CallOpts & { mode?: 'create_only' | 'update' } = {}): Promise<any> =>
  fails('validateCatalogImport', req({ headers: { 'idempotency-key': uid() }, body: { file: { filename: 'tests-synthetic.xlsx', mimeType: XLSX_CT, bytes }, ...(o.mode ? { mode: o.mode } : {}) } }), o);
export const commit = (batch: { id: string; version: number }, o: CallOpts & { confirm?: boolean; ifMatch?: Record<string, string> } = {}): Promise<Called> =>
  call('commitCatalogImport', req({ params: { batch_id: batch.id }, headers: { 'idempotency-key': uid(), ...(o.ifMatch ?? im(batch.version)) }, body: { confirm: o.confirm ?? true } }), o);
export const getBatch = (id: string, o: CallOpts = {}) => call('getCatalogImport', req({ params: { batch_id: id } }), o);

export interface Ctx { w: World; t: string; masters: { dept: string; spec: string; unit: string; valueSet: string; category: string }; g: Golden; checksum: string }
/** the checksum a real template carries (taken from a downloaded template, so the tests do not depend on how the writer computes it) */
let realChecksum: string | undefined;
async function templateChecksum(): Promise<string> {
  if (realChecksum) return realChecksum;
  const r = await call('downloadCatalogImportTemplate', req(), { tenant: TENANT_A });
  const meta = readWorkbook(Buffer.from(r.body)).sheets.get('Meta')!;
  const kv = Object.fromEntries([meta.header, ...meta.rows].map((x) => [x[0], x[1]]));
  return (realChecksum = String(kv['checksum']));
}
/** a fresh world (masters created through the real handlers) + a golden workbook description tagged uniquely */
export async function fresh(tenant: string = TENANT_A): Promise<Ctx> {
  const checksum = await templateChecksum();
  const w = await world(tenant); const t = tag(5);
  const cat = (await call('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: w.dept.id, name: `Cat ${t}` } }), { tenant })).body;
  const masters = { dept: w.dept.code, spec: w.spec.code, unit: w.unit.code, valueSet: w.valueSet.code, category: cat.name };
  return { w, t, masters, g: golden(t, masters), checksum };
}
export const build = (c: Ctx, edit?: (d: Golden['data']) => void, o: WbOpts = {}): Buffer => {
  const d = JSON.parse(JSON.stringify(c.g.data)) as Golden['data']; edit?.(d); return workbook(d as Data, { metaChecksum: c.checksum, ...o });
};

/** validated upload: 201, contract-shaped */
export async function validated(bytes: Uint8Array, o: CallOpts & { mode?: 'create_only' | 'update' } = {}): Promise<{ batch: any; errors: any[]; preview: any; called: Called }> {
  const r = await upload(bytes, o);
  expect([200, 201], `${r.status} ${JSON.stringify(r.body)}`).toContain(r.status); // 201 for a new batch (asserted in rules.test.ts), 200 allowed for the existing batch of an idempotent re-upload
  expect(schemaErrors('CatalogImportValidation', r.body), 'response matches CatalogImportValidation').toEqual([]);
  return { ...r.body, called: r };
}
export const errorsOf = (r: { errors: any[] }) => r.errors.map((e) => `${e.sheet}|${e.row}|${e.column}|${e.code}`);
export function expectError(r: { errors: any[]; batch: any }, sheet: string, row: number, column: string, code: string): void {
  expect(r.batch.status, 'a batch with errors is rejected').toBe('rejected');
  expect(errorsOf(r), `errors: ${JSON.stringify(r.errors)}`).toContain(`${sheet}|${row}|${column}|${code}`);
}

// ------------------------------------------------------------------------------------------------ database reads (owner view; RLS bypassed on purpose)
export const likeTag = (t: string) => `%${t}`;
export async function snapshot(tenant: string, t: string) {
  const n = async (table: string, col = 'code') => (await ownerRows(`catalog.${table}`, `tenant_id = $1 AND ${col} LIKE $2`, [tenant, likeTag(t)])).length;
  return { tests: await n('tests'), analytes: await n('analytes'), panels: await n('panels') };
}
export const batchRows = (tenant: string, shaHex: string) => ownerRows('catalog.import_batch', 'tenant_id = $1 AND file_sha256 = $2', [tenant, shaHex]);
export const testsByTag = (tenant: string, t: string) => ownerRows('catalog.tests', 'tenant_id = $1 AND code LIKE $2 ORDER BY code', [tenant, likeTag(t)]);
export const analytesByTag = (tenant: string, t: string) => ownerRows('catalog.analytes', 'tenant_id = $1 AND code LIKE $2 ORDER BY code', [tenant, likeTag(t)]);
export async function versionsOf(analyteIds: string[], table: 'analyte_versions' | 'reference_range_sets' | 'critical_limit_sets'): Promise<any[]> {
  return analyteIds.length ? ownerRows(`catalog.${table}`, 'analyte_id = ANY($1::uuid[]) ORDER BY analyte_id, version_no', [analyteIds]) : [];
}
/** moves a batch 25 hours into the past (the guard trigger holds created_at for everyone, so it is disabled for this one statement inside one owner tx) */
export async function ageBatch(id: string): Promise<void> {
  await superTx(async (tx) => {
    await tx.query('ALTER TABLE catalog.import_batch DISABLE TRIGGER import_batch__guard');
    await tx.query(`UPDATE catalog.import_batch SET created_at = now() - interval '25 hours' WHERE id = $1`, [id]);
    await tx.query('ALTER TABLE catalog.import_batch ENABLE TRIGGER import_batch__guard');
  });
}
