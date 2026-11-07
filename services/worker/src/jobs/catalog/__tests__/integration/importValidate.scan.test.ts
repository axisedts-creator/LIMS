// T-22 (C3) worker integration: malware scan gate of catalog.import_validate (02-TRD §8.3 step 1, §10 final-attempt table; 08 R12b; 07 REQ-SEC-084, S-8, AB-11).
// Rules under test:
//   * ctx.files.scan(bytes) runs first, on the stored upload, before any parsing. Mandatory when LIMS_CORE_ENV ∈ {staging, production}.
//   * 'infected' → status `quarantined`, last_error_code `common.upload_quarantined`; nothing parsed (no issues, no report, base_version_no stays null).
//   * 'unavailable' → the import stays `scanning` with last_error_code `scan_unavailable` and the attempt FAILS (rejects → retry). The scanning state must
//     survive the failed attempt (the fake rolls back ctx.tx on a throw, so a rethrowing task has to persist it through ctx.db.tx).
//   * on the FINAL attempt (ctx.attempt >= ctx.maxAttempts) it ends `quarantined` / `common.upload_quarantined` (fail closed). Whether that last attempt then resolves
//     or rethrows is the writer's choice; the committed end state is what is asserted.
//   * LIMS_CORE_ENV=dev without a scanner: 'unavailable' continues, log line `scan_unavailable`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importValidate } from '../../tasks/catalog.import_validate.js';
import { IMPORT_ID, TENANT_A, makeRunner, makeValidateDb, seedCatalog, seedImport, uid, type CtxOpts, type ValidateDb } from '../helpers/validateDb.js';
import { containsEicar, eicarSheet, priceWorkbook, prow } from '../helpers/workbooks.js';

const CAT = [{ id: uid(1), code: 'A1' }];
const V = { version_no: 3, status: 'published' as const, items: { A1: 10000 } };
const imp = (db: ValidateDb) => db.rows('imports', TENANT_A).find((x) => x.id === IMPORT_ID)!;
const noWork = (db: ValidateDb) => {
  expect(db.rows('import_issues', TENANT_A)).toEqual([]);
  expect(imp(db).report_file_id).toBeNull();
  expect(imp(db).base_version_no).toBeNull();
  expect(imp(db).summary).toEqual({});
  expect(db.rows('files', TENANT_A).filter((f) => f.purpose === 'import_report')).toEqual([]);
};

const quarantineMetrics = (r: { metrics: Array<{ name: string; labels: any }> }) => r.metrics.filter((m) => m.name === 'lims_catalog_imports_total').map((m) => m.labels);

async function setup(bytes: Uint8Array, scan: NonNullable<CtxOpts['scan']>) {
  const db = makeValidateDb();
  seedCatalog(db, TENANT_A, { orderables: CAT, versions: [V] });
  seedImport(db, TENANT_A, bytes);
  const r = makeRunner(db, importValidate, { scan });
  const go = (attempt = 1, max = 3) => r.run({ tenant_id: TENANT_A, import_id: IMPORT_ID }, attempt, max);
  return { db, r, go };
}
afterEach(() => { vi.unstubAllEnvs(); });

