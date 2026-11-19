// T0B-PRICETOOLS-1 harness (LD-321, LD-310, LD-325). Real catalog handlers over a PG17 RLS tx (same harness as T0B-TESTMGMT-1 / T0B-TESTIMPORT-1), responses checked against catalog.yaml with ajv.
// Run through tests/catalog/T0B-PRICETOOLS-1.pg.sh (throwaway PG17 migrated through 20261117200000_catalog__add_price_list_tools.sql). Synthetic data only.
// PINNED picks (the contract gives operations and schemas, not workbook labels or every error code; the lead may overrule, edit this file and the tests together):
//   workbook: sheets "Prices" + "Instructions"; header row 1 = HEADERS; data from row 2 (Excel row numbers);
//   row error `column` keys = test_code | price_rupees | effective_from; row error codes = code_not_found, price_invalid (decimals, negative, non numeric, commas, symbols, too big),
//   formula_rejected (text cell starting = + - @), required_missing, code_duplicate (every occurrence), date_invalid;
//   file level refusals (problem+json, nothing recorded): not an xlsx by magic bytes -> 415 common.unsupported_media_type; a ZIP that is unsafe or unreadable (xlsm, macro, external link, zip bomb,
//   formula cell <f>, no workbook, truncated, wrong sheet) -> 422 catalog.import_invalid_file; over 5 MB or over 5000 rows -> 413 common.payload_too_large;
//   permission: the handlers assert catalog.price_list.manage (write ops, template, dry run) / catalog.price_list.read (compare, history) through IdentityPort.assertRole themselves (403 auth.forbidden), as TESTIMPORT did.
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../../handlers/index.js';
import { SYS_ACTOR, TENANT_A, TENANT_B, MEM, appTx, call, expectCode, fails, im, mkTest, ownerRows, req, schemaErrors, superTx, tag, uid, world, T, type World } from '../testmgmt/helpers.js';
import { buildXlsx, readWorkbook, type BuildOpts, type Cell } from '../import/xlsx.js';

export { SYS_ACTOR, TENANT_A, TENANT_B, MEM, appTx, call, expectCode, fails, im, mkTest, ownerRows, req, schemaErrors, superTx, tag, uid, world, T, readWorkbook, buildXlsx };
export const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const SHEET = { prices: 'Prices', instructions: 'Instructions' } as const;
export const HEADERS = ['Test Code', 'Test Name', 'Price (Rs)', 'Effective From'] as const;
export const MANAGE: readonly string[] = ['catalog.price_list.manage', 'catalog.price_list.read'];
export const READ: readonly string[] = ['catalog.price_list.read'];
export const NONE: readonly string[] = [];
export const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
export const OPS = ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList', 'comparePriceLists', 'listPriceListImportBatches'] as const;

