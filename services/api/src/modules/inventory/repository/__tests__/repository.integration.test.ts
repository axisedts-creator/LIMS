// C12 T-03 — repositories for all inventory tables: explicit tenant filter, optimistic version updates, line-table reads filter removed_at IS NULL (06-IMPLEMENTATION-PLAN row T-03).
// done_when: "integration tests on migrated DB (UNIQUE NULLS NOT DISTINCT verified on pinned image); EXPLAIN checks for the queries in 05 §10 use the listed indexes". Tests: integration. ACs: none.
// Security (07-SECURITY / 05 §4): repos add tenant_id = $tenant explicitly (RLS is the second layer); tenant A never reads/changes tenant B (other tenant's id behaves like an unknown id);
//   the ledger (stock_movements, stock_documents, stock_document_lines) is append-only: no update/delete function exists and lims_api holds no UPDATE/DELETE grant; draft lines are never deleted (D-71).
// Needs the migrated+seeded database that tests/db/c12-t03/run.sh starts (LIMS_TEST_DATABASE_URL = role lims_api, RLS on; LIMS_TEST_ADMIN_DATABASE_URL = superuser, RLS bypassed).
// Without them the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails. Fixtures: tests/db/c12-t03/fixtures.sql (shape in its header).
//
// SEAMS the spec does not fix (writer must provide exactly these; rows in/out use the DDL's snake_case column names verbatim, mappers do DTOs; same conventions as C14 T02 / C5 T-03):
//   RepoCtx = { tx: { query(text, values?): Promise<{ rows: any[] }> }, tenantId: string, actorId: string }   (tx = the request transaction, 02-TRD §3.2)
//   Every statement binds tenant_id = $n explicitly (value from rc.tenantId, never from a row/patch/arg), is schema-qualified `inventory.`, binds values (never interpolates them), never DELETEs.
//   insertX(rc, row)  -> inserted row (RETURNING *). Caller supplies `id`. tenant_id := rc.tenantId, created_by/updated_by := rc.actorId, version 1 (class A tables: tenant_id + created_by only).
//                        A row carrying tenant_id / created_by / updated_by / version is REJECTED (throws, nothing written). jsonb columns (alerts.details) are passed as JS values; the repo serialises them.
//   getX(rc, id)      -> row | null   (unknown id or another tenant's id -> null)
//   updateX(rc, id, expectedVersion, patch) -> updated row: SET <patch cols>, version = version + 1, updated_at = now(), updated_by = rc.actorId WHERE tenant_id = $t AND id = $id AND version = $expected.
//                        0 rows -> LimsError `common.version_conflict` if the row exists for this tenant, else `common.not_found`. Patch keys must be existing mutable columns of that table;
//                        anything else (tenant_id, id, version, created_*, updated_*, unknown, SQL text) -> throws, nothing written. DB trigger errors propagate. DB errors (23505 ...) propagate unchanged.
//   `opts.includeInactive` (default false): lists of M tables return is_active rows only unless includeInactive === true (removal = deactivation, 08 A17 P-18(a)). `limit` defaults to 200, clamped to 1..1000.
//   Draft-line tables (purchase_order_lines, goods_receipt_lines, transfer_lines): list functions return only removed_at IS NULL rows; removeXLine(rc, id, expectedVersion) sets removed_at = now(),
//                        removed_by = rc.actorId, version + 1 (same conflict/not_found rule as update) and returns the row; there is no DELETE anywhere (D-71). Whether the parent is draft is the DB trigger's job.
//   items.repo.ts          insertItem getItem getItemByCode(rc, code) listItems(rc, {codePrefix?, namePrefix?, category?, limit?}, opts?) [item_code ASC] updateItem
//                          insertPack getPack listPacks(rc, itemId, opts?) [pack_code ASC] updatePack     insertBarcode getBarcode findActiveBarcode(rc, value) [is_active only] listBarcodes(rc, itemId, opts?) updateBarcode
//                          namePrefix: case-insensitive prefix on lower(name); codePrefix: prefix on item_code; LIKE metacharacters in a prefix are literal (a prefix of '%' matches nothing).
//   stores.repo.ts         insertStore getStore listStores(rc, {branchId?}, opts?) [store_code ASC] updateStore
//                          insertStoreItemSetting getStoreItemSetting listReorderSettings(rc, storeId) [is_active AND reorder_level_base IS NOT NULL; item_id, id] updateStoreItemSetting
//                          insertInstrumentBinding getInstrumentBinding listBindingsByStore(rc, storeId, opts?) [id ASC] updateInstrumentBinding
//   suppliers.repo.ts      insertSupplier getSupplier listSuppliers(rc, {namePrefix?, limit?}, opts?) [name ASC, id] updateSupplier     insertSupplierItem getSupplierItem listSupplierItemsByItem(rc, itemId, opts?) [id ASC] updateSupplierItem
//   lots.repo.ts           insertLot getLot getLotByNo(rc, itemId, lotNo) listLotsExpiringBefore(rc, 'YYYY-MM-DD') [expiry_on < date; expiry_on ASC, id] updateLot
//   balances.repo.ts       insertBalance getBalance getBalanceByKey(rc, {storeId, itemId, lotId}) [lotId null = the unlotted row] listBalancesByStore(rc, storeId) [qty_base <> 0; item_id, id]
//                          listBalancesByItem(rc, itemId) [store_id, id] updateBalance
//   movements.repo.ts      insertMovement getMovement listMovementsByStoreItem(rc, {storeId, itemId, limit?}) [occurred_at DESC, id] listMovementsByDoc(rc, {docType, docId}) [occurred_at ASC, id]
//                          listMovementsByLot(rc, lotId) [occurred_at ASC, id]      (NO update / remove export: append-only)
//   documents.repo.ts      insertStockDocument getStockDocument listStockDocuments(rc, {storeId, docKind?, limit?}) [occurred_at DESC, id]   insertStockDocumentLine getStockDocumentLine listStockDocumentLines(rc, documentId) [line_no]
//                          (NO update / remove export: append-only)
//   purchaseOrders.repo.ts insertPo getPo listPos(rc, {status?, supplierId?, branchId?, limit?}) [created_at DESC, id] updatePo     insertPoLine getPoLine listPoLines(rc, poId) [line_no, id] updatePoLine removePoLine
//   goodsReceipts.repo.ts  insertGrn getGrn listGrns(rc, {storeId, status?, limit?}) [received_at DESC, id] listGrnsBySupplier(rc, {supplierId, limit?}) [received_at DESC, id] updateGrn
//                          insertGrnLine getGrnLine listGrnLines(rc, grnId) [line_no, id] updateGrnLine removeGrnLine
//   transfers.repo.ts      insertTransfer getTransfer listTransfersFrom(rc, {storeId, status?}) listTransfersTo(rc, {storeId, status?}) [created_at DESC, id] updateTransfer
//                          insertTransferLine getTransferLine listTransferLines(rc, transferId) [line_no, id] updateTransferLine removeTransferLine
//   counts.repo.ts         insertCount getCount listCounts(rc, {storeId, status?}) [created_at DESC, id] updateCount     insertCountLine getCountLine listCountLines(rc, countId) [id ASC] updateCountLine
//   containers.repo.ts     insertContainer getContainer findInUseContainer(rc, {instrumentId, itemId, storeId}) [status open, opened_at DESC | null] listOpenContainersExpiringBefore(rc, isoTimestamp) [open_expiry_at ASC, id] updateContainer
//   rules.repo.ts          insertRule getRule listRulesByItem(rc, itemId, opts?) [id ASC] listRulesForMatch(rc, {ruleKind, testId, analyteId, instrumentId, at}) [effective at `at`: effective_from <= at AND (effective_to IS NULL OR > at),
//                          is_active, instrument_id = $ OR NULL; test_id and analyte_id IS NOT DISTINCT FROM $ (null matches null); instrument-specific first, then id] updateRule
//   facts.repo.ts          insertFact getFact findFactByBasisKey(rc, key) listUnresolvedFacts(rc, {limit?}) [status unresolved; occurred_at ASC, id] updateFact
//   alerts.repo.ts         insertAlert getAlert findOpenAlertByDedupeKey(rc, key) [status <> 'resolved' | null] listAlerts(rc, {status?, alertKind?, limit?}) [last_raised_at DESC, id] updateAlert
//   settings.repo.ts       ensureSettings(rc) [INSERT ... ON CONFLICT (tenant_id) DO NOTHING, then SELECT; returns the row] getSettings(rc) | null   updateSettings(rc, expectedVersion, patch)
//   counters.repo.ts       allocateNumber(rc, series, periodKey) -> number [INSERT ... ON CONFLICT DO NOTHING, then UPDATE next_value = next_value + 1 RETURNING next_value - 1; first value 1]
//   projections.repo.ts    insertConsumptionDaily getConsumptionDaily listConsumptionDaily(rc, {from, to, storeId?}) [business_date ASC, id] updateConsumptionDaily
//                          insertTestCountsDaily getTestCountsDaily listTestCountsByTest(rc, {testId, from, to}) [business_date ASC, id] updateTestCountsDaily
//                          getQcDaily(rc, {businessDate, instrumentId}) | null   incrementQcObservations(rc, {businessDate, instrumentId}) -> row [UPSERT, qc_observations + 1]
//   codedSets.repo.ts      listUom(rc) [active; sort_order, code]   listReasons(rc, reasonGroup) / listTaxCodes(rc) -> active rows, tenant row shadows the global row of the same group+code, each row carries
//                          scope: 'tenant' | 'global'  [sort_order, code]   insertReason getReason updateReason   insertTaxCode getTaxCode updateTaxCode (cs_reasons / cs_tax_codes)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import * as alerts from '../alerts.repo.js';
import * as balances from '../balances.repo.js';
import * as codedSets from '../codedSets.repo.js';
import * as containers from '../containers.repo.js';
import * as counters from '../counters.repo.js';
import * as counts from '../counts.repo.js';
import * as documents from '../documents.repo.js';
import * as facts from '../facts.repo.js';
import * as goodsReceipts from '../goodsReceipts.repo.js';
import * as items from '../items.repo.js';
import * as lots from '../lots.repo.js';
import * as movements from '../movements.repo.js';
import * as projections from '../projections.repo.js';
import * as purchaseOrders from '../purchaseOrders.repo.js';
import * as rules from '../rules.repo.js';
import * as settings from '../settings.repo.js';
import * as stores from '../stores.repo.js';
import * as suppliers from '../suppliers.repo.js';
import * as transfers from '../transfers.repo.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const BRANCH_A = '01a1a98a-ac40-7000-8000-00000000a101';
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SQL_INJECTION = `x'; DROP TABLE inventory.items; --`;
const SENTINEL = 'T03-SENTINEL-VALUE-7f3a';

