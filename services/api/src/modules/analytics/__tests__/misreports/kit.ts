// T0B-MISREPORTS-1 kit (LD-321, LD-325, LD-342 / A39). Not a test file. Live PG17 fixtures for the MIS report tests, synthetic data only.
// Env: LIMS_TEST_APP_URL (lims_api, RLS on) / LIMS_TEST_SUPER_URL (owner side, no RLS) -- tests/analytics/T0B-MISREPORTS-1.pg.sh boots a throwaway PG17 migrated through
// every db/migrations file (incl. 20261117210000 sales hierarchy and 20261117230000 report codes) like tests/frontdesk/FD-T03.pg.sh.
//
// PINNED SEAMS (the spec leaves them open; the writer may dispute through the reviewer). They live in services/api/src/modules/analytics/service/misReports.service.ts:
//   MIS_REPORT_CODES: readonly string[]                       the 11 codes of x-report-definitions, contract order
//   runMisReport(ctx, code, { range: {from, to}, scope, filters?, limit?, cursor? })
//        -> { columns: {key,label,kind}[], rows: Record<string, string|number>[], next_cursor?: string }
//      range = business dates, BOTH INCLUSIVE (the contract examples run from == to for one day and 01..30 for a month; Period.to of the older reports is exclusive).
//      ONE parameterised SQL statement per page (+ at most 5 label / settings statements), keyset paging by (default_sort column, id); rows already in the order of
//      default_sort; columns = the contract columns in contract order, kind from the type (string|date|datetime -> text, integer -> count, integer_paisa -> paisa,
//      basis_points -> bp), label = the contract title. Tenant = ctx.tenantId (explicit predicate: it must hold even where RLS is bypassed).
//      Errors (standard): range longer than 366 days, from > to, a result above the contract row_cap, an unknown filter key, a malformed uuid / min_repeat_count
//      -> LimsError common.validation_failed 400 with errors[]; a bad cursor -> common.invalid_cursor.
//   streamMisReport(ctx, code, { range, scope, filters?, chunkRows? }) -> AsyncIterable<Record<string,string|number>[]>   chunks of <= chunkRows (default 1000), pulled lazily.
//   export/CsvWriter.ts  writeCsvStream(table: {meta, columns}, chunks: AsyncIterable<Row[]>) -> AsyncIterable<Uint8Array>   same bytes as writeCsv, lazily.
//   export/XlsxWriter.ts writeXlsxStream(table: {meta, columns}, chunks) -> AsyncIterable<Uint8Array>                       same cells as writeXlsx, lazily.
//   export/reportTable.ts buildReport / checkReportParams know the 11 codes (SPECS), params.filters keys as in ExportParams of analytics.yaml.
//   ctx needs: tenantId, tx.query, core.{branches,centres,memberships.list} (labels only), metrics.inc, log.warn, now().
import { uid, appTx, superTx, TENANT_A, TENANT_B, BRANCH, CENTRE, SYS_ACTOR, type Tx } from '../../../frontdesk/__tests__/integration/helpers.js';

export { TENANT_A, TENANT_B, BRANCH, CENTRE, appTx, superTx, uid };

// ---------------------------------------------------------------- deterministic pseudo random
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- the world
export interface Line { id: string; itemId: string; testId: string; testCode: string; deptId: string; gross: number; discount: number; net: number }
export interface Bill {
  id: string; no: string; seq: number; orderId: string; patientId: string; patientCode: string; centreId: string; partyId: string | null; referrerId: string | null;
  visit: 'opd' | 'ipd'; day: string; lines: Line[]; gross: number; discount: number; net: number; paid: number; collectorId: string | null; payId: string | null;
}
export interface WorldSpec {
  tenant: string; branch: string; centres: string[]; bills: number; firstDay: string; days: number; seed: number; tag: string;
  parties: string[]; referrers: string[]; depts: string[]; tests: { id: string; code: string; deptIdx: number }[]; collectors: string[]; patients: number;
}
export interface World {
  spec: WorldSpec; bills: Bill[]; patients: { id: string; code: string }[]; ids: Record<string, string[]>;
  reps?: { top: string; sub: string; designations: string[] }; collections: { id: string; collector: string; day: string; centreId: string }[];
}
export const FY = '2076/77';

/** A spec whose every id is fresh (UUIDv7) so two tenants never share one. */
export function makeSpec(over: Partial<WorldSpec> & Pick<WorldSpec, 'tenant' | 'bills'>): WorldSpec {
  const tenantIsA = over.tenant === TENANT_A;
  const depts = [uid(), uid(), uid()];
  return {
    branch: tenantIsA ? BRANCH.a : BRANCH.b, centres: [tenantIsA ? CENTRE.a : CENTRE.b, uid()], firstDay: '2020-06-01', days: 30, seed: 7, tag: 'MIS',
    parties: [uid(), uid(), uid(), uid()], referrers: [uid(), uid(), uid()], depts,
    tests: Array.from({ length: 6 }, (_, i) => ({ id: uid(), code: `MT${i}`, deptIdx: i % 3 })), collectors: [uid(), uid()], patients: Math.max(8, Math.floor(over.bills / 3)),
    ...over,
  };
}