// ------------------------------------------------------------------ own caller: captures every SQL statement, the logs and the metrics of one request
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
export interface Pc { status: number; body?: any; headers?: Record<string, string>; queries: string[]; writes: string[]; logs: string[]; assertCalls: string[]; requestId: string }
let registryDone = false;
export interface PcOpts { tenant?: string; grants?: readonly string[]; now?: string }
export async function pcall(operationId: string, r: ReturnType<typeof req>, o: PcOpts = {}): Promise<Pc> {
  if (!registryDone) { await superTx(async (tx) => { await tx.query(`INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('core.event_fanout','core','core','per_tenant',25) ON CONFLICT DO NOTHING`); }); registryDone = true; }
  const tenant = o.tenant ?? TENANT_A; const grants = o.grants ?? MANAGE;
  const queries: string[] = []; const writes: string[] = []; const logs: string[] = []; const assertCalls: string[] = []; const requestId = uid();
  const out = await appTx(tenant, async (raw) => {
    (raw as any).startedAt = new Date();
    const tx = { startedAt: (raw as any).startedAt, query: async (text: string, values?: unknown[]) => { queries.push(text); if (/^\s*(insert|update|delete|truncate)\b/i.test(text)) writes.push(text); return raw.query(text, values); } };
    const sink = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
    const ctx: any = {
      operationId, tenantId: tenant, tx, requestId, now: o.now ? () => o.now! : () => new Date().toISOString(), clientIp: '203.0.113.9',
      actor: { type: 'user', id: SYS_ACTOR, membershipId: tenant === TENANT_B ? MEM.b : MEM.a },
      log: { info: sink, warn: sink, error: sink, debug: sink }, metrics: { inc: () => undefined }, events: createEvents({ producer: 'catalog' }),
      ports: { IdentityPort: {
        async assertRole(_c: unknown, rq: { permission: string }) { assertCalls.push(rq.permission); if (!grants.includes(rq.permission)) throw new LimsError('auth.forbidden'); },
        async getActor() { return { actor: { type: 'user', id: SYS_ACTOR }, permissions: [...grants], mfa: { enrolled: true, level: 'aal2' } }; },
      } },
    };
    return H[operationId]!(r, ctx);
  });
  return { ...out, queries, writes, logs, assertCalls, requestId };
}
export const pfails = async (operationId: string, r: ReturnType<typeof req>, o: PcOpts = {}): Promise<any> => {
  try { await pcall(operationId, r, o); } catch (e) { return e; }
  throw new Error(`${operationId}: expected a rejection, got success`);
};
const idem = () => ({ 'idempotency-key': uid() });