type Row = Record<string, any>;
type Fn = (...a: any[]) => Promise<any>;
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Stmt { text: string; values: unknown[] }
interface Rc { tx: Tx; tenantId: string; actorId: string }
// the repositories are looked up by name at call time, so a missing function fails only the tests that need it, with its name
const m = (mod: object, name: string): Fn => async (...a) => {
  const f = (mod as Record<string, unknown>)[name];
  if (typeof f !== 'function') throw new Error(`missing repository function ${name}`);
  return (f as Fn)(...a);
};

let api: pg.Pool;
let admin: pg.Pool;
const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });

/** One request-shaped transaction (claims set transaction-locally like core/db/tx.ts); records every statement the repository sends. COMMIT on success unless `rollback`; ROLLBACK on throw. */
async function inTx<T>(pool: pg.Pool, tenantId: string, fn: (rc: Rc, stmts: Stmt[], raw: Tx) => Promise<T>, o: { claimTenant?: string; rollback?: boolean } = {}): Promise<T> {
  const client = await pool.connect();
  const stmts: Stmt[] = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(o.claimTenant ?? tenantId)]);
    if (pool === admin) await client.query("SET LOCAL search_path = ''");     // the superuser session must not rescue unqualified names
    const tx: Tx = { query: async (text, values = []) => { stmts.push({ text, values: [...values] }); return client.query(text, values); } };
    const out = await fn({ tx, tenantId, actorId: SYS }, stmts, client as unknown as Tx);
    await client.query(o.rollback ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}
const asApi = <T>(t: string, fn: (rc: Rc, s: Stmt[], raw: Tx) => Promise<T>) => inTx(api, t, fn);
const asApiRb = <T>(t: string, fn: (rc: Rc, s: Stmt[], raw: Tx) => Promise<T>) => inTx(api, t, fn, { rollback: true });
/** RLS bypassed: only the repositories' explicit tenant filter stands between ctx tenant and the other tenant's rows. */
const asAdmin = <T>(t: string, fn: (rc: Rc, s: Stmt[], raw: Tx) => Promise<T>, claimTenant = t) => inTx(admin, t, fn, { claimTenant });
const sql = async (text: string, values: unknown[] = []): Promise<Row[]> => (await admin.query(text, values)).rows;
async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected rejection, but it resolved');
}
const ids = (rows: Row[]) => rows.map((r) => r['id']);
const idSet = (rows: Row[]) => [...ids(rows)].sort();
const uids = (...n: number[]) => n.map(uid);
const usorted = (...n: number[]) => uids(...n).sort();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 8 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  const fixtures = readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8');
  await admin.query(fixtures);       // fresh migrated + seeded database (run.sh)
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-03 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ table-driven cases
/** [label, table, tenant-A id, tenant-B id, get] */
const GETTERS: Array<[string, string, number, number, Fn]> = [
  ['getReason', 'inventory.cs_reasons', 9801, 9821, m(codedSets, 'getReason')],
  ['getTaxCode', 'inventory.cs_tax_codes', 9811, 9831, m(codedSets, 'getTaxCode')],
  ['getItem', 'inventory.items', 2001, 2101, m(items, 'getItem')],
  ['getPack', 'inventory.item_packs', 2201, 2301, m(items, 'getPack')],
  ['getBarcode', 'inventory.item_barcodes', 2401, 2411, m(items, 'getBarcode')],
  ['getStore', 'inventory.stores', 1001, 1101, m(stores, 'getStore')],
  ['getStoreItemSetting', 'inventory.store_item_settings', 3401, 3501, m(stores, 'getStoreItemSetting')],
  ['getInstrumentBinding', 'inventory.instrument_bindings', 9401, 9411, m(stores, 'getInstrumentBinding')],
  ['getSupplier', 'inventory.suppliers', 3001, 3101, m(suppliers, 'getSupplier')],
  ['getSupplierItem', 'inventory.supplier_items', 3201, 3301, m(suppliers, 'getSupplierItem')],
  ['getLot', 'inventory.lots', 4001, 4101, m(lots, 'getLot')],
  ['getBalance', 'inventory.stock_balances', 5001, 5101, m(balances, 'getBalance')],
  ['getMovement', 'inventory.stock_movements', 6001, 6101, m(movements, 'getMovement')],
  ['getStockDocument', 'inventory.stock_documents', 9001, 9201, m(documents, 'getStockDocument')],
  ['getStockDocumentLine', 'inventory.stock_document_lines', 9101, 9202, m(documents, 'getStockDocumentLine')],
  ['getPo', 'inventory.purchase_orders', 8301, 8401, m(purchaseOrders, 'getPo')],
  ['getPoLine', 'inventory.purchase_order_lines', 8501, 8601, m(purchaseOrders, 'getPoLine')],
  ['getGrn', 'inventory.goods_receipts', 8001, 8101, m(goodsReceipts, 'getGrn')],
  ['getGrnLine', 'inventory.goods_receipt_lines', 8201, 8211, m(goodsReceipts, 'getGrnLine')],
  ['getTransfer', 'inventory.transfers', 8701, 8801, m(transfers, 'getTransfer')],
  ['getTransferLine', 'inventory.transfer_lines', 8711, 8811, m(transfers, 'getTransferLine')],
  ['getCount', 'inventory.stock_counts', 8901, 8911, m(counts, 'getCount')],
  ['getCountLine', 'inventory.stock_count_lines', 8921, 8931, m(counts, 'getCountLine')],
  ['getContainer', 'inventory.opened_containers', 9301, 9311, m(containers, 'getContainer')],
  ['getRule', 'inventory.consumption_rules', 7001, 7101, m(rules, 'getRule')],
  ['getFact', 'inventory.consumption_facts', 7201, 7301, m(facts, 'getFact')],
  ['getAlert', 'inventory.alerts', 9501, 9511, m(alerts, 'getAlert')],
  ['getConsumptionDaily', 'inventory.consumption_daily', 9701, 9711, m(projections, 'getConsumptionDaily')],
  ['getTestCountsDaily', 'inventory.test_counts_daily', 9721, 9731, m(projections, 'getTestCountsDaily')],
];

/** Optimistic-update cases on tenant A rows (version 1): [label, table, id, update, valid patch, column asserted afterwards, expected value]. */
const UPDATES: Array<[string, string, number, Fn, Row, string, unknown]> = [
  ['updateReason', 'inventory.cs_reasons', 9801, m(codedSets, 'updateReason'), { display: 'Edited T03' }, 'display', 'Edited T03'],
  ['updateTaxCode', 'inventory.cs_tax_codes', 9811, m(codedSets, 'updateTaxCode'), { display: 'Edited T03' }, 'display', 'Edited T03'],
  ['updateItem', 'inventory.items', 2001, m(items, 'updateItem'), { name: 'Glucose reagent (edited)' }, 'name', 'Glucose reagent (edited)'],
  ['updatePack', 'inventory.item_packs', 2202, m(items, 'updatePack'), { label: 'Kit edited' }, 'label', 'Kit edited'],
  ['updateBarcode', 'inventory.item_barcodes', 2401, m(items, 'updateBarcode'), { is_active: false }, 'is_active', false],
  ['updateStore', 'inventory.stores', 1002, m(stores, 'updateStore'), { name: 'Bench edited' }, 'name', 'Bench edited'],
  ['updateStoreItemSetting', 'inventory.store_item_settings', 3401, m(stores, 'updateStoreItemSetting'), { reorder_level_base: '120' }, 'reorder_level_base', '120.000000'],
  ['updateInstrumentBinding', 'inventory.instrument_bindings', 9401, m(stores, 'updateInstrumentBinding'), { is_active: false }, 'is_active', false],
  ['updateSupplier', 'inventory.suppliers', 3001, m(suppliers, 'updateSupplier'), { contact_name: 'Edited Contact' }, 'contact_name', 'Edited Contact'],
  ['updateSupplierItem', 'inventory.supplier_items', 3201, m(suppliers, 'updateSupplierItem'), { lead_time_days: 7 }, 'lead_time_days', 7],
  ['updateLot', 'inventory.lots', 4001, m(lots, 'updateLot'), { status: 'quarantined' }, 'status', 'quarantined'],
  ['updateBalance', 'inventory.stock_balances', 5001, m(balances, 'updateBalance'), { qty_base: '90', value_paisa: 45000 }, 'qty_base', '90.000000'],
  ['updatePo', 'inventory.purchase_orders', 8301, m(purchaseOrders, 'updatePo'), { notes: 'edited by T03' }, 'notes', 'edited by T03'],
  ['updatePoLine', 'inventory.purchase_order_lines', 8501, m(purchaseOrders, 'updatePoLine'), { tax_code: 'VAT', tax_rate_bp: 1300, vat_paisa: 6500, line_total_paisa: 56500 }, 'tax_code', 'VAT'],
  ['updateGrn', 'inventory.goods_receipts', 8001, m(goodsReceipts, 'updateGrn'), { notes: 'edited by T03' }, 'notes', 'edited by T03'],
  ['updateGrnLine', 'inventory.goods_receipt_lines', 8201, m(goodsReceipts, 'updateGrnLine'), { lot_no: 'L-NEW' }, 'lot_no', 'L-NEW'],
  ['updateTransfer', 'inventory.transfers', 8701, m(transfers, 'updateTransfer'), { notes: 'edited by T03' }, 'notes', 'edited by T03'],
  ['updateTransferLine', 'inventory.transfer_lines', 8711, m(transfers, 'updateTransferLine'), { qty_base: '6' }, 'qty_base', '6.000000'],
  ['updateCount', 'inventory.stock_counts', 8901, m(counts, 'updateCount'), { notes: 'edited by T03' }, 'notes', 'edited by T03'],
  ['updateCountLine', 'inventory.stock_count_lines', 8921, m(counts, 'updateCountLine'), { counted_qty_base: '98', counted_at: '2026-11-12T00:00:00Z' }, 'counted_qty_base', '98.000000'],
  ['updateContainer', 'inventory.opened_containers', 9301, m(containers, 'updateContainer'), { notes: 'edited by T03' }, 'notes', 'edited by T03'],
  ['updateRule', 'inventory.consumption_rules', 7001, m(rules, 'updateRule'), { notes: 'edited by T03' }, 'notes', 'edited by T03'],
  ['updateFact', 'inventory.consumption_facts', 7201, m(facts, 'updateFact'), { reason_code: 'not_consumed' }, 'reason_code', 'not_consumed'],
  ['updateAlert', 'inventory.alerts', 9501, m(alerts, 'updateAlert'), { occurrences: 2 }, 'occurrences', 2],
  ['updateConsumptionDaily', 'inventory.consumption_daily', 9701, m(projections, 'updateConsumptionDaily'), { qty_consumed: '6', movements: 2 }, 'movements', 2],
  ['updateTestCountsDaily', 'inventory.test_counts_daily', 9721, m(projections, 'updateTestCountsDaily'), { tests_counted: 13 }, 'tests_counted', 13],
];