export function makeBills(spec: WorldSpec): { bills: Bill[]; patients: { id: string; code: string }[] } {
  const r = rng(spec.seed);
  const patients = Array.from({ length: spec.patients }, (_, i) => ({ id: uid(), code: `${spec.tag}-P${String(i).padStart(6, '0')}` }));
  const bills: Bill[] = [];
  for (let i = 0; i < spec.bills; i++) {
    const p = pick(r, patients);
    const nLines = 1 + Math.floor(r() * 3);
    const lines: Line[] = Array.from({ length: nLines }, () => {
      const t = pick(r, spec.tests); const gross = (1 + Math.floor(r() * 40)) * 5000; const discount = r() < 0.3 ? Math.floor(r() * 10) * 500 : 0;
      return { id: uid(), itemId: uid(), testId: t.id, testCode: t.code, deptId: spec.depts[t.deptIdx]!, gross, discount, net: gross - discount };
    });
    const net = sum(lines.map((l) => l.net)); const credit = r() < 0.4; const collector = credit ? null : pick(r, spec.collectors);
    const paid = credit ? 0 : r() < 0.7 ? net : Math.floor(net / 2);
    bills.push({
      id: uid(), no: `${spec.tag}-${i + 1}`, seq: i + 1, orderId: uid(), patientId: p.id, patientCode: p.code, centreId: pick(r, spec.centres),
      partyId: credit ? pick(r, spec.parties) : null, referrerId: r() < 0.75 ? pick(r, spec.referrers) : null, visit: r() < 0.25 ? 'ipd' : 'opd',
      day: addDays(spec.firstDay, Math.floor(r() * spec.days)), lines, gross: sum(lines.map((l) => l.gross)), discount: sum(lines.map((l) => l.discount)), net, paid,
      collectorId: collector, payId: paid > 0 ? uid() : null,
    });
  }
  return { bills, patients };
}

// ---------------------------------------------------------------- bulk insert (superuser, triggers + FKs off: fixtures only; CHECK constraints still apply)
async function ins(tx: Tx, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 4000) {
    const part = rows.slice(i, i + 4000);
    const cols = Object.keys(part[0]!).map((c) => `"${c}"`).join(',');
    await tx.query(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(part)]);
  }
}
const audit = { created_by: SYS_ACTOR, updated_by: SYS_ACTOR };
const at = (day: string, hh = '06:00:00') => `${day}T${hh}Z`; // 11:45 Asia/Kathmandu on the same business day