describe.each(['staging', 'production'])('scan is mandatory in %s', (env) => {
  it('infected (EICAR inside a sheet) → quarantined, nothing parsed', async () => {
    vi.stubEnv('LIMS_CORE_ENV', env);
    const bytes = eicarSheet();
    const { db, r, go } = await setup(bytes, (b) => (containsEicar(b) ? 'infected' : 'clean'));
    await go();
    expect(imp(db).status).toBe('quarantined');
    expect(imp(db).last_error_code).toBe('common.upload_quarantined');
    expect(r.scanCalls).toHaveLength(1);
    noWork(db);
    expect(quarantineMetrics(r)).toEqual([{ kind: 'price_list', outcome: 'quarantined' }]);   // 02-TRD §12: CatalogImportQuarantined alert queries this series
    // a quarantined import is terminal: a duplicate delivery does not rescan or change it
    await go();
    expect(r.scanCalls).toHaveLength(1);
    expect(imp(db).status).toBe('quarantined');
  });

  it('unavailable on attempt 1/3 and 2/3 → the attempt rejects, import stays scanning/scan_unavailable, nothing parsed; a later clean scan completes it', async () => {
    vi.stubEnv('LIMS_CORE_ENV', env);
    let up = false;
    const { db, r, go } = await setup(await priceWorkbook([prow('A1', 100)]), () => (up ? 'clean' : 'unavailable'));
    await expect(go(1, 3)).rejects.toBeTruthy();
    expect(imp(db).status).toBe('scanning');
    expect(imp(db).last_error_code).toBe('scan_unavailable');
    noWork(db);
    await expect(go(2, 3)).rejects.toBeTruthy();
    expect(imp(db).status).toBe('scanning');
    expect(imp(db).last_error_code).toBe('scan_unavailable');
    noWork(db);
    up = true;                                                                  // scanner back for the last attempt
    await go(3, 3);
    expect(imp(db).status).toBe('validated');
    expect(r.scanCalls).toHaveLength(3);
  });

  it('unavailable on the final attempt → quarantined with common.upload_quarantined (fail closed), never validated', async () => {
    vi.stubEnv('LIMS_CORE_ENV', env);
    const { db, r, go } = await setup(await priceWorkbook([prow('A1', 100)]), () => 'unavailable');
    await go(1, 3).catch(() => undefined);
    await go(2, 3).catch(() => undefined);
    expect(quarantineMetrics(r)).toEqual([]);                                   // not yet: retries remain
    await go(3, 3).catch(() => undefined);
    expect(imp(db).status).toBe('quarantined');
    expect(imp(db).last_error_code).toBe('common.upload_quarantined');
    noWork(db);
    expect(quarantineMetrics(r)).toEqual([{ kind: 'price_list', outcome: 'quarantined' }]);
  });

  it('a scanner that throws or returns garbage is treated as unavailable, never as clean', async () => {
    vi.stubEnv('LIMS_CORE_ENV', env);
    for (const scan of [() => { throw new Error('socket hang up'); }, () => 'ok' as any, () => undefined as any]) {
      const { db, go } = await setup(await priceWorkbook([prow('A1', 100)]), scan as any);
      await go(1, 3).catch(() => undefined);
      expect(['validated', 'invalid']).not.toContain(imp(db).status);
      noWork(db);
    }
  });

  it('the scanner is given the stored upload bytes exactly, and scans before the parse (no issues exist when it runs)', async () => {
    vi.stubEnv('LIMS_CORE_ENV', env);
    const bytes = await priceWorkbook([prow('A1', 100)]);
    let seenIssues = -1;
    let dbRef: ValidateDb | undefined;
    const { db, r, go } = await setup(bytes, () => { seenIssues = dbRef!.rows('import_issues').length; return 'clean'; });
    dbRef = db;
    await go();
    expect(r.scanCalls).toHaveLength(1);
    expect(Buffer.from(r.scanCalls[0]!).equals(Buffer.from(bytes))).toBe(true);
    expect(seenIssues).toBe(0);
  });
});

describe('local development without a scanner', () => {
  it('unavailable continues with the log line scan_unavailable; the import is validated', async () => {
    vi.stubEnv('LIMS_CORE_ENV', 'dev');
    const { db, r, go } = await setup(await priceWorkbook([prow('A1', 100)]), () => 'unavailable');
    await go();
    expect(imp(db).status).toBe('validated');
    expect(r.log.text()).toContain('scan_unavailable');
  });

  it('infected is still quarantined in dev', async () => {
    vi.stubEnv('LIMS_CORE_ENV', 'dev');
    const { db, go } = await setup(eicarSheet(), (b) => (containsEicar(b) ? 'infected' : 'clean'));
    await go();
    expect(imp(db).status).toBe('quarantined');
    expect(imp(db).last_error_code).toBe('common.upload_quarantined');
  });
});