/** Minimal valid insert rows (parents from the fixture). [label, table, class A (no version/updated_by)?, insert, row] — all on tenant A. */
type Ins = [string, string, boolean, Fn, () => Row];
const nowIso = () => new Date().toISOString();
const poLine = { qty_packs: '1', qty_in_base_snapshot: '400', qty_base: '400', unit_price_paisa: 50000, discount_paisa: 0, tax_rate_bp: 0, net_paisa: 50000, vat_paisa: 0, line_total_paisa: 50000 };
const INSERTS: Ins[] = [
  ['insertReason', 'inventory.cs_reasons', false, m(codedSets, 'insertReason'), () => ({ id: uid(19001), reason_group: 'wastage', code: 'new_reason', display: 'New reason' })],
  ['insertTaxCode', 'inventory.cs_tax_codes', false, m(codedSets, 'insertTaxCode'), () => ({ id: uid(19002), code: 'NEWTAX', display: 'New tax' })],
  ['insertItem', 'inventory.items', false, m(items, 'insertItem'), () => ({ id: uid(19003), item_code: 'NEW-IT', name: 'New item', category: 'reagent', base_uom_code: 'test' })],
  ['insertPack', 'inventory.item_packs', false, m(items, 'insertPack'), () => ({ id: uid(19004), item_id: uid(2001), pack_code: 'NEWPK', label: 'New pack', uom_code: 'box', qty_in_base: '10' })],
  ['insertBarcode', 'inventory.item_barcodes', false, m(items, 'insertBarcode'), () => ({ id: uid(19005), item_id: uid(2001), pack_id: null, barcode_value: 'NEW-BC-1' })],
  ['insertStore', 'inventory.stores', false, m(stores, 'insertStore'), () => ({ id: uid(19006), branch_id: BRANCH_A, store_code: 'NEW-S', name: 'New store', store_kind: 'bench' })],
  ['insertStoreItemSetting', 'inventory.store_item_settings', false, m(stores, 'insertStoreItemSetting'), () => ({ id: uid(19007), store_id: uid(1002), item_id: uid(2002), reorder_level_base: '1' })],
  ['insertInstrumentBinding', 'inventory.instrument_bindings', false, m(stores, 'insertInstrumentBinding'), () => ({ id: uid(19008), instrument_id: uid(422), store_id: uid(1002) })],
  ['insertSupplier', 'inventory.suppliers', false, m(suppliers, 'insertSupplier'), () => ({ id: uid(19009), supplier_code: 'NEW-SU', name: 'New supplier' })],
  ['insertSupplierItem', 'inventory.supplier_items', false, m(suppliers, 'insertSupplierItem'), () => ({ id: uid(19010), supplier_id: uid(3002), item_id: uid(2001), pack_id: uid(2201) })],
  ['insertLot', 'inventory.lots', false, m(lots, 'insertLot'), () => ({ id: uid(19011), item_id: uid(2002), lot_no: 'C-NEW', expiry_on: '2027-01-31' })],
  ['insertBalance', 'inventory.stock_balances', false, m(balances, 'insertBalance'), () => ({ id: uid(19012), store_id: uid(1002), item_id: uid(2002), lot_id: null, qty_base: '0', value_paisa: 0, last_movement_at: nowIso() })],
  ['insertMovement', 'inventory.stock_movements', true, m(movements, 'insertMovement'), () => ({ id: uid(19013), business_date: day(0), occurred_at: nowIso(), store_id: uid(1001), item_id: uid(2001), lot_id: uid(4001),
    movement_kind: 'receive', qty_base: '5', value_paisa: 2500, value_basis: 'receipt', doc_type: 'goods_receipt', doc_id: uid(8001), balance_qty_after: '105' })],
  ['insertStockDocument', 'inventory.stock_documents', true, m(documents, 'insertStockDocument'), () => ({ id: uid(19014), doc_no: 'SD-A-NEW', doc_kind: 'issue', store_id: uid(1001), occurred_at: nowIso(), issued_to_kind: 'general' })],
  ['insertStockDocumentLine', 'inventory.stock_document_lines', true, m(documents, 'insertStockDocumentLine'), () => ({ id: uid(19015), document_id: uid(9002), line_no: 1, item_id: uid(2001), lot_id: uid(4001), direction: 'out', qty_base: '1', value_paisa: 500 })],
  ['insertPo', 'inventory.purchase_orders', false, m(purchaseOrders, 'insertPo'), () => ({ id: uid(19016), po_no: 'PO269999901', branch_id: BRANCH_A, store_id: uid(1001), supplier_id: uid(3001) })],
  ['insertPoLine', 'inventory.purchase_order_lines', false, m(purchaseOrders, 'insertPoLine'), () => ({ id: uid(19017), po_id: uid(8301), line_no: 3, item_id: uid(2001), pack_id: uid(2201), ...poLine })],
  ['insertGrn', 'inventory.goods_receipts', false, m(goodsReceipts, 'insertGrn'), () => ({ id: uid(19018), grn_no: 'GR269999901', kind: 'purchase', store_id: uid(1001), supplier_id: uid(3001), received_at: nowIso() })],
  ['insertGrnLine', 'inventory.goods_receipt_lines', false, m(goodsReceipts, 'insertGrnLine'), () => ({ id: uid(19019), grn_id: uid(8001), line_no: 3, item_id: uid(2001), pack_id: uid(2201), ...poLine })],
  ['insertTransfer', 'inventory.transfers', false, m(transfers, 'insertTransfer'), () => ({ id: uid(19020), transfer_no: 'TR269999901', from_store_id: uid(1002), to_store_id: uid(1001) })],
  ['insertTransferLine', 'inventory.transfer_lines', false, m(transfers, 'insertTransferLine'), () => ({ id: uid(19021), transfer_id: uid(8701), line_no: 3, item_id: uid(2001), lot_id: uid(4001), qty_base: '2' })],
  ['insertCount', 'inventory.stock_counts', false, m(counts, 'insertCount'), () => ({ id: uid(19022), count_no: 'SC2699999', store_id: uid(1002), snapshot_at: nowIso() })],
  ['insertCountLine', 'inventory.stock_count_lines', false, m(counts, 'insertCountLine'), () => ({ id: uid(19023), count_id: uid(8901), item_id: uid(2002), lot_id: uid(4003), book_qty_snapshot: '3' })],
  ['insertContainer', 'inventory.opened_containers', false, m(containers, 'insertContainer'), () => ({ id: uid(19024), store_id: uid(1002), item_id: uid(2002), lot_id: uid(4003), opened_at: nowIso(), opened_by: SYS })],
  ['insertRule', 'inventory.consumption_rules', false, m(rules, 'insertRule'), () => ({ id: uid(19025), rule_kind: 'per_test', test_id: uid(7001), instrument_id: uid(422), item_id: uid(2002), qty_base: '2', entered_qty: '2', effective_from: nowIso() })],
  ['insertFact', 'inventory.consumption_facts', false, m(facts, 'insertFact'), () => ({ id: uid(19026), fact_kind: 'test', basis_key: 'basis-new', source: 'manual', occurred_at: nowIso(), business_date: day(0), status: 'unresolved' })],
  ['insertAlert', 'inventory.alerts', false, m(alerts, 'insertAlert'), () => ({ id: uid(19027), alert_kind: 'negative_stock', dedupe_key: 'neg:new', first_raised_at: nowIso(), last_raised_at: nowIso(), details: { qty: 1 } })],
  ['insertConsumptionDaily', 'inventory.consumption_daily', false, m(projections, 'insertConsumptionDaily'), () => ({ id: uid(19028), business_date: day(-5), store_id: uid(1001), item_id: uid(2001), movement_kind: 'issue' })],
  ['insertTestCountsDaily', 'inventory.test_counts_daily', false, m(projections, 'insertTestCountsDaily'), () => ({ id: uid(19029), business_date: day(-5), instrument_id: null, test_id: uid(7001) })],
];

// ------------------------------------------------------------------------------------------------ pinned image: UNIQUE NULLS NOT DISTINCT (done_when)
describe.skipIf(!live)('T-03 UNIQUE NULLS NOT DISTINCT on the pinned image (05 §2.14, §2.20, §2.23, §2.25, §2.26)', () => {
  it('the image is PostgreSQL 17 and every NULLS NOT DISTINCT key is catalogued as such (pg_index.indnullsnotdistinct)', async () => {
    expect(Number((await sql('SHOW server_version_num'))[0]!['server_version_num'])).toBeGreaterThanOrEqual(170000);
    const rows = await sql(`SELECT c.relname AS idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = 'inventory' AND i.indnullsnotdistinct ORDER BY 1`);
    expect(rows.map((r) => r['idx'])).toEqual(['consumption_daily__key__uq', 'consumption_rules__current__p_uq', 'stock_balances__key__uq', 'stock_count_lines__key__uq', 'test_counts_daily__key__uq']);
  });

  it('stock_balances: a second unlotted row for the same (store, item) is refused (23505); a different store or a real lot is fine', async () => {
    const dup = { id: uid(19100), store_id: uid(1001), item_id: uid(2003), lot_id: null, qty_base: '1', value_paisa: 0, last_movement_at: nowIso() };
    expect((await rejection(asApiRb(A, (rc) => m(balances, 'insertBalance')(rc, dup))))?.code).toBe('23505');
    await asApiRb(A, (rc) => m(balances, 'insertBalance')(rc, { ...dup, store_id: uid(1002) }));                                                    // other store
    await asApiRb(A, (rc) => m(balances, 'insertBalance')(rc, { ...dup, item_id: uid(2002), lot_id: uid(4003) }));                                // real lot
  });

  it('consumption_daily and test_counts_daily: NULL instrument/test do not make two rows distinct', async () => {
    const cd = { id: uid(19101), business_date: day(-1), store_id: uid(1001), item_id: uid(2001), movement_kind: 'consume_test', instrument_id: null, attributed_test_id: null };
    expect((await rejection(asApiRb(A, (rc) => m(projections, 'insertConsumptionDaily')(rc, cd))))?.code).toBe('23505');                          // 9702 exists with both NULL
    await asApiRb(A, (rc) => m(projections, 'insertConsumptionDaily')(rc, { ...cd, movement_kind: 'wastage' }));
    const tc = { id: uid(19102), business_date: day(-1), instrument_id: null, test_id: uid(7001) };
    expect((await rejection(asApiRb(A, (rc) => m(projections, 'insertTestCountsDaily')(rc, tc))))?.code).toBe('23505');                           // 9722 exists with NULL instrument
    await asApiRb(A, (rc) => m(projections, 'insertTestCountsDaily')(rc, { ...tc, business_date: day(-9) }));
  });

  it('stock_count_lines: a second unlotted line for the same (count, item) is refused', async () => {
    const dup = { id: uid(19103), count_id: uid(8901), item_id: uid(2003), lot_id: null, book_qty_snapshot: '1' };
    expect((await rejection(asApiRb(A, (rc) => m(counts, 'insertCountLine')(rc, dup))))?.code).toBe('23505');
  });

  it('consumption_rules: one current rule per key even when instrument/analyte are NULL; a superseded (effective_to) or inactive twin is allowed', async () => {
    const dup = { id: uid(19104), rule_kind: 'per_test', test_id: uid(7001), instrument_id: null, item_id: uid(2001), qty_base: '3', entered_qty: '3', effective_from: nowIso() };   // 7001 is current with the same key
    expect((await rejection(asApiRb(A, (rc) => m(rules, 'insertRule')(rc, dup))))?.code).toBe('23505');
    await asApiRb(A, (rc) => m(rules, 'insertRule')(rc, { ...dup, effective_from: iso(-3 * 86_400_000), effective_to: iso(-86_400_000) }));          // history row
    await asApiRb(A, (rc) => m(rules, 'insertRule')(rc, { ...dup, is_active: false }));
  });
});