export async function seedWorld(spec: WorldSpec): Promise<World> {
  const { bills, patients } = makeBills(spec);
  const t = spec.tenant;
  const ids: Record<string, string[]> = { patients: patients.map((p) => p.id), orders: [], items: [], invoices: [], lines: [], ledger: [], memberships: [...spec.collectors], collections: [] };
  const collections: World['collections'] = [];
  await superTx(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await ins(tx, 'core.memberships', spec.collectors.map((id, i) => ({ id, tenant_id: t, user_id: uid(), actor_type: 'user', status: 'active', created_by: SYS_ACTOR, updated_by: SYS_ACTOR, version: 1 + 0 * i })));
    await ins(tx, 'frontdesk.patients', patients.map((p, i) => ({
      id: p.id, tenant_id: t, patient_code: p.code, full_name: `Synthetic Patient ${i}`, name_search: `synthetic patient ${i}`, sex: 'female', birth_on: '1990-01-01',
      phone_e164: '+9779800000001', source: 'front_desk', registered_centre_id: spec.centres[0], ...audit })));
    await ins(tx, 'frontdesk.orders', bills.map((b, i) => ({
      id: b.orderId, tenant_id: t, branch_id: spec.branch, centre_id: b.centreId, patient_id: b.patientId, registration_no: `${spec.tag}-R${i + 1}`, status: 'registered',
      visit_type: b.visit, billing_mode: b.partyId ? 'credit' : 'cash', credit_party_id: b.partyId, referrer_id: b.referrerId, priority: 'routine', collection_mode: 'walk_in',
      source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1, registered_at: at(b.day), ...audit })));
    const items = bills.flatMap((b) => b.lines.map((l) => ({
      id: l.itemId, tenant_id: t, order_id: b.orderId, centre_id: b.centreId, orderable_id: l.testId, orderable_kind: 'test', code: l.testCode, name: `Test ${l.testCode}`,
      test_ids: [l.testId], department_id: l.deptId, priority: 'routine', outsourced: false, status: 'active', unit_price_paisa: l.gross, price_list_id: uid(), price_list_version: 1,
      price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1, ...audit })));
    await ins(tx, 'frontdesk.order_items', items);
    await ins(tx, 'billing.invoices', bills.map((b) => ({
      id: b.id, tenant_id: t, branch_id: spec.branch, centre_id: b.centreId, series: 'INV', fiscal_year_bs: FY, invoice_seq: b.seq, invoice_no: b.no, invoice_kind: 'tax_invoice',
      purpose: 'registration', order_id: b.orderId, patient_id: b.patientId, credit_party_id: b.partyId, referrer_id: b.referrerId, buyer_name: 'Synthetic Buyer', seller_name: 'Synthetic Lab',
      issued_at: at(b.day), invoice_date_bs: '2077-02-19', gross_paisa: b.gross, discount_paisa: b.discount, exempt_paisa: b.net, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0,
      net_paisa: b.net, prices_include_tax: false, quote_fingerprint: 'a'.repeat(64), status: 'issued', is_active: true, cbms_state: 'not_required', ...audit })));
    await ins(tx, 'billing.invoice_lines', bills.flatMap((b) => b.lines.map((l, k) => ({
      id: l.id, tenant_id: t, invoice_id: b.id, centre_id: b.centreId, line_no: k + 1, line_kind: 'orderable', order_item_id: l.itemId, orderable_id: l.testId, orderable_kind: 'test',
      code: l.testCode, name: `Test ${l.testCode}`, department_id: l.deptId, quantity: 1, unit_price_paisa: l.gross, gross_paisa: l.gross, discount_paisa: l.discount,
      exempt_paisa: l.net, taxable_paisa: 0, vat_treatment: 'exempt', vat_paisa: 0, other_tax_paisa: 0, net_paisa: l.net, created_by: SYS_ACTOR }))));
    await ins(tx, 'billing.ledger_entries', bills.filter((b) => b.payId).map((b) => ({
      id: b.payId, tenant_id: t, branch_id: spec.branch, centre_id: b.centreId, order_id: b.orderId, invoice_id: b.id, entry_kind: 'payment', capture_kind: 'manual', method_code: 'cash',
      amount_paisa: b.paid, fiscal_year_bs: FY, collected_by_membership_id: b.collectorId ?? spec.collectors[0], business_date: b.day, created_by: SYS_ACTOR })));
    for (const b of bills) {
      ids.orders!.push(b.orderId); ids.invoices!.push(b.id); ids.lines!.push(...b.lines.map((l) => l.id)); ids.items!.push(...b.lines.map((l) => l.itemId));
      if (b.payId) ids.ledger!.push(b.payId);
    }
    // home collections: every 5th bill was collected by a collector (applied), on the bill day
    const coll = bills.filter((_, i) => i % 5 === 0).map((b) => ({ id: uid(), collector: spec.collectors[b.seq % spec.collectors.length]!, day: b.day, centreId: b.centreId, b }));
    await ins(tx, 'homecollection.collections', coll.map((c) => ({
      id: c.id, tenant_id: t, centre_id: c.centreId, visit_id: uid(), specimen_id: uid(), order_id: c.b.orderId, mutation_id: uid(), client_mutation_id: uid(),
      collected_by_membership_id: c.collector, scan_method: 'manual', barcode_verified: false, collected_at: at(c.day, '05:00:00'), collected_at_device: at(c.day, '05:00:00'),
      status: 'applied', ...audit })));
    for (const c of coll) { ids.collections!.push(c.id); collections.push({ id: c.id, collector: c.collector, day: c.day, centreId: c.centreId }); }
  }, t);
  return { spec, bills, patients, ids, collections };
}