// ------------------------------------------------------------------ fixtures through the real handlers
export interface TestRef { id: string; code: string }
export async function mkTests(w: World, n: number): Promise<TestRef[]> {
  const out: TestRef[] = [];
  for (let i = 0; i < n; i++) { const t = await mkTest(w, { tags: undefined }); out.push({ id: t.id, code: t.code }); }
  return out;
}
export async function mkParty(tenant: string = TENANT_A): Promise<any> {
  const t = tag(5);
  const r = await call('createCreditParty', req({ headers: idem(), body: { party_code: `CP${t}`, name: `Synthetic party ${t}`, kind: 'hospital' } }), { tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
/** a credit party price list (no assignment dates) with an empty draft-less state */
export async function mkList(tenant: string = TENANT_A, o: { party?: any; dates?: { effective_from?: string; effective_to?: string }; noParty?: boolean } = {}): Promise<{ list: any; party: any }> {
  const party = o.party ?? (await mkParty(tenant)); const t = tag(5);
  const r = await call('createPriceList', req({ headers: idem(), body: { code: `PL${t}`, name: `Synthetic list ${t}`, owner_kind: 'credit_party', falls_through: false, assignments: o.noParty ? [] : [{ owner_id: party.id, ...(o.dates ?? {}) }] } }), { tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { list: r.body, party };
}
export const detail = async (listId: string, tenant: string = TENANT_A) => (await call('getPriceListDetail', req({ params: { price_list_id: listId } }), { tenant })).body;
export async function draftOf(listId: string, tenant: string = TENANT_A): Promise<any> {
  const d = await detail(listId, tenant);
  const v = d.versions.find((x: any) => x.status === 'draft');
  if (v) return v;
  const r = await call('createPriceListVersionDraft', req({ params: { price_list_id: listId }, headers: idem(), body: {} }), { tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
export async function putItems(versionId: string, items: Array<{ id: string; paisa: number }>, tenant: string = TENANT_A): Promise<void> {
  for (let i = 0; i < items.length; i += 200) {
    const r = await call('upsertPriceListItems', req({ params: { price_list_version_id: versionId }, headers: idem(), body: { items: items.slice(i, i + 200).map((x) => ({ orderable_id: x.id, unit_price: { amount_paisa: x.paisa, currency: 'NPR' } })) } }), { tenant });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
}
/** a list whose current version is PUBLISHED with the given prices; returns the published version id */
export async function publishedList(prices: Array<{ id: string; paisa: number }>, o: { tenant?: string; party?: any; list?: any } = {}): Promise<{ list: any; party: any; versionId: string; versionNo: number }> {
  const tenant = o.tenant ?? TENANT_A; const made = o.list ? { list: o.list, party: o.party } : await mkList(tenant, { party: o.party });
  const dr = await draftOf(made.list.id, tenant);
  if (prices.length) await putItems(dr.id, prices, tenant);
  const cur = (await detail(made.list.id, tenant)).versions.find((x: any) => x.id === dr.id);
  const r = await call('publishPriceListVersion', req({ params: { price_list_version_id: dr.id }, headers: { ...idem(), ...im(cur.version) }, body: { change_reason: 'synthetic publish' } }), { tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { ...made, versionId: dr.id, versionNo: dr.version_no };
}

// ------------------------------------------------------------------ owner side truth
export const versionRows = (listId: string) => ownerRows('catalog.price_list_versions', 'price_list_id = $1 ORDER BY version_no', [listId]);
export const itemRows = (versionId: string) => ownerRows('catalog.price_list_items', 'price_list_version_id = $1', [versionId]);
/** code -> paisa of one version */
export async function priceMap(versionId: string): Promise<Record<string, number>> {
  const rows = await superTx(async (tx) => (await tx.query(`SELECT o.code, i.unit_price_paisa::text AS p FROM catalog.price_list_items i JOIN catalog.orderables o ON o.tenant_id = i.tenant_id AND o.id = i.orderable_id WHERE i.price_list_version_id = $1`, [versionId])).rows);
  return Object.fromEntries(rows.map((r: any) => [r.code, Number(r.p)]));
}
export const batchRow = async (id: string) => (await ownerRows('catalog.price_list_import_batch', 'id = $1', [id]))[0];
export const batchErrors = (id: string) => ownerRows('catalog.price_list_import_error', 'batch_id = $1 ORDER BY row_no, column_name', [id]);
export const allBatches = (listId: string) => ownerRows('catalog.price_list_import_batch', 'price_list_id = $1 ORDER BY created_at', [listId]);
export const auditOf = (table: string, rowId: string) => ownerRows('audit.audit_log', 'schema_name = $1 AND table_name = $2 AND row_id = $3 ORDER BY occurred_at, id', ['catalog', table, rowId]);
/** md5 of everything price related of one list: versions, items, batches (used to prove "nothing changed") */
export async function listSnapshot(listId: string): Promise<Record<string, string>> {
  return superTx(async (tx) => {
    const h = async (sql: string) => (await tx.query(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS h FROM (${sql}) x`, [listId])).rows[0].h as string;
    return {
      versions: await h(`SELECT * FROM catalog.price_list_versions WHERE price_list_id = $1`),
      items: await h(`SELECT i.* FROM catalog.price_list_items i JOIN catalog.price_list_versions v ON v.id = i.price_list_version_id WHERE v.price_list_id = $1`),
      batches: await h(`SELECT id, status, result_price_list_version_id FROM catalog.price_list_import_batch WHERE price_list_id = $1`),
    };
  });
}

// ------------------------------------------------------------------ bulk test fixture (5000 rows: SQL, not 5000 handler calls)
export async function seedTests(tenant: string, deptId: string, n: number, prefix: string): Promise<TestRef[]> {
  return superTx(async (tx) => {
    await tx.query(`INSERT INTO catalog.orderables (id, tenant_id, kind, code, name, department_id, created_by, updated_by)
      SELECT gen_random_uuid(), $1, 'test', $2 || g::text, 'Synthetic bulk test ' || g::text, $3, $4, $4 FROM generate_series(1, $5::int) g`, [tenant, prefix, deptId, SYS_ACTOR, n]);
    await tx.query(`INSERT INTO catalog.tests (id, tenant_id, workflow_type, created_by, updated_by) SELECT id, tenant_id, 'standard', $3, $3 FROM catalog.orderables WHERE tenant_id = $1 AND kind = 'test' AND code LIKE $2 || '%'`, [tenant, prefix, SYS_ACTOR]);
    const rows = (await tx.query(`SELECT id, code FROM catalog.orderables WHERE tenant_id = $1 AND code LIKE $2 || '%' ORDER BY length(code), code`, [tenant, prefix])).rows;
    return rows.map((r: any) => ({ id: r.id, code: r.code }));
  }, tenant);
}

// ------------------------------------------------------------------ workbooks
export interface PRow { code?: Cell; name?: Cell; price?: Cell; from?: Cell }
export function priceBook(rows: PRow[], o: BuildOpts & { sheet?: string; headers?: readonly string[]; noInstructions?: boolean } = {}): Buffer {
  const head = [...(o.headers ?? HEADERS)];
  const body = rows.map((r): Cell[] => [r.code, r.name ?? '', r.price, r.from]);
  const sheets = [{ name: o.sheet ?? SHEET.prices, rows: [head, ...body] as Cell[][] }];
  if (!o.noInstructions) sheets.unshift({ name: SHEET.instructions, rows: [['Synthetic instructions']] });
  return buildXlsx(sheets, o);
}
/** one data row per test: price in rupees as a number cell */
export const rowsFor = (tests: TestRef[], rupees: (i: number) => Cell): PRow[] => tests.map((t, i) => ({ code: t.code, price: rupees(i) }));

export async function dryRun(listId: string, bytes: Uint8Array, o: PcOpts & { key?: string; name?: string } = {}): Promise<Pc> {
  return pcall('dryRunPriceListImport', req({ params: { price_list_id: listId }, headers: { 'idempotency-key': o.key ?? uid() }, body: { file: { filename: o.name ?? 'prices-synthetic.xlsx', mimeType: XLSX_CT, bytes } } }), o);
}
export const dryRunFails = (listId: string, bytes: Uint8Array, o: PcOpts = {}): Promise<any> =>
  pfails('dryRunPriceListImport', req({ params: { price_list_id: listId }, headers: idem(), body: { file: { filename: 'prices-synthetic.xlsx', mimeType: XLSX_CT, bytes } } }), o);
/** a dry run that must be 201 and contract shaped */
export async function dry(listId: string, bytes: Uint8Array, o: PcOpts = {}): Promise<{ batch: any; errors: any[]; called: Pc }> {
  const r = await dryRun(listId, bytes, o);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(schemaErrors('PriceListImportDryRun', r.body), 'response matches PriceListImportDryRun').toEqual([]);
  return { ...r.body, called: r };
}
export const commitOf = (batchId: string, o: PcOpts & { key?: string; reason?: string } = {}): Promise<Pc> =>
  pcall('commitPriceListImport', req({ params: { batch_id: batchId }, headers: { 'idempotency-key': o.key ?? uid() }, body: { change_reason: o.reason ?? 'synthetic yearly revision' } }), o);
export const errKeys = (r: { errors: any[] }): string[] => r.errors.map((e) => `${e.row_no}|${e.column}|${e.code}`);
export function expectRowError(r: { errors: any[] }, row: number, column: string, code: string): void { expect(errKeys(r), JSON.stringify(r.errors)).toContain(`${row}|${column}|${code}`); }
export const bulkOf = (versionId: string, body: object, o: PcOpts = {}): Promise<Pc> => pcall('bulkUpdatePriceListDraft', req({ params: { price_list_version_id: versionId }, headers: idem(), body }), o);
export const copyOf = (listId: string, body: object, o: PcOpts = {}): Promise<Pc> => pcall('copyPriceList', req({ params: { price_list_id: listId }, headers: idem(), body }), o);
export const compareOf = (a: string, b: string, o: PcOpts & { query?: object } = {}): Promise<Pc> => pcall('comparePriceLists', req({ query: { version_a_id: a, version_b_id: b, ...(o.query ?? {}) } }), o);

/** the same half up integer rounding the contract names, written independently here (BigInt) */
export const halfUpDiv = (n: bigint, d: bigint): bigint => (n >= 0n ? (n + d / 2n) / d : -((-n + d / 2n) / d));
export const percentPaisa = (p: number, bp: number): number => Number(halfUpDiv(BigInt(p) * (10000n + BigInt(bp)), 10000n));
export const roundTo = (p: number, stepPaisa: number): number => Number(halfUpDiv(BigInt(p), BigInt(stepPaisa)) * BigInt(stepPaisa));