// ------------------------------------------------------------------------------------------------ tenant filter
describe.skipIf(!live)('T-03 explicit tenant filter (REQ-SEC-024; RLS bypassed so only the repository query protects)', () => {
  it.each(GETTERS)('%s: own row returned; the other tenant\'s id and an unknown id both give null', async (_l, _t, a, b, get) => {
    const own = await asAdmin(A, (rc) => get(rc, uid(a)));
    expect(own?.['tenant_id']).toBe(A);
    expect(own?.['id']).toBe(uid(a));
    expect(await asAdmin(B, (rc) => get(rc, uid(a)))).toBeNull();                  // A's row through B's ctx
    expect(await asAdmin(A, (rc) => get(rc, uid(b)))).toBeNull();                  // B's row through A's ctx
    expect(await asAdmin(A, (rc) => get(rc, uid(99999)))).toBeNull();              // unknown id: same answer (404 parity)
    expect((await asAdmin(B, (rc) => get(rc, uid(b))))?.['tenant_id']).toBe(B);
  });

  it('lists and lookups never cross tenants (RLS bypassed)', async () => {
    expect(ids(await asAdmin(B, (rc) => m(items, 'listItems')(rc, {})))).toEqual([uid(2101)]);
    expect(ids(await asAdmin(B, (rc) => m(stores, 'listStores')(rc, {})))).toEqual([uid(1102), uid(1101)]);
    expect(await asAdmin(B, (rc) => m(items, 'listPacks')(rc, uid(2001)))).toEqual([]);                           // A's item through B's ctx
    expect(await asAdmin(B, (rc) => m(balances, 'listBalancesByItem')(rc, uid(2001)))).toEqual([]);
    expect(await asAdmin(B, (rc) => m(movements, 'listMovementsByLot')(rc, uid(4001)))).toEqual([]);
    expect(await asAdmin(B, (rc) => m(purchaseOrders, 'listPoLines')(rc, uid(8301)))).toEqual([]);
    expect(await asAdmin(B, (rc) => m(goodsReceipts, 'listGrnLines')(rc, uid(8001)))).toEqual([]);
    expect(await asAdmin(B, (rc) => m(transfers, 'listTransferLines')(rc, uid(8701)))).toEqual([]);
    expect(await asAdmin(B, (rc) => m(rules, 'listRulesByItem')(rc, uid(2001)))).toEqual([]);
    expect(ids(await asAdmin(B, (rc) => m(facts, 'listUnresolvedFacts')(rc, {})))).toEqual([uid(7301)]);
    expect(ids(await asAdmin(B, (rc) => m(alerts, 'listAlerts')(rc, {})))).toEqual([uid(9511)]);
    expect((await asAdmin(B, (rc) => m(alerts, 'findOpenAlertByDedupeKey')(rc, 'below:2001:1001')))?.['id']).toBe(uid(9511));   // same dedupe key in both tenants: each sees its own
    expect((await asAdmin(A, (rc) => m(alerts, 'findOpenAlertByDedupeKey')(rc, 'below:2001:1001')))?.['id']).toBe(uid(9501));
    expect((await asAdmin(B, (rc) => m(items, 'getItemByCode')(rc, 'GLU-R1')))?.['id']).toBe(uid(2101));
    expect((await asAdmin(A, (rc) => m(items, 'getItemByCode')(rc, 'GLU-R1')))?.['id']).toBe(uid(2001));
    expect((await asAdmin(B, (rc) => m(items, 'findActiveBarcode')(rc, 'BC-GLU-1')))?.['id']).toBe(uid(2411));
    expect((await asAdmin(A, (rc) => m(items, 'findActiveBarcode')(rc, 'BC-GLU-1')))?.['id']).toBe(uid(2401));
    expect(await asAdmin(B, (rc) => m(balances, 'getBalanceByKey')(rc, { storeId: uid(1001), itemId: uid(2003), lotId: null }))).toBeNull();
    expect(await asAdmin(B, (rc) => m(facts, 'findFactByBasisKey')(rc, 'basis-7201'))).toBeNull();
    expect(await asAdmin(B, (rc) => m(projections, 'getQcDaily')(rc, { businessDate: day(-1), instrumentId: uid(421) }))).toBeNull();
    expect(await asAdmin(B, (rc) => m(settings, 'getSettings')(rc))).toBeNull();                                  // B has no row: never A's
  });

  it.each(UPDATES)('%s: ctx tenant B cannot update tenant A\'s row (common.not_found, row untouched)', async (_l, table, n, update, patch) => {
    const before = (await sql(`SELECT version, updated_by, updated_at FROM ${table} WHERE id = $1`, [uid(n)]))[0];
    const e = await rejection(asAdmin(B, (rc) => update(rc, uid(n), 1, patch)));
    expect(isLimsError(e, 'common.not_found'), String(e)).toBe(true);
    expect((await sql(`SELECT version, updated_by, updated_at FROM ${table} WHERE id = $1`, [uid(n)]))[0]).toEqual(before);
  });

  it('insert takes tenant_id from the ctx, never from claims or the row (claims say B, ctx says A, RLS bypassed -> row is A\'s)', async () => {
    const row = await inTx(admin, A, (rc) => m(items, 'insertItem')(rc, { id: uid(19200), item_code: 'CTX-IT', name: 'ctx item', category: 'other', base_uom_code: 'piece' }), { claimTenant: B, rollback: true });
    expect(row['tenant_id']).toBe(A);
  });
});

// ------------------------------------------------------------------------------------------------ insert
describe.skipIf(!live)('T-03 insert (RLS on, lims_api)', () => {
  it.each(INSERTS)('%s: returns the stored row; tenant_id/created_by from the ctx; version 1 (class M/C); it is readable back', async (_l, table, classA, insert, row) => {
    const out = await asApiRb(A, async (rc, _s, raw) => {
      const r = await insert(rc, row());
      expect(r['id']).toBe(row()['id']);
      expect(r['tenant_id']).toBe(A);
      expect(r['created_by']).toBe(SYS);
      if (!classA) { expect(r['version']).toBe(1); expect(r['updated_by']).toBe(SYS); } else expect('version' in r).toBe(false);
      expect((await raw.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [row()['id']])).rows[0]['n']).toBe(1);
      return r;
    });
    expect(out['tenant_id']).toBe(A);
    expect(await sql(`SELECT 1 FROM ${table} WHERE id = $1`, [row()['id']])).toEqual([]);                                   // rolled back: fixture untouched
  });

  it.each(INSERTS)('%s: a row carrying tenant_id / created_by / updated_by / version is refused and nothing is written', async (_l, table, _a, insert, row) => {
    const before = (await sql(`SELECT count(*)::int AS n FROM ${table}`))[0]!['n'];
    for (const extra of [{ tenant_id: B }, { tenant_id: A }, { created_by: SYS }, { updated_by: SYS }, { version: 9 }]) {
      await rejection(asApi(A, (rc) => insert(rc, { ...row(), ...extra })));
    }
    expect((await sql(`SELECT count(*)::int AS n FROM ${table}`))[0]!['n']).toBe(before);
  });

  it('an unknown column and a SQL-looking column name are refused before any SQL is sent', async () => {
    await asApiRb(A, async (rc, stmts) => {
      for (const bad of ['no_such_column', 'name) VALUES (1); DROP TABLE inventory.items; --']) {
        await rejection(m(items, 'insertItem')(rc, { id: uid(19201), item_code: 'BAD-IT', name: 'x', category: 'other', base_uom_code: 'piece', [bad]: 1 }));
      }
      expect(stmts.length).toBe(0);
    });
  });

  it('values are bound, never interpolated: a SQL-looking value is stored literally', async () => {
    const r = await asApiRb(A, async (rc, stmts) => {
      const row = await m(items, 'insertItem')(rc, { id: uid(19202), item_code: 'SQLI-1', name: SQL_INJECTION, category: 'other', base_uom_code: 'piece' });
      expect(stmts.every((s) => !s.text.includes('DROP TABLE'))).toBe(true);
      return row;
    });
    expect(r['name']).toBe(SQL_INJECTION);
    expect((await sql('SELECT count(*)::int AS n FROM inventory.items'))[0]!['n']).toBeGreaterThanOrEqual(5);
  });

  it('DB constraint errors propagate unchanged (23505 unique, 23514 check, 23503 foreign key)', async () => {
    const it = m(items, 'insertItem');
    expect((await rejection(asApiRb(A, (rc) => it(rc, { id: uid(19203), item_code: 'GLU-R1', name: 'dup', category: 'other', base_uom_code: 'piece' }))))?.code).toBe('23505');
    expect((await rejection(asApiRb(A, (rc) => it(rc, { id: uid(19204), item_code: 'lower', name: 'bad code', category: 'other', base_uom_code: 'piece' }))))?.code).toBe('23514');
    expect((await rejection(asApiRb(A, (rc) => it(rc, { id: uid(19205), item_code: 'FK-IT', name: 'bad uom', category: 'other', base_uom_code: 'no_such_uom' }))))?.code).toBe('23503');
    // composite tenant FK: a pack of tenant B's item cannot be created from tenant A's ctx
    expect((await rejection(asApiRb(A, (rc) => m(items, 'insertPack')(rc, { id: uid(19206), item_id: uid(2101), pack_code: 'XPK', label: 'x', uom_code: 'box', qty_in_base: '1' }))))?.code).toBe('23503');
  });
});