/** Sales hierarchy for the sales_representative report: top (level 7) manages sub (level 8); parties[0] -> top all month, parties[1] -> top from day 16, parties[2] -> sub, parties[3] unassigned. */
export async function seedSales(w: World): Promise<{ top: string; sub: string; mid: string }> {
  const t = w.spec.tenant; const [d7, d8] = [uid(), uid()]; const top = uid(), sub = uid(); const mid = addDays(w.spec.firstDay, 15);
  await superTx(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await ins(tx, 'partners.sales_designation', [{ id: d7, tenant_id: t, name: 'Synthetic head', level: 7, ...audit }, { id: d8, tenant_id: t, name: 'Synthetic executive', level: 8, ...audit }]);
    await ins(tx, 'partners.sales_representative', [
      { id: top, tenant_id: t, name: 'Synthetic Head Rep', designation_id: d7, ...audit }, { id: sub, tenant_id: t, name: 'Synthetic Exec Rep', designation_id: d8, manager_id: top, ...audit }]);
    await ins(tx, 'partners.party_sales_assignment', [
      { id: uid(), tenant_id: t, party_kind: 'credit_party', party_id: w.spec.parties[0], representative_id: top, effective_from: w.spec.firstDay, ...audit },
      { id: uid(), tenant_id: t, party_kind: 'credit_party', party_id: w.spec.parties[1], representative_id: top, effective_from: mid, ...audit },
      { id: uid(), tenant_id: t, party_kind: 'credit_party', party_id: w.spec.parties[2], representative_id: sub, effective_from: w.spec.firstDay, ...audit }]);
    w.ids.reps = [top, sub]; w.ids.designations = [d7, d8];
  }, t);
  w.reps = { top, sub, designations: [d7, d8] };
  return { top, sub, mid };
}

export async function cleanupWorld(w: World): Promise<void> {
  const t = w.spec.tenant; const del = async (tx: Tx, table: string, ids?: string[]) => { if (ids?.length) await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [t, ids]); };
  await superTx(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await del(tx, 'homecollection.collections', w.ids.collections); await del(tx, 'billing.ledger_entries', w.ids.ledger);
    await del(tx, 'billing.invoice_lines', w.ids.lines); await del(tx, 'billing.invoices', w.ids.invoices);
    await del(tx, 'frontdesk.order_items', w.ids.items); await del(tx, 'frontdesk.orders', w.ids.orders); await del(tx, 'frontdesk.patients', w.ids.patients);
    if (w.ids.reps) {
      await tx.query('DELETE FROM partners.party_sales_assignment WHERE tenant_id = $1 AND representative_id = ANY($2::uuid[])', [t, w.ids.reps]);
      await del(tx, 'partners.sales_representative', w.ids.reps); await del(tx, 'partners.sales_designation', w.ids.designations);
    }
    await del(tx, 'core.memberships', w.ids.memberships);
  }, t);
}

// ---------------------------------------------------------------- report context over a real tx
export interface Counted { ctx: any; statements: string[] }
/** mode 'rls': lims_api transaction with the tenant's claims (RLS on). mode 'owner': superuser (RLS bypassed): only the explicit tenant predicate can keep tenants apart. */
export async function withCtx<T>(w: World, mode: 'rls' | 'owner', fn: (c: Counted) => Promise<T>): Promise<T> {
  const run = mode === 'rls' ? (f: (tx: Tx) => Promise<T>) => appTx(w.spec.tenant, f) : (f: (tx: Tx) => Promise<T>) => superTx(f, w.spec.tenant);
  return run(async (raw) => {
    const statements: string[] = [];
    const tx = { query: async (text: string, values?: unknown[]) => { statements.push(text); return raw.query(text, values); } };
    const ctx = {
      tenantId: w.spec.tenant, tx, now: () => new Date().toISOString(), requestId: uid(), operationId: 'createAnalyticsExport', actor: { type: 'user', id: SYS_ACTOR },
      metrics: { inc: () => undefined }, log: { info() {}, warn() {}, error() {}, debug() {} },
      core: {
        branches: async () => [{ id: w.spec.branch, name: 'Synthetic branch', isActive: true }],
        centres: async () => w.spec.centres.map((id, i) => ({ id, name: `Synthetic centre ${i}`, isActive: true, branchId: w.spec.branch })),
        memberships: { list: async () => w.spec.collectors.map((id, i) => ({ membershipId: id, displayName: `Collector ${i + 1}`, isActive: true })) },
      },
    };
    return fn({ ctx, statements });
  });
}
export const ALL = { all: true, centreIds: [] as string[] } as const;
export const rangeOf = (from: string, to: string) => ({ from, to });

export async function misReports(): Promise<{ runMisReport: (ctx: any, code: string, a: any) => Promise<any>; streamMisReport: (ctx: any, code: string, a: any) => AsyncIterable<any[]>; MIS_REPORT_CODES: readonly string[] }> {
  return (await import('../../service/misReports.service.js')) as any;
}
/** Every page of a report through the cursor. */
export async function allPages(ctx: any, code: string, a: any, limit: number): Promise<any[]> {
  const { runMisReport } = await misReports(); const out: any[] = []; let cursor: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const p = await runMisReport(ctx, code, { ...a, limit, ...(cursor ? { cursor } : {}) });
    out.push(...p.rows); cursor = p.next_cursor; if (!cursor) return out;
  }
  throw new Error('paging did not end');
}
export async function ownerSql(sql: string, values: unknown[] = []): Promise<any[]> { return superTx(async (tx) => (await tx.query(sql, values)).rows); }