// ------------------------------------------------------------------------------------------------ optimistic update
describe.skipIf(!live)('T-03 optimistic update (RLS on, lims_api)', () => {
  it.each(UPDATES)('%s: writes the patch, version + 1, updated_by = actor; stale version -> common.version_conflict', async (_l, table, n, update, patch, col, want) => {
    await asApiRb(A, async (rc, _s, raw) => {
      const r = await update(rc, uid(n), 1, patch);
      expect(r['version']).toBe(2);
      expect(r['updated_by']).toBe(SYS);
      expect(r['tenant_id']).toBe(A);
      expect(r[col]).toEqual(want);
      expect((await raw.query(`SELECT version FROM ${table} WHERE id = $1`, [uid(n)])).rows[0]['version']).toBe(2);
      const e = await rejection(update(rc, uid(n), 1, patch));                                                           // the same stale call again
      expect(isLimsError(e, 'common.version_conflict'), String(e)).toBe(true);
      expect((await raw.query(`SELECT version FROM ${table} WHERE id = $1`, [uid(n)])).rows[0]['version']).toBe(2);   // second call changed nothing
    });
  });

  it.each(UPDATES)('%s: unknown id -> common.not_found; a bad expected version never writes', async (_l, table, n, update, patch) => {
    await asApiRb(A, async (rc, _s, raw) => {
      expect(isLimsError(await rejection(update(rc, uid(99999), 1, patch)), 'common.not_found')).toBe(true);
      for (const v of [0, 2, -1, 1.5, Number.NaN, 2_147_483_648]) await rejection(update(rc, uid(n), v, patch));
      expect((await raw.query(`SELECT version FROM ${table} WHERE id = $1`, [uid(n)])).rows[0]['version']).toBe(1);
    });
  });

  it('patch keys outside the table\'s mutable columns (tenant_id, id, version, created_*, updated_*, unknown, SQL text) are refused and nothing is written', async () => {
    await asApiRb(A, async (rc, stmts) => {
      const upd = m(items, 'updateItem');
      for (const bad of ['tenant_id', 'id', 'version', 'created_by', 'created_at', 'updated_by', 'updated_at', 'no_such_column', "name = 'x', tenant_id"]) {
        await rejection(upd(rc, uid(2001), 1, { name: 'ok name', [bad]: B }));
      }
      await rejection(upd(rc, uid(2001), 1, {}));                                                                        // empty patch
      expect(stmts.length).toBe(0);
    });
    expect((await sql('SELECT version, name FROM inventory.items WHERE id = $1', [uid(2001)]))[0]).toEqual({ version: 1, name: 'Glucose reagent' });
  });

  it('a SQL-looking value is bound, not executed', async () => {
    await asApiRb(A, async (rc) => {
      const r = await m(items, 'updateItem')(rc, uid(2001), 1, { name: SQL_INJECTION });
      expect(r['name']).toBe(SQL_INJECTION);
    });
  });

  it('an update is one UPDATE statement carrying the version guard and version = version + 1 (race-safe, no read-then-write)', async () => {
    await asApiRb(A, async (rc, stmts, raw) => {
      await m(items, 'updateItem')(rc, uid(2004), 1, { notes: 'race check' });
      const writes = stmts.filter((s) => /^\s*UPDATE/i.test(s.text));
      expect(writes.length).toBe(1);
      expect(writes[0]!.text).toMatch(/version\s*=\s*version\s*\+\s*1/i);
      expect(writes[0]!.text).toMatch(/version\s*=\s*\$\d/i);                                                              // WHERE ... AND version = $expected
      expect((await raw.query('SELECT version FROM inventory.items WHERE id = $1', [uid(2004)])).rows[0]['version']).toBe(2);
    });
  });
});

// ------------------------------------------------------------------------------------------------ draft lines: soft removal (D-71)
describe.skipIf(!live)('T-03 draft lines: reads filter removed_at IS NULL, removal is soft (08 A17 D-71)', () => {
  const LINES: Array<[string, string, Fn, Fn, number, number[], number[]]> = [
    // label, table, list, remove, header id, expected visible ids, id of a visible line to remove
    ['purchase_order_lines', 'inventory.purchase_order_lines', m(purchaseOrders, 'listPoLines'), m(purchaseOrders, 'removePoLine'), 8301, [8501, 8503], [8501]],
    ['goods_receipt_lines', 'inventory.goods_receipt_lines', m(goodsReceipts, 'listGrnLines'), m(goodsReceipts, 'removeGrnLine'), 8001, [8201, 8203], [8201]],
    ['transfer_lines', 'inventory.transfer_lines', m(transfers, 'listTransferLines'), m(transfers, 'removeTransferLine'), 8701, [8711, 8713], [8711]],
  ];

  it.each(LINES)('%s: the list hides the removed line (fixture holds a removed twin with the same line_no)', async (_l, table, list, _rm, header, visible) => {
    const all = await sql(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [A]);
    expect(all[0]!['n']).toBeGreaterThan(visible.length);                                                                // the removed row really is in the table
    const rows = await asApi(A, (rc) => list(rc, uid(header)));
    expect(ids(rows)).toEqual(uids(...visible));
    expect(rows.every((r) => r['removed_at'] === null)).toBe(true);
  });

  it.each(LINES)('%s: remove sets removed_at/removed_by/version + 1, keeps the row, the list drops it; a stale version conflicts; the other tenant gets not_found', async (_l, table, list, remove, header, visible, [victim]) => {
    await asApiRb(A, async (rc, stmts, raw) => {
      const r = await remove(rc, uid(victim!), 1);
      expect(r['removed_by']).toBe(SYS);
      expect(r['removed_at']).not.toBeNull();
      expect(r['version']).toBe(2);
      expect(ids(await list(rc, uid(header)))).toEqual(uids(...visible.filter((v) => v !== victim)));
      expect((await raw.query(`SELECT removed_at FROM ${table} WHERE id = $1`, [uid(victim!)])).rows.length).toBe(1);   // never deleted
      expect(isLimsError(await rejection(remove(rc, uid(victim!), 1)), 'common.version_conflict')).toBe(true);
      expect(stmts.every((s) => !/\bDELETE\b/i.test(s.text))).toBe(true);
    });
    expect(isLimsError(await rejection(asAdmin(B, (rc) => remove(rc, uid(victim!), 1))), 'common.not_found')).toBe(true);
  });

  it('removed line numbers can be reused: the partial unique index only covers removed_at IS NULL', async () => {
    await asApiRb(A, async (rc) => {
      await m(purchaseOrders, 'removePoLine')(rc, uid(8503), 1);
      const again = await m(purchaseOrders, 'insertPoLine')(rc, { id: uid(19300), po_id: uid(8301), line_no: 2, item_id: uid(2001), pack_id: uid(2201), ...poLine });
      expect(again['line_no']).toBe(2);
      expect(ids(await m(purchaseOrders, 'listPoLines')(rc, uid(8301)))).toEqual(uids(8501, 19300));
    });
    expect((await rejection(asApiRb(A, (rc) => m(purchaseOrders, 'insertPoLine')(rc, { id: uid(19301), po_id: uid(8301), line_no: 2, item_id: uid(2001), pack_id: uid(2201), ...poLine }))))?.code).toBe('23505');
  });
});

// ------------------------------------------------------------------------------------------------ append-only ledger
describe.skipIf(!live)('T-03 append-only tables (stock_movements, stock_documents, stock_document_lines)', () => {
  it('the ledger repositories export no update/remove/delete function', () => {
    for (const mod of [movements, documents]) {
      const bad = Object.keys(mod).filter((k) => /^(update|remove|delete|upsert|purge)/i.test(k));
      expect(bad).toEqual([]);
    }
  });

  it('lims_api holds no UPDATE or DELETE grant on them (05 §4.4) and no repository path can change a posted row', async () => {
    for (const t of ['stock_movements', 'stock_documents', 'stock_document_lines']) {
      const e = await rejection(asApiRb(A, (_rc, _s, raw) => raw.query(`UPDATE inventory.${t} SET created_by = created_by WHERE tenant_id = $1`, [A])));
      expect(e?.code, `${t} UPDATE`).toBe('42501');
      const d = await rejection(asApiRb(A, (_rc, _s, raw) => raw.query(`DELETE FROM inventory.${t} WHERE tenant_id = $1`, [A])));
      expect(d?.code, `${t} DELETE`).toBe('42501');
    }
  });

  it('no repository function sends a DELETE (draft lines are soft-removed, alerts are purged by app.purge_inventory_alerts only)', async () => {
    const stmts: Stmt[] = [];
    await asApiRb(A, async (rc, s) => {
      const calls: Array<() => Promise<unknown>> = [
        () => m(items, 'listItems')(rc, {}), () => m(stores, 'listStores')(rc, {}), () => m(alerts, 'listAlerts')(rc, {}), () => m(purchaseOrders, 'listPoLines')(rc, uid(8301)),
        () => m(purchaseOrders, 'removePoLine')(rc, uid(8501), 1), () => m(alerts, 'updateAlert')(rc, uid(9501), 1, { occurrences: 3 }), () => m(settings, 'ensureSettings')(rc),
      ];
      for (const c of calls) await c();
      stmts.push(...s);
    });
    expect(stmts.length).toBeGreaterThan(5);
    expect(stmts.filter((s) => /\bDELETE\b/i.test(s.text))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ statement hygiene
describe.skipIf(!live)('T-03 statement hygiene (07-SECURITY: repos add tenant_id = $tenant explicitly; schema-qualified; bound values)', () => {
  it('every statement of a sweep over reads, inserts and updates is schema-qualified, binds tenant_id = $n with the ctx tenant, and never inlines a value', async () => {
    const stmts: Stmt[] = [];
    await asApiRb(A, async (rc, s) => {
      for (const [, , a, , get] of GETTERS) await get(rc, uid(a));
      await m(items, 'listItems')(rc, { codePrefix: SENTINEL, namePrefix: SENTINEL, category: 'reagent', limit: 5 });
      await m(suppliers, 'listSuppliers')(rc, { namePrefix: SENTINEL });
      await m(movements, 'listMovementsByStoreItem')(rc, { storeId: uid(1001), itemId: uid(2001), limit: 3 });
      await m(alerts, 'findOpenAlertByDedupeKey')(rc, SENTINEL);
      await m(facts, 'findFactByBasisKey')(rc, SENTINEL);
      await m(items, 'findActiveBarcode')(rc, SENTINEL);
      await m(items, 'updateItem')(rc, uid(2001), 1, { name: SENTINEL });
      await m(purchaseOrders, 'removePoLine')(rc, uid(8501), 1);
      await m(counters, 'allocateNumber')(rc, 'po', 'yy:26');
      stmts.push(...s);
    });
    expect(stmts.length).toBeGreaterThan(GETTERS.length);
    for (const s of stmts) {
      expect(s.text, s.text).toMatch(/\binventory\./);
      if (!/^\s*INSERT/i.test(s.text)) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/);                          // INSERT carries tenant_id as a bound column value (checked via values below)
      expect(s.values, s.text).toContain(A);                                                                              // the ctx tenant is a bound value
      expect(s.text, s.text).not.toContain(SENTINEL);
      expect(s.text, s.text).not.toContain(A);
      expect(s.text, s.text).not.toMatch(/\bDELETE\b/i);
    }
  });

  it('LIKE metacharacters in a prefix are literal: "%" and "_" match nothing, "gluc" matches case-insensitively', async () => {
    expect(await asApi(A, (rc) => m(items, 'listItems')(rc, { namePrefix: '%' }))).toEqual([]);
    expect(await asApi(A, (rc) => m(items, 'listItems')(rc, { codePrefix: '%' }))).toEqual([]);
    expect(await asApi(A, (rc) => m(items, 'listItems')(rc, { codePrefix: 'G_U' }))).toEqual([]);
    expect(await asApi(A, (rc) => m(suppliers, 'listSuppliers')(rc, { namePrefix: '%' }))).toEqual([]);
    expect(ids(await asApi(A, (rc) => m(items, 'listItems')(rc, { namePrefix: 'GLUC' })))).toEqual([uid(2001)]);
  });

  it('limit is clamped (0, negative, huge, NaN never reach SQL as-is)', async () => {
    expect((await asApi(A, (rc) => m(items, 'listItems')(rc, { limit: 0 }))).length).toBe(1);
    expect((await asApi(A, (rc) => m(items, 'listItems')(rc, { limit: -5 }))).length).toBe(1);
    expect((await asApi(A, (rc) => m(items, 'listItems')(rc, { limit: Number.NaN }))).length).toBeGreaterThanOrEqual(1);
    expect((await asApi(A, (rc) => m(items, 'listItems')(rc, { limit: 10 ** 9 }))).length).toBe(3);
  });
});

// ------------------------------------------------------------------------------------------------ index use (done_when)
describe.skipIf(!live)('T-03 index use (05-SCHEMA §10; EXPLAIN on the statements the repositories really send)', () => {
  const lotA = uid(4001);
  const EXPECT: Array<[string, string, (rc: Rc) => Promise<unknown>]> = [
    ['balances by store (non-zero)', 'stock_balances__tenant_id_store_nonzero__p_idx', (rc) => m(balances, 'listBalancesByStore')(rc, uid(1001))],
    ['balance by key (lot)', 'stock_balances__key__uq', (rc) => m(balances, 'getBalanceByKey')(rc, { storeId: uid(1001), itemId: uid(2001), lotId: lotA })],
    ['balance by key (unlotted)', 'stock_balances__key__uq', (rc) => m(balances, 'getBalanceByKey')(rc, { storeId: uid(1001), itemId: uid(2003), lotId: null })],
    ['balances by item', 'stock_balances__tenant_id_item_id__idx', (rc) => m(balances, 'listBalancesByItem')(rc, uid(2001))],
    ['ledger by store+item', 'stock_movements__tenant_id_store_item__idx', (rc) => m(movements, 'listMovementsByStoreItem')(rc, { storeId: uid(1001), itemId: uid(2001), limit: 50 })],
    ['movements of a document', 'stock_movements__tenant_id_doc__idx', (rc) => m(movements, 'listMovementsByDoc')(rc, { docType: 'stock_document', docId: uid(9001) })],
    ['lot history', 'stock_movements__tenant_id_lot__p_idx', (rc) => m(movements, 'listMovementsByLot')(rc, lotA)],
    ['rule match in consumers', 'consumption_rules__tenant_id_match__idx', (rc) => m(rules, 'listRulesForMatch')(rc, { ruleKind: 'per_test', testId: uid(7001), analyteId: null, instrumentId: uid(421), at: nowIso() })],
    ['rules by item (#69, uom lock)', 'consumption_rules__tenant_id_item_id__idx', (rc) => m(rules, 'listRulesByItem')(rc, uid(2001))],
    ['in-use lot (opened container)', 'opened_containers__tenant_id_in_use__p_idx', (rc) => m(containers, 'findInUseContainer')(rc, { instrumentId: uid(421), itemId: uid(2002), storeId: uid(1001) })],
    ['open-stability scan', 'opened_containers__tenant_id_open_expiry__p_idx', (rc) => m(containers, 'listOpenContainersExpiringBefore')(rc, iso(30 * 86_400_000))],
    ['fact dedupe', 'consumption_facts__basis__uq', (rc) => m(facts, 'findFactByBasisKey')(rc, 'basis-7201')],
    ['unresolved queue', 'consumption_facts__tenant_id_status__p_idx', (rc) => m(facts, 'listUnresolvedFacts')(rc, { limit: 50 })],
    ['expiry scan', 'lots__tenant_id_expiry_on__idx', (rc) => m(lots, 'listLotsExpiringBefore')(rc, day(60))],
    ['reorder scan', 'store_item_settings__tenant_id_reorder__p_idx', (rc) => m(stores, 'listReorderSettings')(rc, uid(1001))],
    ['alert list', 'alerts__tenant_id_status_kind__idx', (rc) => m(alerts, 'listAlerts')(rc, { status: 'open', alertKind: 'below_reorder', limit: 50 })],
    ['alert dedupe', 'alerts__tenant_id_dedupe__p_uq', (rc) => m(alerts, 'findOpenAlertByDedupeKey')(rc, 'below:2001:1001')],
    ['PO list by status', 'purchase_orders__tenant_id_status__idx', (rc) => m(purchaseOrders, 'listPos')(rc, { status: 'draft', limit: 50 })],
    ['PO list by supplier', 'purchase_orders__tenant_id_supplier__idx', (rc) => m(purchaseOrders, 'listPos')(rc, { supplierId: uid(3001), limit: 50 })],
    ['PO list by branch', 'purchase_orders__tenant_id_branch__idx', (rc) => m(purchaseOrders, 'listPos')(rc, { branchId: BRANCH_A, limit: 50 })],
    ['GRN list by store+status', 'goods_receipts__tenant_id_store_status__idx', (rc) => m(goodsReceipts, 'listGrns')(rc, { storeId: uid(1001), status: 'draft', limit: 50 })],
    ['GRN list by supplier (#49)', 'goods_receipts__tenant_id_supplier__idx', (rc) => m(goodsReceipts, 'listGrnsBySupplier')(rc, { supplierId: uid(3001), limit: 50 })],
    ['item list code prefix (#1)', 'items__tenant_id_item_code_prefix__idx', (rc) => m(items, 'listItems')(rc, { codePrefix: 'GLU' })],
    ['item list name prefix', 'items__tenant_id_lower_name__idx', (rc) => m(items, 'listItems')(rc, { namePrefix: 'gluc' })],
    ['supplier list name prefix (#17)', 'suppliers__tenant_id_lower_name__idx', (rc) => m(suppliers, 'listSuppliers')(rc, { namePrefix: 'alpha' })],
    ['counts by store+status (#63)', 'stock_counts__tenant_id_store_status__idx', (rc) => m(counts, 'listCounts')(rc, { storeId: uid(1001), status: 'open' })],
    ['bindings by store (#23, #14)', 'instrument_bindings__tenant_id_store__p_idx', (rc) => m(stores, 'listBindingsByStore')(rc, uid(1001))],
    ['PO draft lines', 'purchase_order_lines__tenant_id_po_line__p_uq', (rc) => m(purchaseOrders, 'listPoLines')(rc, uid(8301))],
    ['GRN draft lines', 'goods_receipt_lines__tenant_id_grn_line__p_uq', (rc) => m(goodsReceipts, 'listGrnLines')(rc, uid(8001))],
    ['transfer draft lines', 'transfer_lines__tenant_id_transfer_line__p_uq', (rc) => m(transfers, 'listTransferLines')(rc, uid(8701))],
    ['QC reconciliation instrument block', 'instrument_qc_daily__pk', (rc) => m(projections, 'getQcDaily')(rc, { businessDate: day(-1), instrumentId: uid(421) })],
    ['daily consumption report', 'consumption_daily__tenant_id_date__idx', (rc) => m(projections, 'listConsumptionDaily')(rc, { from: day(-3), to: day(0), storeId: uid(1001) })],
    ['test counts report', 'test_counts_daily__tenant_id_test__idx', (rc) => m(projections, 'listTestCountsByTest')(rc, { testId: uid(7001), from: day(-3), to: day(0) })],
  ];

  // The named index must be able to serve the statement whatever the planner's tie-break between equal-cost sibling indexes (same technique as C5 T-03 LD-92 / C14 T02):
  // every other index/unique constraint of its table is dropped inside the transaction (DDL is transactional; ROLLBACK restores them), seq scans are disabled.
  async function explainAll(stmts: Stmt[], expectedIndex?: string): Promise<{ indexes: Set<string>; seqScans: string[] }> {
    const indexes = new Set<string>();
    const seqScans: string[] = [];
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query("SET LOCAL search_path = ''");
      if (expectedIndex) {
        // every tenant table also has the (tenant_id, id) unique constraint, which wins ties on tiny tables: constraint-backed siblings go too (DROP CONSTRAINT ... CASCADE, rolled back below)
        const sib = await client.query(
          `SELECT CASE WHEN k.conname IS NULL THEN format('DROP INDEX %I.%I', n.nspname, c.relname)
                       ELSE format('ALTER TABLE %s DROP CONSTRAINT %I CASCADE', i.indrelid::regclass, k.conname) END AS ddl
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_constraint k ON k.conindid = i.indexrelid AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x')
            WHERE i.indrelid = (SELECT x.indrelid FROM pg_index x JOIN pg_class xc ON xc.oid = x.indexrelid JOIN pg_namespace xn ON xn.oid = xc.relnamespace
                                 WHERE xc.relname = $1 AND xn.nspname = 'inventory')
              AND c.relname <> $1`, [expectedIndex]);
        for (const r of sib.rows) await client.query(r.ddl);
      }
      for (const s of stmts) {
        const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${s.text}`, s.values)).rows[0]['QUERY PLAN'][0].Plan;
        const walk = (n: any) => {
          if (n['Index Name']) indexes.add(n['Index Name']);
          if (/Seq Scan/.test(n['Node Type']) && n['Schema'] === 'inventory') seqScans.push(n['Relation Name']);
          for (const c of n['Plans'] ?? []) walk(c);
        };
        walk(plan);
      }
      await client.query('ROLLBACK');
    } finally { client.release(); }
    return { indexes, seqScans };
  }

  it.each(EXPECT)('%s uses %s and no Seq Scan on an inventory table', async (name, index, call) => {
    const stmts = await asApiRb(A, async (rc, s) => { await call(rc); return s.map((x) => ({ ...x })); });
    expect(stmts.length).toBeGreaterThan(0);
    const { indexes, seqScans } = await explainAll(stmts, index);
    expect([...indexes], `plan indexes for ${name}: indexes=[${[...indexes].join(', ')}] seqScans=[${seqScans.join(', ')}]`).toContain(index);
    expect(seqScans).toEqual([]);
  });

  it('lookups by id (every getX) never Seq Scan', async () => {
    for (const [, , a, , get] of GETTERS) {
      const stmts = await asApiRb(A, async (rc, s) => { await get(rc, uid(a)); return s.map((x) => ({ ...x })); });
      expect((await explainAll(stmts)).seqScans, `get for ${a}`).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------------ semantics (oracle = fixture shape)
describe.skipIf(!live)('T-03 query semantics (filters, ordering, active-only)', () => {
  it('items: active only by default, ordered by item_code; prefixes and category filters', async () => {
    expect(ids(await asApi(A, (rc) => m(items, 'listItems')(rc, {})))).toEqual(uids(2002, 2001, 2003));
    expect(ids(await asApi(A, (rc) => m(items, 'listItems')(rc, {}, { includeInactive: true })))).toEqual(uids(2002, 2001, 2004, 2003));
    expect(ids(await asApi(A, (rc) => m(items, 'listItems')(rc, { codePrefix: 'GLU' })))).toEqual(uids(2001));
    expect(ids(await asApi(A, (rc) => m(items, 'listItems')(rc, { category: 'control' })))).toEqual(uids(2002));
    expect(ids(await asApi(A, (rc) => m(items, 'listItems')(rc, { limit: 2 })))).toEqual(uids(2002, 2001));
  });

  it('packs, barcodes, stores, suppliers, supplier items, reorder settings, bindings', async () => {
    expect(ids(await asApi(A, (rc) => m(items, 'listPacks')(rc, uid(2001))))).toEqual(uids(2201, 2202));
    expect(ids(await asApi(A, (rc) => m(items, 'listPacks')(rc, uid(2001), { includeInactive: true })))).toEqual(uids(2201, 2202, 2203));
    expect((await asApi(A, (rc) => m(items, 'findActiveBarcode')(rc, 'BC-GLU-1')))?.['item_id']).toBe(uid(2001));
    expect(await asApi(A, (rc) => m(items, 'findActiveBarcode')(rc, 'BC-OLD'))).toBeNull();                              // inactive
    expect(ids(await asApi(A, (rc) => m(items, 'listBarcodes')(rc, uid(2001))))).toEqual(uids(2401));
    expect(ids(await asApi(A, (rc) => m(stores, 'listStores')(rc, {})))).toEqual(uids(1002, 1001));
    expect(ids(await asApi(A, (rc) => m(stores, 'listStores')(rc, {}, { includeInactive: true })))).toEqual(uids(1002, 1001, 1003));
    expect(ids(await asApi(A, (rc) => m(stores, 'listStores')(rc, { branchId: BRANCH_A })))).toEqual(uids(1002, 1001));
    expect(await asApi(A, (rc) => m(stores, 'listStores')(rc, { branchId: uid(1) }))).toEqual([]);
    expect(ids(await asApi(A, (rc) => m(suppliers, 'listSuppliers')(rc, { namePrefix: 'alpha' })))).toEqual(uids(3001));
    expect(ids(await asApi(A, (rc) => m(suppliers, 'listSuppliers')(rc, { namePrefix: 'alpha' }, { includeInactive: true })))).toEqual(uids(3001, 3003));
    expect(ids(await asApi(A, (rc) => m(suppliers, 'listSupplierItemsByItem')(rc, uid(2001))))).toEqual(uids(3201));
    expect(ids(await asApi(A, (rc) => m(stores, 'listReorderSettings')(rc, uid(1001))))).toEqual(uids(3401));           // 3402 has no reorder level, 3403 is another store
    expect(ids(await asApi(A, (rc) => m(stores, 'listBindingsByStore')(rc, uid(1001))))).toEqual(uids(9401));
    expect(await asApi(A, (rc) => m(stores, 'listBindingsByStore')(rc, uid(1002)))).toEqual([]);                          // 9402 inactive
    expect(ids(await asApi(A, (rc) => m(stores, 'listBindingsByStore')(rc, uid(1002), { includeInactive: true })))).toEqual(uids(9402));
  });

  it('lots and balances', async () => {
    expect(ids(await asApi(A, (rc) => m(lots, 'listLotsExpiringBefore')(rc, '2026-12-15')))).toEqual(uids(4003, 4001));
    expect(await asApi(A, (rc) => m(lots, 'listLotsExpiringBefore')(rc, '2026-11-01'))).toEqual([]);
    expect((await asApi(A, (rc) => m(lots, 'getLotByNo')(rc, uid(2001), 'L-002')))?.['id']).toBe(uid(4002));
    expect(await asApi(A, (rc) => m(lots, 'getLotByNo')(rc, uid(2101), 'L-001'))).toBeNull();                              // B's item: not visible
    expect(ids(await asApi(A, (rc) => m(balances, 'listBalancesByStore')(rc, uid(1001))))).toEqual(uids(5001, 5003));      // 5002 is zero
    expect(ids(await asApi(A, (rc) => m(balances, 'listBalancesByItem')(rc, uid(2001))))).toEqual(uids(5001, 5002, 5004));
    expect((await asApi(A, (rc) => m(balances, 'getBalanceByKey')(rc, { storeId: uid(1001), itemId: uid(2003), lotId: null })))?.['id']).toBe(uid(5003));
    expect((await asApi(A, (rc) => m(balances, 'getBalanceByKey')(rc, { storeId: uid(1001), itemId: uid(2001), lotId: uid(4001) })))?.['id']).toBe(uid(5001));
    expect(await asApi(A, (rc) => m(balances, 'getBalanceByKey')(rc, { storeId: uid(1002), itemId: uid(2001), lotId: null }))).toBeNull();   // that key only exists with a lot
  });

  it('movements and documents', async () => {
    expect(ids(await asApi(A, (rc) => m(movements, 'listMovementsByStoreItem')(rc, { storeId: uid(1001), itemId: uid(2001) })))).toEqual(uids(6003, 6002, 6001));
    expect(ids(await asApi(A, (rc) => m(movements, 'listMovementsByStoreItem')(rc, { storeId: uid(1001), itemId: uid(2001), limit: 2 })))).toEqual(uids(6003, 6002));
    expect(ids(await asApi(A, (rc) => m(movements, 'listMovementsByDoc')(rc, { docType: 'stock_document', docId: uid(9001) })))).toEqual(uids(6002));
    expect(await asApi(A, (rc) => m(movements, 'listMovementsByDoc')(rc, { docType: 'transfer', docId: uid(9001) }))).toEqual([]);
    expect(ids(await asApi(A, (rc) => m(movements, 'listMovementsByLot')(rc, uid(4001))))).toEqual(uids(6001, 6002, 6003));
    expect(ids(await asApi(A, (rc) => m(documents, 'listStockDocuments')(rc, { storeId: uid(1001) })))).toEqual(uids(9002, 9001));
    expect(ids(await asApi(A, (rc) => m(documents, 'listStockDocuments')(rc, { storeId: uid(1001), docKind: 'issue' })))).toEqual(uids(9001));
    expect(ids(await asApi(A, (rc) => m(documents, 'listStockDocumentLines')(rc, uid(9001))))).toEqual(uids(9101, 9102));
  });

  it('purchase orders, goods receipts, transfers, counts, containers', async () => {
    expect(ids(await asApi(A, (rc) => m(purchaseOrders, 'listPos')(rc, {})))).toEqual(uids(8303, 8302, 8301));
    expect(ids(await asApi(A, (rc) => m(purchaseOrders, 'listPos')(rc, { status: 'draft' })))).toEqual(uids(8301));
    expect(ids(await asApi(A, (rc) => m(purchaseOrders, 'listPos')(rc, { supplierId: uid(3001) })))).toEqual(uids(8303, 8301));
    expect(ids(await asApi(A, (rc) => m(purchaseOrders, 'listPos')(rc, { branchId: BRANCH_A, status: 'approved' })))).toEqual(uids(8302));
    expect(ids(await asApi(A, (rc) => m(goodsReceipts, 'listGrns')(rc, { storeId: uid(1001) })))).toEqual(uids(8001, 8002));
    expect(ids(await asApi(A, (rc) => m(goodsReceipts, 'listGrns')(rc, { storeId: uid(1001), status: 'posted' })))).toEqual(uids(8002));
    expect(ids(await asApi(A, (rc) => m(goodsReceipts, 'listGrnsBySupplier')(rc, { supplierId: uid(3001) })))).toEqual(uids(8001));
    expect(idSet(await asApi(A, (rc) => m(transfers, 'listTransfersFrom')(rc, { storeId: uid(1001) })))).toEqual(usorted(8701, 8702));
    expect(ids(await asApi(A, (rc) => m(transfers, 'listTransfersFrom')(rc, { storeId: uid(1001), status: 'draft' })))).toEqual(uids(8701));
    expect(idSet(await asApi(A, (rc) => m(transfers, 'listTransfersTo')(rc, { storeId: uid(1002) })))).toEqual(usorted(8701, 8702));
    expect(await asApi(A, (rc) => m(transfers, 'listTransfersTo')(rc, { storeId: uid(1001) }))).toEqual([]);
    expect(idSet(await asApi(A, (rc) => m(counts, 'listCounts')(rc, { storeId: uid(1001) })))).toEqual(usorted(8901, 8903));
    expect(ids(await asApi(A, (rc) => m(counts, 'listCounts')(rc, { storeId: uid(1001), status: 'open' })))).toEqual(uids(8901));
    expect(idSet(await asApi(A, (rc) => m(counts, 'listCountLines')(rc, uid(8901))))).toEqual(usorted(8921, 8922));
    expect((await asApi(A, (rc) => m(containers, 'findInUseContainer')(rc, { instrumentId: uid(421), itemId: uid(2002), storeId: uid(1001) })))?.['id']).toBe(uid(9301));   // 9302 is finished
    expect(await asApi(A, (rc) => m(containers, 'findInUseContainer')(rc, { instrumentId: uid(422), itemId: uid(2002), storeId: uid(1001) }))).toBeNull();
    expect(ids(await asApi(A, (rc) => m(containers, 'listOpenContainersExpiringBefore')(rc, iso(30 * 86_400_000))))).toEqual(uids(9301));
    expect(await asApi(A, (rc) => m(containers, 'listOpenContainersExpiringBefore')(rc, iso(10 * 86_400_000)))).toEqual([]);
  });

  it('rules, facts, alerts', async () => {
    expect(ids(await asApi(A, (rc) => m(rules, 'listRulesByItem')(rc, uid(2001))))).toEqual(uids(7001, 7002, 7003));
    expect(ids(await asApi(A, (rc) => m(rules, 'listRulesByItem')(rc, uid(2002))))).toEqual(uids(7004));
    expect(ids(await asApi(A, (rc) => m(rules, 'listRulesByItem')(rc, uid(2002), { includeInactive: true })))).toEqual(uids(7004, 7005));
    const match = (instrumentId: string | null, at = nowIso()) => asApi(A, (rc) => m(rules, 'listRulesForMatch')(rc, { ruleKind: 'per_test', testId: uid(7001), analyteId: null, instrumentId, at }));
    expect(ids(await match(uid(421)))).toEqual(uids(7002, 7001));                                                          // instrument-specific first; 7003 is superseded (effective_to < now)
    expect(ids(await match(uid(422)))).toEqual(uids(7001));
    expect(await match(uid(421), iso(-45 * 86_400_000))).toEqual([]);                                                     // before any rule was effective
    expect(ids(await asApi(A, (rc) => m(rules, 'listRulesForMatch')(rc, { ruleKind: 'per_day', testId: null, analyteId: null, instrumentId: uid(421), at: nowIso() })))).toEqual(uids(7004));
    expect((await asApi(A, (rc) => m(facts, 'findFactByBasisKey')(rc, 'basis-7201')))?.['id']).toBe(uid(7201));
    expect(await asApi(A, (rc) => m(facts, 'findFactByBasisKey')(rc, 'basis-7301'))).toBeNull();
    expect(ids(await asApi(A, (rc) => m(facts, 'listUnresolvedFacts')(rc, {})))).toEqual(uids(7203, 7201));                 // oldest first; 7202 is posted
    expect(ids(await asApi(A, (rc) => m(alerts, 'listAlerts')(rc, {})))).toEqual(uids(9502, 9501, 9503));
    expect(ids(await asApi(A, (rc) => m(alerts, 'listAlerts')(rc, { status: 'open' })))).toEqual(uids(9501));
    expect(ids(await asApi(A, (rc) => m(alerts, 'listAlerts')(rc, { alertKind: 'expiry_soon' })))).toEqual(uids(9502));
    expect((await asApi(A, (rc) => m(alerts, 'findOpenAlertByDedupeKey')(rc, 'expiry:4001')))?.['id']).toBe(uid(9502));      // acknowledged still counts as not resolved
    expect(await asApi(A, (rc) => m(alerts, 'findOpenAlertByDedupeKey')(rc, 'gap:421:old'))).toBeNull();                    // resolved
  });

  it('alerts: the unresolved dedupe key is unique per tenant (23505) but reusable once resolved', async () => {
    const base = { alert_kind: 'below_reorder', dedupe_key: 'below:2001:1001', first_raised_at: nowIso(), last_raised_at: nowIso() };
    expect((await rejection(asApiRb(A, (rc) => m(alerts, 'insertAlert')(rc, { id: uid(19400), ...base }))))?.code).toBe('23505');
    await asApiRb(A, (rc) => m(alerts, 'insertAlert')(rc, { id: uid(19401), ...base, dedupe_key: 'gap:421:old' }));         // the only holder of that key is resolved
  });

  it('coded sets: tenant rows shadow global rows of the same group+code; inactive rows hidden; each tenant sees its own', async () => {
    const wastageA = await asApi(A, (rc) => m(codedSets, 'listReasons')(rc, 'wastage'));
    const byCode = (rows: Row[], code: string) => rows.filter((r) => r['code'] === code);
    expect(byCode(wastageA, 'spillage').map((r) => [r['display'], r['scope']])).toEqual([['Spillage (tenant label)', 'tenant']]);
    expect(byCode(wastageA, 'damaged').map((r) => r['scope'])).toEqual(['global']);
    expect(byCode(wastageA, 'lab_custom').length).toBe(1);
    expect(byCode(wastageA, 'old_one')).toEqual([]);
    expect(wastageA.every((r) => r['reason_group'] === 'wastage')).toBe(true);
    const wastageB = await asApi(B, (rc) => m(codedSets, 'listReasons')(rc, 'wastage'));
    expect(byCode(wastageB, 'spillage').map((r) => r['display'])).toEqual(['Spillage B']);
    expect(byCode(wastageB, 'lab_custom')).toEqual([]);
    expect(await asApi(A, (rc) => m(codedSets, 'listReasons')(rc, 'no_such_group'))).toEqual([]);
    const taxA = await asApi(A, (rc) => m(codedSets, 'listTaxCodes')(rc));
    expect(taxA.map((r) => r['code'])).toEqual(expect.arrayContaining(['VAT', 'LOCALTAX']));
    expect(taxA.map((r) => r['code'])).not.toContain('OLDTAX');
    expect(taxA.every((r) => !('rate_bp' in r) && !('rate' in r))).toBe(true);                                            // no rate column (08 A2.2)
    const uom = (await asApi(A, (rc) => m(codedSets, 'listUom')(rc))).map((r) => r['code']);
    expect(uom).toEqual(expect.arrayContaining(['test', 'ml', 'piece', 'box']));
  });

  it('projections: ranges, QC counter (read + upsert increment)', async () => {
    expect(idSet(await asApi(A, (rc) => m(projections, 'listConsumptionDaily')(rc, { from: day(-3), to: day(0) })))).toEqual(usorted(9701, 9702));
    expect(idSet(await asApi(A, (rc) => m(projections, 'listConsumptionDaily')(rc, { from: day(-3), to: day(0), storeId: uid(1002) })))).toEqual([]);
    expect(await asApi(A, (rc) => m(projections, 'listConsumptionDaily')(rc, { from: day(-30), to: day(-10) }))).toEqual([]);
    expect(idSet(await asApi(A, (rc) => m(projections, 'listTestCountsByTest')(rc, { testId: uid(7001), from: day(-3), to: day(0) })))).toEqual(usorted(9721, 9722));
    expect((await asApi(A, (rc) => m(projections, 'getQcDaily')(rc, { businessDate: day(-1), instrumentId: uid(421) })))?.['qc_observations']).toBe(3);
    expect(await asApi(A, (rc) => m(projections, 'getQcDaily')(rc, { businessDate: day(-1), instrumentId: uid(431) }))).toBeNull();     // B's instrument
    await asApiRb(A, async (rc) => {
      expect((await m(projections, 'incrementQcObservations')(rc, { businessDate: day(-1), instrumentId: uid(421) }))['qc_observations']).toBe(4);
      expect((await m(projections, 'incrementQcObservations')(rc, { businessDate: day(-1), instrumentId: uid(421) }))['qc_observations']).toBe(5);
      const fresh = await m(projections, 'incrementQcObservations')(rc, { businessDate: day(-2), instrumentId: uid(421) });          // created lazily (P-22)
      expect([fresh['qc_observations'], fresh['tenant_id']]).toEqual([1, A]);
    });
    expect((await sql('SELECT qc_observations FROM inventory.instrument_qc_daily WHERE tenant_id = $1 AND instrument_id = $2 AND business_date = $3', [A, uid(421), day(-1)]))[0]!['qc_observations']).toBe(3);
  });
});

// ------------------------------------------------------------------------------------------------ settings + number counters (lazy rows, P-22; concurrency)
describe.skipIf(!live)('T-03 settings (lazy row) and number counters', () => {
  afterAll(async () => {
    if (!live) return;
    await sql('DELETE FROM inventory.settings WHERE tenant_id = $1', [B]);
    await sql("DELETE FROM inventory.number_counters WHERE series <> 'po' OR tenant_id = $1", [B]);
  });

  it('getSettings returns the row or null; ensureSettings creates the defaults once (ON CONFLICT DO NOTHING) and returns the same row twice', async () => {
    expect((await asApi(A, (rc) => m(settings, 'getSettings')(rc)))?.['id']).toBe(uid(9601));
    expect(await asApi(B, (rc) => m(settings, 'getSettings')(rc))).toBeNull();
    await asApiRb(B, async (rc, stmts) => {
      const first = await m(settings, 'ensureSettings')(rc);
      const second = await m(settings, 'ensureSettings')(rc);
      expect(second['id']).toBe(first['id']);
      expect([first['tenant_id'], first['version'], first['vat_in_cost'], first['expiry_alert_days'], first['po_no_pattern'], first['consumption_enabled_at']]).toEqual([B, 1, true, 30, 'PO{yy}{seq:6}', null]);
      expect(stmts.some((s) => /ON\s+CONFLICT/i.test(s.text))).toBe(true);
    });
    expect(await sql('SELECT 1 FROM inventory.settings WHERE tenant_id = $1', [B])).toEqual([]);                          // rolled back
  });

  it('ensureSettings under 5 concurrent first calls leaves exactly one row', async () => {
    const rows = await Promise.all([1, 2, 3, 4, 5].map(() => asApi(B, (rc) => m(settings, 'ensureSettings')(rc))));
    expect(new Set(rows.map((r) => r['id'])).size).toBe(1);
    expect((await sql('SELECT count(*)::int AS n FROM inventory.settings WHERE tenant_id = $1', [B]))[0]!['n']).toBe(1);
  });

  it('updateSettings is optimistic and tenant-scoped; the check constraints surface (23514)', async () => {
    await asApiRb(A, async (rc) => {
      const r = await m(settings, 'updateSettings')(rc, 1, { expiry_alert_days: 45, vat_in_cost: false });
      expect([r['version'], r['expiry_alert_days'], r['vat_in_cost']]).toEqual([2, 45, false]);
      expect(isLimsError(await rejection(m(settings, 'updateSettings')(rc, 1, { expiry_alert_days: 50 })), 'common.version_conflict')).toBe(true);
      await rejection(m(settings, 'updateSettings')(rc, 2, { tenant_id: B }));
    });
    expect((await rejection(asApiRb(A, (rc) => m(settings, 'updateSettings')(rc, 1, { expiry_alert_days: 400 }))))?.code).toBe('23514');
  });

  it('allocateNumber: continues the stored counter, creates a missing (series, period) lazily from 1, is per tenant, rejects bad series/period', async () => {
    await asApiRb(A, async (rc, _s, raw) => {
      expect(await m(counters, 'allocateNumber')(rc, 'po', 'yy:26')).toBe(5);
      expect(await m(counters, 'allocateNumber')(rc, 'po', 'yy:26')).toBe(6);
      expect(await m(counters, 'allocateNumber')(rc, 'grn', 'fy:2082/83')).toBe(1);
      expect(await m(counters, 'allocateNumber')(rc, 'grn', 'fy:2082/83')).toBe(2);
      expect((await raw.query("SELECT next_value::int AS n FROM inventory.number_counters WHERE tenant_id = $1 AND series = 'po'", [A])).rows[0]['n']).toBe(7);
    });
    expect(await asApiRb(B, (rc) => m(counters, 'allocateNumber')(rc, 'po', 'yy:26'))).toBe(1);                              // B has its own series
    expect((await rejection(asApiRb(A, (rc) => m(counters, 'allocateNumber')(rc, 'bogus', 'all'))))?.code).toBe('23514');
    await rejection(asApiRb(A, (rc) => m(counters, 'allocateNumber')(rc, 'po', 'x'.repeat(17))));
  });

  it('allocateNumber: 20 concurrent committed allocations get 1..20 exactly once each (no duplicate numbers, gaps allowed only on rollback)', async () => {
    const got = await Promise.all(Array.from({ length: 20 }, () => asApi(A, (rc) => m(counters, 'allocateNumber')(rc, 'doc', 'all'))));
    expect([...got].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await sql("SELECT next_value::int AS n FROM inventory.number_counters WHERE tenant_id = $1 AND series = 'doc' AND period_key = 'all'", [A]))[0]!['n']).toBe(21);
  }, 60_000);
});
