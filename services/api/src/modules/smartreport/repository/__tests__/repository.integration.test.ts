// C14 T02 — repositories for the smartreport tables: explicit tenant filter, optimistic version updates, index use (06-IMPLEMENTATION-PLAN row T02).
// done_when: "every query in 02-TRD uses an index of 05-SCHEMA §5 (EXPLAIN assertion for queue, live-summary, rules-by-kind)". Tests: integration. ACs: none.
// Security: REQ-SEC-022/023/024 (07-SECURITY): "repos add tenant_id = $tenant explicitly"; tenant A never reads/changes tenant B (404 parity: other tenant's id behaves like an unknown id).
// Needs the migrated+seeded database that tests/db/c14-t02/run.sh starts (LIMS_TEST_DATABASE_URL = role lims_api, RLS on; LIMS_TEST_ADMIN_DATABASE_URL = superuser, RLS bypassed).
// Without them the DB tests skip, except under LIMS_C14T02_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails. Fixtures: tests/db/c14-t02/fixtures.sql (shape in its header).
//
// SEAMS the spec does not fix (writer must provide exactly these; rows in/out use the DDL's snake_case column names verbatim, mappers do DTOs; same conventions as C5 T-03):
//   RepoCtx = { tx: { query(text, values?): Promise<{ rows: any[] }> }, tenantId: string, actorId: string }   (tx = the request transaction, 02-TRD §3.2)
//   Every statement binds tenant_id = $n explicitly (value from rc.tenantId, never from a row/patch/arg), is schema-qualified `smartreport.`, binds values, never interpolates them, never DELETEs.
//   insertX(rc, row)  -> inserted row (RETURNING *). Caller supplies `id`. tenant_id := rc.tenantId, created_by/updated_by := rc.actorId, version 1 (class A tables: tenant_id + created_by only).
//                        A row carrying tenant_id / created_by / updated_by / version is REJECTED (throws, nothing written). jsonb columns (content, llm_overlay, items) are passed as JS values; the repo serialises them.
//   getX(rc, id)      -> row | null   (unknown id or another tenant's id -> null)
//   updateX(rc, id, expectedVersion, patch) -> updated row: SET <patch cols>, version = version + 1, updated_at = now(), updated_by = rc.actorId WHERE tenant_id = $t AND id = $id AND version = $expected.
//                        0 rows -> LimsError `common.version_conflict` if the row exists for this tenant, else `common.not_found`. Patch keys must be existing mutable columns of that table;
//                        anything else (tenant_id, id, version, created_*, updated_*, unknown, SQL text) -> throws, nothing written. DB trigger errors (immutable_row / invalid_transition) propagate.
//   `opts.includeInactive` (default false): list functions of M tables return is_active rows only unless includeInactive === true (removal = deactivation, 08 A17 P-18(a); readers use active rows).
//   library.repo.ts    insertLibraryVersion getLibraryVersion getOpenLibraryVersion(rc) [status IN ('draft','in_review') | null] getApprovedLibraryVersion(rc) [status = 'approved' | null]
//                      listLibraryVersions(rc,{limit}) [version_no DESC] updateLibraryVersion
//   blocks.repo.ts     insertBlock getBlock listBlocks(rc, libraryVersionId, opts?) [block_key ASC] updateBlock
//   rules.repo.ts      insertRule getRule listRules(rc, libraryVersionId, opts?) [priority ASC, id] listRulesByKind(rc, libraryVersionId, ruleKind, opts?) [priority ASC, id] updateRule
//   mappings.repo.ts   insertMapping getMapping listMappings(rc, libraryVersionId, opts?) [sort_order ASC, id] updateMapping
//   groups.repo.ts     insertGroupSetting getGroupSetting listGroupSettings(rc, libraryVersionId, opts?) [sort_order ASC, id] updateGroupSetting
//   denyTerms.repo.ts  insertDenyTerm getDenyTerm listDenyTerms(rc, opts?) [term_folded ASC, language] listGlobalDenyTerms(rc) [active g_cs_wording_deny_terms, term_folded ASC] updateDenyTerm
//   summaries.repo.ts  insertSummary getSummary getLiveSummaryByOrder(rc, orderId) [status IN ('draft','approved','rejected') | null]
//                      findSummaryByDeterminismKey(rc, { orderId, approvedSetHash, libraryVersionId }) | null   listSummariesByOrder(rc, orderId) [built_at DESC]
//                      listReviewQueue(rc, { status, centreId?, limit }) [built_at ASC, id ASC]   updateSummary
//   bindings.repo.ts   insertBinding listBindingsBySummary(rc, summaryId) [report_version_no ASC]
//   reviews.repo.ts    insertSummaryReview listSummaryReviews(rc, summaryId) [created_at ASC, id] insertLibraryReview listLibraryReviews(rc, libraryVersionId) [created_at ASC, id]
//   llmRuns.repo.ts    insertLlmRun listLlmRuns(rc, summaryId) [created_at ASC, id]
//   codedSets.repo.ts  listOrganGroups(rc) [active, sort_order ASC]   listRejectReasons(rc) [active, sort_order ASC]    (global tables: no tenant filter)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import * as bindings from '../bindings.repo.js';
import * as blocks from '../blocks.repo.js';
import * as codedSets from '../codedSets.repo.js';
import * as denyTerms from '../denyTerms.repo.js';
import * as groups from '../groups.repo.js';
import * as library from '../library.repo.js';
import * as llmRuns from '../llmRuns.repo.js';
import * as mappings from '../mappings.repo.js';
import * as reviews from '../reviews.repo.js';
import * as rules from '../rules.repo.js';
import * as summaries from '../summaries.repo.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const CENTRE_A1 = '01a1a98a-ac40-7000-8000-00000000a201';
const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';
const MEMBER_A = '01a1a98a-ac40-7000-8000-00000000a500';
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
const hex = (n: number) => n.toString(16).padStart(64, '0');
const SQL_INJECTION = `x'; DROP TABLE smartreport.rules; --`;

type Row = Record<string, any>;
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Stmt { text: string; values: unknown[] }
interface Rc { tx: Tx; tenantId: string; actorId: string }

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

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 4 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  const fixtures = readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c14-t02/fixtures.sql', import.meta.url)), 'utf8');
  await admin.query(fixtures);       // fresh migrated + seeded database (run.sh)
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T02 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C14T02_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C14T02_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ table-driven cases
const nowIso = () => new Date().toISOString();
/** [label, table, id, get, list-of-A-ids-owner] */
const GETTERS: Array<[string, string, number, (rc: Rc, id: string) => Promise<Row | null>]> = [
  ['library_versions', 'smartreport.library_versions', 103, library.getLibraryVersion as never],
  ['template_blocks', 'smartreport.template_blocks', 301, blocks.getBlock as never],
  ['rules', 'smartreport.rules', 401, rules.getRule as never],
  ['analyte_groups', 'smartreport.analyte_groups', 501, mappings.getMapping as never],
  ['group_settings', 'smartreport.group_settings', 601, groups.getGroupSetting as never],
  ['wording_deny_terms', 'smartreport.wording_deny_terms', 701, denyTerms.getDenyTerm as never],
  ['summaries', 'smartreport.summaries', 801, summaries.getSummary as never],
];

/** Optimistic-update cases: [label, table, id, update, valid patch, column asserted afterwards, expected value]. All on draft rows of tenant A. */
type Upd = (rc: Rc, id: string, expected: number, patch: Row) => Promise<Row>;
const UPDATES: Array<[string, string, number, Upd, Row, string, unknown]> = [
  ['updateLibraryVersion', 'smartreport.library_versions', 103, library.updateLibraryVersion as never, { change_summary: 'edited by T02' }, 'change_summary', 'edited by T02'],
  ['updateBlock', 'smartreport.template_blocks', 301, blocks.updateBlock as never, { text_en: 'edited by T02' }, 'text_en', 'edited by T02'],
  ['updateRule', 'smartreport.rules', 401, rules.updateRule as never, { priority: 77 }, 'priority', 77],
  ['updateMapping', 'smartreport.analyte_groups', 501, mappings.updateMapping as never, { sort_order: 77 }, 'sort_order', 77],
  ['updateGroupSetting', 'smartreport.group_settings', 601, groups.updateGroupSetting as never, { display_en: 'Edited T02' }, 'display_en', 'Edited T02'],
  ['updateDenyTerm', 'smartreport.wording_deny_terms', 701, denyTerms.updateDenyTerm as never, { reason: 'edited by T02' }, 'reason', 'edited by T02'],
  ['updateSummary', 'smartreport.summaries', 801, summaries.updateSummary as never, { status: 'approved', approved_at: '2026-11-11T00:00:00Z', approved_by_membership_id: MEMBER_A }, 'status', 'approved'],
];

/** Minimal valid insert rows (parents from the fixture). [label, table, class A?, insert, row] */
type Ins = (rc: Rc, row: Row) => Promise<Row>;
const INSERTS: Array<[string, string, boolean, string, Ins, () => Row]> = [
  ['insertLibraryVersion', 'smartreport.library_versions', false, B, library.insertLibraryVersion as never, () => ({ id: uid(9001), version_no: 2 })],
  ['insertBlock', 'smartreport.template_blocks', false, A, blocks.insertBlock as never, () => ({ id: uid(9002), library_version_id: uid(103), block_key: 'der.new.key', kind: 'deranged', text_en: 'new text' })],
  ['insertRule', 'smartreport.rules', false, A, rules.insertRule as never, () => ({ id: uid(9003), library_version_id: uid(103), rule_kind: 'deranged', trigger_kind: 'analyte', analyte_id: uid(5002), direction: 'low', min_severity: 'borderline', block_id: uid(301), block_kind: 'deranged' })],
  ['insertMapping', 'smartreport.analyte_groups', false, A, mappings.insertMapping as never, () => ({ id: uid(9004), library_version_id: uid(103), analyte_id: uid(5003), group_code: 'kidney' })],
  ['insertGroupSetting', 'smartreport.group_settings', false, A, groups.insertGroupSetting as never, () => ({ id: uid(9005), library_version_id: uid(103), group_code: 'kidney', display_en: 'Kidney', sort_order: 50 })],
  ['insertDenyTerm', 'smartreport.wording_deny_terms', false, A, denyTerms.insertDenyTerm as never, () => ({ id: uid(9006), term: 'guaranteed', term_folded: 'guaranteed', language: 'en' })],
  ['insertSummary', 'smartreport.summaries', false, A, summaries.insertSummary as never, () => ({ id: uid(9007), centre_id: CENTRE_A1, order_id: uid(15), patient_id: uid(1), library_version_id: uid(102), template_library_version: '2',
    formula_version: 'hs-1', language: 'en', approved_set_hash: hex(9007), input_result_versions: ['r9:1'], content: { fixture: 'T02' }, content_sha256: hex(19007), built_at: nowIso() })],
  ['insertBinding', 'smartreport.summary_report_bindings', true, A, bindings.insertBinding as never, () => ({ id: uid(9008), centre_id: CENTRE_A1, summary_id: uid(801), order_id: uid(11), report_version_no: 1, bound_at: nowIso() })],
  ['insertSummaryReview', 'smartreport.summary_reviews', true, A, reviews.insertSummaryReview as never, () => ({ id: uid(9009), centre_id: CENTRE_A1, summary_id: uid(801), action: 'approved', actor_membership_id: MEMBER_A })],
  ['insertLibraryReview', 'smartreport.library_reviews', true, A, reviews.insertLibraryReview as never, () => ({ id: uid(9010), library_version_id: uid(103), action: 'submitted', actor_membership_id: MEMBER_A })],
  ['insertLlmRun', 'smartreport.llm_runs', true, A, llmRuns.insertLlmRun as never, () => ({ id: uid(9011), centre_id: CENTRE_A1, summary_id: uid(801), status: 'failed', prompt_template_version: 'p1', model_ref: 'fixture-model', input_sha256: hex(9011), items: [{ k: 1 }] })],
];

// ------------------------------------------------------------------------------------------------ tenant filter
describe.skipIf(!live)('T02 explicit tenant filter (REQ-SEC-024; RLS bypassed so only the repository query protects)', () => {
  it.each(GETTERS)('%s: own row returned; the other tenant\'s id and an unknown id both give null', async (_l, _t, n, get) => {
    const own = await asAdmin(A, (rc) => get(rc, uid(n)));
    expect(own?.['tenant_id']).toBe(A);
    expect(own?.['id']).toBe(uid(n));
    expect(await asAdmin(B, (rc) => get(rc, uid(n)))).toBeNull();                 // A's row through B's ctx
    expect(await asAdmin(A, (rc) => get(rc, uid(99999)))).toBeNull();             // unknown id: same answer (404 parity)
  });

  it('lists never cross tenants (RLS bypassed): versions, blocks, rules, mappings, groups, deny terms, summaries, queue, bindings, reviews, runs', async () => {
    expect(ids(await asAdmin(B, (rc) => library.listLibraryVersions(rc, { limit: 50 })))).toEqual([uid(201)]);
    expect(await asAdmin(B, (rc) => blocks.listBlocks(rc, uid(103)))).toEqual([]);                          // A's library id through B's ctx
    expect(ids(await asAdmin(B, (rc) => blocks.listBlocks(rc, uid(201))))).toEqual([uid(3201)]);
    expect(await asAdmin(B, (rc) => rules.listRules(rc, uid(103)))).toEqual([]);
    expect(await asAdmin(B, (rc) => rules.listRulesByKind(rc, uid(103), 'deranged'))).toEqual([]);
    expect(await asAdmin(B, (rc) => mappings.listMappings(rc, uid(103)))).toEqual([]);
    expect(await asAdmin(B, (rc) => groups.listGroupSettings(rc, uid(103)))).toEqual([]);
    expect(ids(await asAdmin(B, (rc) => denyTerms.listDenyTerms(rc)))).toEqual([uid(7201)]);
    expect(await asAdmin(B, (rc) => summaries.getLiveSummaryByOrder(rc, uid(11)))).toBeNull();               // A's order through B's ctx
    expect(await asAdmin(B, (rc) => summaries.listSummariesByOrder(rc, uid(11)))).toEqual([]);
    expect(await asAdmin(B, (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: hex(801), libraryVersionId: uid(102) }))).toBeNull();
    expect(ids(await asAdmin(B, (rc) => summaries.listReviewQueue(rc, { status: 'draft', limit: 500 })))).toEqual([uid(8101)]);
    expect(await asAdmin(B, (rc) => bindings.listBindingsBySummary(rc, uid(802)))).toEqual([]);
    expect(await asAdmin(B, (rc) => reviews.listSummaryReviews(rc, uid(802)))).toEqual([]);
    expect(await asAdmin(B, (rc) => reviews.listLibraryReviews(rc, uid(102)))).toEqual([]);
    expect(await asAdmin(B, (rc) => llmRuns.listLlmRuns(rc, uid(801)))).toEqual([]);
    expect((await asAdmin(A, (rc) => summaries.listReviewQueue(rc, { status: 'draft', limit: 500 }))).every((r) => r['tenant_id'] === A)).toBe(true);
  });

  it('the same deny term / block key in two tenants resolves to each tenant\'s own row', async () => {
    expect(ids(await asAdmin(A, (rc) => denyTerms.listDenyTerms(rc)))).toEqual([uid(701)]);
    expect(ids(await asAdmin(B, (rc) => denyTerms.listDenyTerms(rc)))).toEqual([uid(7201)]);
    expect((await asAdmin(A, (rc) => library.getApprovedLibraryVersion(rc)))?.['id']).toBe(uid(102));
    expect((await asAdmin(B, (rc) => library.getApprovedLibraryVersion(rc)))?.['id']).toBe(uid(201));
  });

  it.each(UPDATES)('%s: ctx tenant B cannot update tenant A\'s row (common.not_found, row untouched)', async (_l, table, n, update, patch) => {
    const before = (await sql(`SELECT version, updated_by, updated_at FROM ${table} WHERE id = $1`, [uid(n)]))[0];
    const e = await rejection(asAdmin(B, (rc) => update(rc, uid(n), 1, patch)));
    expect(isLimsError(e, 'common.not_found'), String(e)).toBe(true);
    expect((await sql(`SELECT version, updated_by, updated_at FROM ${table} WHERE id = $1`, [uid(n)]))[0]).toEqual(before);
  });

  it.each(INSERTS)('%s: a row carrying tenant_id / created_by / updated_by / version is refused and nothing is written', async (_l, table, _classA, tenant, insert, row) => {
    const before = (await sql(`SELECT count(*)::int AS n FROM ${table}`))[0]!['n'];
    const extras: Row[] = [{ tenant_id: tenant === A ? B : A }, { tenant_id: tenant }, { created_by: uid(1) }, { updated_by: uid(1) }, { version: 7 }];
    for (const extra of extras) await rejection(asAdmin(tenant, (rc) => insert(rc, { ...row(), ...extra })));
    expect((await sql(`SELECT count(*)::int AS n FROM ${table}`))[0]!['n']).toBe(before);
  });
});

// ------------------------------------------------------------------------------------------------ inserts
describe.skipIf(!live)('T02 inserts (as lims_api, RLS on; rolled back)', () => {
  it.each(INSERTS)('%s inserts one row for the ctx tenant, actor-stamped; version 1 on versioned tables', async (_l, table, classA, tenant, insert, row) => {
    const out = await asApiRb(tenant, async (rc, _s, raw) => {
      const r = await insert(rc, row());
      const stored = (await raw.query(`SELECT * FROM ${table} WHERE id = $1`, [r['id']])).rows;
      return { r, stored };
    });
    expect(out.r['id']).toBe(row()['id']);
    expect(out.r['tenant_id']).toBe(tenant);
    expect(out.r['created_by']).toBe(SYS);
    expect(out.stored.length).toBe(1);
    if (!classA) {
      expect(out.r['updated_by']).toBe(SYS);
      expect(out.r['version']).toBe(1);
    }
  });

  it('insertSummary round-trips the jsonb content and the text[] input_result_versions', async () => {
    const r = await asApiRb(A, (rc) => summaries.insertSummary(rc, { ...INSERTS[6]![5](), input_result_versions: ['r1:1', 'r2:3'], content: { a: [1, 2], b: { c: 'x' } } }));
    expect(r['input_result_versions']).toEqual(['r1:1', 'r2:3']);
    expect(r['content']).toEqual({ a: [1, 2], b: { c: 'x' } });
    expect(r['status']).toBe('draft');
  });

  it('insertLlmRun stores a JS array value as a jsonb array (not a PG array literal)', async () => {
    const r = await asApiRb(A, (rc) => llmRuns.insertLlmRun(rc, { ...INSERTS[10]![5](), items: [{ k: 1 }, { k: 2 }] }));
    expect(r['items']).toEqual([{ k: 1 }, { k: 2 }]);
  });

  it('insertLibraryVersion refuses lifecycle columns (status / approved_*): a library is created draft only, approval goes through review', async () => {
    const lib = INSERTS[0]![5] as () => Row;
    const before = (await sql('SELECT count(*)::int AS n FROM smartreport.library_versions'))[0]!['n'];
    const extras: Row[] = [{ status: 'approved' }, { status: 'draft' }, { approved_at: new Date().toISOString() }, { approved_by_membership_id: MEMBER_A }, { submitted_at: new Date().toISOString() }, { retired_at: new Date().toISOString() }];
    for (const extra of extras) await rejection(asApi(B, (rc) => library.insertLibraryVersion(rc, { ...lib(), ...extra })));
    expect((await sql('SELECT count(*)::int AS n FROM smartreport.library_versions'))[0]!['n']).toBe(before);
  });

  it('a duplicate of a unique key surfaces as an error and leaves nothing behind (determinism key, active block key)', async () => {
    const dupSummary = { ...INSERTS[6]![5](), order_id: uid(11), approved_set_hash: hex(801), library_version_id: uid(102), id: uid(9101) };
    await rejection(asApiRb(A, (rc) => summaries.insertSummary(rc, dupSummary)));
    await rejection(asApiRb(A, (rc) => blocks.insertBlock(rc, { ...INSERTS[1]![5](), block_key: 'der.glucose.high' })));
    expect((await sql('SELECT count(*)::int AS n FROM smartreport.summaries WHERE id = $1', [uid(9101)]))[0]!['n']).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ optimistic updates
describe.skipIf(!live)('T02 optimistic version updates (as lims_api, RLS on; rolled back)', () => {
  it.each(UPDATES)('%s: matching version -> row updated, version + 1, updated_by = actor, updated_at moved', async (_l, table, n, update, patch, col, want) => {
    const out = await asApiRb(A, async (rc, _s, raw) => {
      const before = (await raw.query(`SELECT version, updated_at FROM ${table} WHERE id = $1`, [uid(n)])).rows[0];
      const r = await update(rc, uid(n), before.version, patch);
      return { before, r };
    });
    expect(out.r[col]).toBe(want);
    expect(out.r['version']).toBe(out.before.version + 1);
    expect(out.r['updated_by']).toBe(SYS);
    expect(new Date(out.r['updated_at']).getTime()).toBeGreaterThanOrEqual(new Date(out.before.updated_at).getTime());
    expect(out.r['tenant_id']).toBe(A);
  });

  it.each(UPDATES)('%s: stale version -> common.version_conflict and the row keeps the first writer\'s value', async (_l, table, n, update, patch, col, want) => {
    await asApiRb(A, async (rc, _s, raw) => {
      await update(rc, uid(n), 1, patch);                                         // first writer wins: version 1 -> 2
      const e = await rejection(update(rc, uid(n), 1, { ...patch }));            // second writer still holds version 1
      expect(isLimsError(e, 'common.version_conflict'), String(e)).toBe(true);
      const row = (await raw.query(`SELECT version, ${col} AS v FROM ${table} WHERE id = $1`, [uid(n)])).rows[0];
      expect(row.version).toBe(2);
      expect(row.v).toBe(want);
    });
  });

  it.each(UPDATES)('%s: unknown id -> common.not_found (not a conflict)', async (_l, _t, _n, update, patch) => {
    const e = await asApiRb(A, (rc) => rejection(update(rc, uid(99999), 1, patch)));
    expect(isLimsError(e, 'common.not_found'), String(e)).toBe(true);
  });

  it('patch keys outside the table\'s mutable columns are refused and nothing is written (tenant_id, id, version, created_*, updated_*, unknown, SQL text)', async () => {
    const before = (await sql('SELECT * FROM smartreport.template_blocks WHERE id = $1', [uid(302)]))[0];
    const bad: Row[] = [{ tenant_id: B }, { id: uid(1) }, { version: 99 }, { created_at: nowIso() }, { created_by: uid(1) }, { updated_at: nowIso() }, { updated_by: uid(1) },
      { no_such_column: 1 }, { "text_en = 'x', tenant_id": 'y' }, { 'text_en; DROP TABLE smartreport.rules; --': 'y' }, { 'text_en"': 'y' }];
    for (const patch of bad) await rejection(asApi(A, (rc) => blocks.updateBlock(rc, uid(302), 1, patch)));
    expect((await sql('SELECT * FROM smartreport.template_blocks WHERE id = $1', [uid(302)]))[0]).toEqual(before);
    expect((await sql('SELECT count(*)::int AS n FROM smartreport.rules'))[0]!['n']).toBeGreaterThanOrEqual(6);
  });

  it('a hostile string VALUE in a patch is data: stored literally, table survives', async () => {
    const r = await asApiRb(A, (rc) => library.updateLibraryVersion(rc, uid(103), 1, { change_summary: SQL_INJECTION }));
    expect(r['change_summary']).toBe(SQL_INJECTION);
    expect((await sql('SELECT count(*)::int AS n FROM smartreport.rules'))[0]!['n']).toBeGreaterThanOrEqual(6);
  });

  it('DB immutability triggers propagate: block of an approved library (immutable_row), approved library content (immutable_row), draft -> approved library (invalid_transition)', async () => {
    const eBlock = await rejection(asApiRb(A, (rc) => blocks.updateBlock(rc, uid(311), 1, { text_en: 'tamper' })));
    expect(String(eBlock?.message ?? eBlock)).toMatch(/immutable_row/);
    const eLib = await rejection(asApiRb(A, (rc) => library.updateLibraryVersion(rc, uid(102), 1, { change_summary: 'tamper' })));
    expect(String(eLib?.message ?? eLib)).toMatch(/immutable_row/);
    const eTr = await rejection(asApiRb(A, (rc) => library.updateLibraryVersion(rc, uid(103), 1, { status: 'approved' })));
    expect(String(eTr?.message ?? eTr) + (isLimsError(eTr, 'smartreport.library_invalid_transition') ? ' invalid_transition' : '')).toMatch(/invalid_transition/);
  });

  it('removal is deactivation: updateBlock { is_active: false } on a draft block works, the row stays', async () => {
    const out = await asApiRb(A, async (rc, _s, raw) => {
      const r = await blocks.updateBlock(rc, uid(302), 1, { is_active: false });
      return { r, n: (await raw.query('SELECT count(*)::int AS n FROM smartreport.template_blocks WHERE id = $1', [uid(302)])).rows[0].n };
    });
    expect(out.r['is_active']).toBe(false);
    expect(out.n).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ statement hygiene
describe.skipIf(!live)('T02 statement hygiene (recorded on the real request path as lims_api)', () => {
  const CALLS: Array<[string, (rc: Rc) => Promise<unknown>, string[]]> = [
    ['getLibraryVersion', (rc) => library.getLibraryVersion(rc, uid(103)), [uid(103)]],
    ['getOpenLibraryVersion', (rc) => library.getOpenLibraryVersion(rc), []],
    ['getApprovedLibraryVersion', (rc) => library.getApprovedLibraryVersion(rc), []],
    ['listLibraryVersions', (rc) => library.listLibraryVersions(rc, { limit: 5 }), []],
    ['getBlock', (rc) => blocks.getBlock(rc, uid(301)), [uid(301)]],
    ['listBlocks', (rc) => blocks.listBlocks(rc, uid(103)), [uid(103)]],
    ['getRule', (rc) => rules.getRule(rc, uid(401)), [uid(401)]],
    ['listRules', (rc) => rules.listRules(rc, uid(103)), [uid(103)]],
    ['listRulesByKind', (rc) => rules.listRulesByKind(rc, uid(103), 'deranged'), [uid(103), 'deranged']],
    ['getMapping', (rc) => mappings.getMapping(rc, uid(501)), [uid(501)]],
    ['listMappings', (rc) => mappings.listMappings(rc, uid(103)), [uid(103)]],
    ['getGroupSetting', (rc) => groups.getGroupSetting(rc, uid(601)), [uid(601)]],
    ['listGroupSettings', (rc) => groups.listGroupSettings(rc, uid(103)), [uid(103)]],
    ['getDenyTerm', (rc) => denyTerms.getDenyTerm(rc, uid(701)), [uid(701)]],
    ['listDenyTerms', (rc) => denyTerms.listDenyTerms(rc), []],
    ['getSummary', (rc) => summaries.getSummary(rc, uid(801)), [uid(801)]],
    ['getLiveSummaryByOrder', (rc) => summaries.getLiveSummaryByOrder(rc, uid(11)), [uid(11)]],
    ['findSummaryByDeterminismKey', (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: hex(801), libraryVersionId: uid(102) }), [uid(11), hex(801), uid(102)]],
    ['listSummariesByOrder', (rc) => summaries.listSummariesByOrder(rc, uid(11)), [uid(11)]],
    ['listReviewQueue', (rc) => summaries.listReviewQueue(rc, { status: 'draft', centreId: CENTRE_A1, limit: 10 }), [CENTRE_A1, 'draft']],
    ['listBindingsBySummary', (rc) => bindings.listBindingsBySummary(rc, uid(802)), [uid(802)]],
    ['listSummaryReviews', (rc) => reviews.listSummaryReviews(rc, uid(802)), [uid(802)]],
    ['listLibraryReviews', (rc) => reviews.listLibraryReviews(rc, uid(102)), [uid(102)]],
    ['listLlmRuns', (rc) => llmRuns.listLlmRuns(rc, uid(801)), [uid(801)]],
    ['updateBlock', (rc) => blocks.updateBlock(rc, uid(304), 1, { text_en: 'HYGIENE' }), [uid(304), 'HYGIENE']],
  ];

  it.each(CALLS)('%s: every statement is smartreport-qualified, binds tenant_id and the tenant value as a parameter, interpolates no value, never DELETEs', async (_n, call, literals) => {
    const stmts = await asApiRb(A, async (rc, s) => { await call(rc); return s.map((x) => ({ ...x })); });
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(s.text, 'explicit tenant column').toMatch(/\btenant_id\b/);
      expect(s.values, 'tenant value bound').toContain(A);
      expect(s.text, 'tenant value not interpolated').not.toContain(A);
      for (const l of literals) expect(s.text, `value ${l} must be a parameter`).not.toContain(l);
      expect(s.text).toMatch(/\bsmartreport\.\w+/);
      expect(s.text).not.toMatch(/\bdelete\b/i);
      expect(s.text).not.toMatch(/\b(?:from|join|into|update)\s+(?!smartreport\.)[a-z_]+\.[a-z_]/i);   // SQL only for schema smartreport (02-TRD §3)
    }
  });

  it('a hostile string argument is data: lookups return null / empty and the tables survive', async () => {
    expect(await asApi(A, (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: SQL_INJECTION, libraryVersionId: uid(102) }))).toBeNull();
    expect(await asApi(A, (rc) => rules.listRulesByKind(rc, uid(103), SQL_INJECTION))).toEqual([]);
    expect(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: SQL_INJECTION, limit: 5 }))).toEqual([]);
    expect((await sql('SELECT count(*)::int AS n FROM smartreport.rules'))[0]!['n']).toBeGreaterThanOrEqual(6);
  });
});

// ------------------------------------------------------------------------------------------------ index use (done_when)
describe.skipIf(!live)('T02 index use (05-SCHEMA §5; EXPLAIN on the statements the repositories really send)', () => {
  const EXPECT: Array<[string, string, (rc: Rc) => Promise<unknown>]> = [
    ['open draft / in_review version', 'library_versions__tenant_id__open__p_uq', (rc) => library.getOpenLibraryVersion(rc)],
    ['approved (active) version', 'library_versions__tenant_id__approved__p_uq', (rc) => library.getApprovedLibraryVersion(rc)],
    ['list versions by number', 'library_versions__tenant_id_version_no__uq', (rc) => library.listLibraryVersions(rc, { limit: 10 })],
    ['blocks of a version', 'template_blocks__tenant_id_lib_key__p_uq', (rc) => blocks.listBlocks(rc, uid(103))],
    ['rules of a version', 'rules__tenant_id_library_version_id_rule_kind__idx', (rc) => rules.listRules(rc, uid(103))],
    ['rules by kind', 'rules__tenant_id_library_version_id_rule_kind__idx', (rc) => rules.listRulesByKind(rc, uid(103), 'deranged')],
    ['analyte mappings of a version', 'analyte_groups__tenant_id_lib_analyte__p_uq', (rc) => mappings.listMappings(rc, uid(103))],
    ['group settings of a version', 'group_settings__tenant_id_lib_group__uq', (rc) => groups.listGroupSettings(rc, uid(103))],
    ['tenant deny terms', 'wording_deny_terms__tenant_id_term_folded_language__p_uq', (rc) => denyTerms.listDenyTerms(rc)],
    ['live summary of an order', 'summaries__tenant_id_order_id__live__p_uq', (rc) => summaries.getLiveSummaryByOrder(rc, uid(11))],
    ['determinism key', 'summaries__tenant_id_order_id_hash_library__uq', (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: hex(801), libraryVersionId: uid(102) })],
    ['review queue (#27, all centres)', 'summaries__tenant_id_status_built_at__idx', (rc) => summaries.listReviewQueue(rc, { status: 'draft', limit: 20 })],
    ['review queue (#27, one centre)', 'summaries__tenant_id_centre_id_status_built_at__idx', (rc) => summaries.listReviewQueue(rc, { status: 'draft', centreId: CENTRE_A1, limit: 20 })],
    ['summaries of an order (history)', 'summaries__tenant_id_order_id_built_at__idx', (rc) => summaries.listSummariesByOrder(rc, uid(11))],
    ['bindings by summary', 'summary_report_bindings__tenant_id_summary_id_version_no__uq', (rc) => bindings.listBindingsBySummary(rc, uid(802))],
    ['reviews by summary', 'summary_reviews__tenant_id_summary_id_created_at__idx', (rc) => reviews.listSummaryReviews(rc, uid(802))],
    ['library reviews', 'library_reviews__tenant_id_library_version_id_created_at__idx', (rc) => reviews.listLibraryReviews(rc, uid(102))],
    ['llm runs by summary', 'llm_runs__tenant_id_summary_id_created_at__idx', (rc) => llmRuns.listLlmRuns(rc, uid(801))],
  ];

  // The named index must be able to serve the statement whatever the planner's tie-break between equal-cost sibling indexes (same technique as C5 T-03, LD-92):
  // sibling non-constraint indexes of its table are dropped inside the transaction (DDL is transactional; ROLLBACK restores them), seq scans are disabled.
  async function explainAll(stmts: Stmt[], expectedIndex?: string): Promise<{ indexes: Set<string>; seqScans: string[] }> {
    const indexes = new Set<string>();
    const seqScans: string[] = [];
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query("SET LOCAL search_path = ''");
      if (expectedIndex) {
        const sib = await client.query(
          `SELECT format('%I.%I', n.nspname, c.relname) AS idx
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE i.indrelid = (SELECT x.indrelid FROM pg_index x JOIN pg_class xc ON xc.oid = x.indexrelid
                                  JOIN pg_namespace xn ON xn.oid = xc.relnamespace
                                 WHERE xc.relname = $1 AND xn.nspname = 'smartreport')
              AND c.relname <> $1
              AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`, [expectedIndex]);
        for (const r of sib.rows) await client.query(`DROP INDEX ${r.idx}`);
      }
      for (const s of stmts) {
        const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${s.text}`, s.values)).rows[0]['QUERY PLAN'][0].Plan;
        const walk = (n: any) => {
          if (n['Index Name']) indexes.add(n['Index Name']);
          if (/Seq Scan/.test(n['Node Type']) && n['Schema'] === 'smartreport') seqScans.push(n['Relation Name']);
          for (const c of n['Plans'] ?? []) walk(c);
        };
        walk(plan);
      }
      await client.query('ROLLBACK');
    } finally { client.release(); }
    return { indexes, seqScans };
  }

  it.each(EXPECT)('%s uses %s and no Seq Scan on a smartreport table', async (name, index, call) => {
    const stmts = await asApiRb(A, async (rc, s) => { await call(rc); return s.map((x) => ({ ...x })); });
    expect(stmts.length).toBeGreaterThan(0);
    const { indexes, seqScans } = await explainAll(stmts, index);
    expect([...indexes], `plan indexes for ${name}: indexes=[${[...indexes].join(', ')}] seqScans=[${seqScans.join(', ')}]`).toContain(index);
    expect(seqScans).toEqual([]);
  });

  it('lookups by id (every getX) never Seq Scan', async () => {
    for (const [, , n, get] of GETTERS) {
      const stmts = await asApiRb(A, async (rc, s) => { await get(rc, uid(n)); return s.map((x) => ({ ...x })); });
      expect((await explainAll(stmts)).seqScans).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------------ semantics (oracle = fixture shape / independent admin SQL)
describe.skipIf(!live)('T02 query semantics', () => {
  it('library: open draft, approved, list by version_no DESC (+limit); tenant B has no open draft', async () => {
    expect((await asApi(A, (rc) => library.getOpenLibraryVersion(rc)))?.['id']).toBe(uid(103));
    expect((await asApi(A, (rc) => library.getApprovedLibraryVersion(rc)))?.['id']).toBe(uid(102));
    expect(await asApi(B, (rc) => library.getOpenLibraryVersion(rc))).toBeNull();
    expect(ids(await asApi(A, (rc) => library.listLibraryVersions(rc, { limit: 10 })))).toEqual([uid(103), uid(102), uid(101)]);
    expect(ids(await asApi(A, (rc) => library.listLibraryVersions(rc, { limit: 2 })))).toEqual([uid(103), uid(102)]);
  });

  it('blocks / rules / mappings / groups: active rows only by default, includeInactive adds the deactivated rows, ordering as documented', async () => {
    expect(ids(await asApi(A, (rc) => blocks.listBlocks(rc, uid(103))))).toEqual([uid(302), uid(301), uid(303)]);
    expect(ids(await asApi(A, (rc) => blocks.listBlocks(rc, uid(103), { includeInactive: true })))).toEqual([uid(302), uid(304), uid(301), uid(303)]);
    expect(ids(await asApi(A, (rc) => blocks.listBlocks(rc, uid(102))))).toEqual([uid(312), uid(311)]);                      // other version of the same tenant
    expect(ids(await asApi(A, (rc) => rules.listRules(rc, uid(103))))).toEqual([uid(401), uid(402), uid(403)]);
    expect(ids(await asApi(A, (rc) => rules.listRules(rc, uid(103), { includeInactive: true })))).toEqual([uid(401), uid(402), uid(403), uid(404)]);
    expect(ids(await asApi(A, (rc) => rules.listRulesByKind(rc, uid(103), 'deranged')))).toEqual([uid(401)]);
    expect(ids(await asApi(A, (rc) => rules.listRulesByKind(rc, uid(103), 'deranged', { includeInactive: true })))).toEqual([uid(401), uid(404)]);
    expect(ids(await asApi(A, (rc) => rules.listRulesByKind(rc, uid(103), 'advice')))).toEqual([uid(402)]);
    expect(ids(await asApi(A, (rc) => rules.listRulesByKind(rc, uid(103), 'followup')))).toEqual([uid(403)]);
    expect(ids(await asApi(A, (rc) => mappings.listMappings(rc, uid(103))))).toEqual([uid(501), uid(502)]);
    expect(ids(await asApi(A, (rc) => mappings.listMappings(rc, uid(103), { includeInactive: true })))).toEqual([uid(501), uid(502), uid(503)]);
    expect(ids(await asApi(A, (rc) => groups.listGroupSettings(rc, uid(103))))).toEqual([uid(601), uid(602)]);
  });

  it('deny terms: tenant list is active-only by term_folded; global list is the active g_cs_wording_deny_terms seed', async () => {
    expect(ids(await asApi(A, (rc) => denyTerms.listDenyTerms(rc)))).toEqual([uid(701)]);
    expect(ids(await asApi(A, (rc) => denyTerms.listDenyTerms(rc, { includeInactive: true })))).toEqual([uid(702), uid(701)]);        // 'cure-all' < 'miracle'
    const g = await asApi(A, (rc) => denyTerms.listGlobalDenyTerms(rc));
    const want = await sql('SELECT term_folded FROM smartreport.g_cs_wording_deny_terms WHERE is_active ORDER BY term_folded');
    expect(g.map((r) => r['term_folded'])).toEqual(want.map((r) => r['term_folded']));
    expect(g.length).toBeGreaterThanOrEqual(20);
    expect(g.map((r) => r['term_folded'])).toEqual(expect.arrayContaining(['diagnos', 'http', 'whatsapp']));
  });

  it('coded sets: organ groups and reject reasons are the active seed rows in sort_order', async () => {
    const og = await asApi(A, (rc) => codedSets.listOrganGroups(rc));
    expect(og.map((r) => r['code'])).toEqual((await sql('SELECT code FROM smartreport.g_cs_organ_groups WHERE is_active ORDER BY sort_order')).map((r) => r['code']));
    expect(og[0]?.['code']).toBe('blood_counts');
    expect(og.map((r) => r['code'])).toEqual(expect.arrayContaining(['glucose', 'lipids', 'kidney', 'other']));
    const rr = await asApi(A, (rc) => codedSets.listRejectReasons(rc));
    expect(rr.map((r) => r['code'])).toEqual((await sql('SELECT code FROM smartreport.g_cs_summary_reject_reasons WHERE is_active ORDER BY sort_order')).map((r) => r['code']));
    expect(rr.map((r) => r['code'])).toEqual(expect.arrayContaining(['wording_problem', 'other']));
  });

  it('live summary of an order ignores superseded rows; none -> null', async () => {
    expect((await asApi(A, (rc) => summaries.getLiveSummaryByOrder(rc, uid(11))))?.['id']).toBe(uid(801));       // 805 is superseded
    expect((await asApi(A, (rc) => summaries.getLiveSummaryByOrder(rc, uid(12))))?.['id']).toBe(uid(802));       // approved is live
    expect((await asApi(A, (rc) => summaries.getLiveSummaryByOrder(rc, uid(13))))?.['id']).toBe(uid(803));       // rejected is live
    expect(await asApi(A, (rc) => summaries.getLiveSummaryByOrder(rc, uid(15)))).toBeNull();                      // no summary yet
  });

  it('determinism key (order, approved_set_hash, library_version) finds the exact row, incl. a superseded one; any other component -> null', async () => {
    expect((await asApi(A, (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: hex(801), libraryVersionId: uid(102) })))?.['id']).toBe(uid(801));
    expect((await asApi(A, (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: hex(805), libraryVersionId: uid(101) })))?.['id']).toBe(uid(805));
    expect(await asApi(A, (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: hex(801), libraryVersionId: uid(101) }))).toBeNull();
    expect(await asApi(A, (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(12), approvedSetHash: hex(801), libraryVersionId: uid(102) }))).toBeNull();
    expect(await asApi(A, (rc) => summaries.findSummaryByDeterminismKey(rc, { orderId: uid(11), approvedSetHash: hex(1), libraryVersionId: uid(102) }))).toBeNull();
  });

  it('history of an order is newest first and includes superseded rows', async () => {
    expect(ids(await asApi(A, (rc) => summaries.listSummariesByOrder(rc, uid(11))))).toEqual([uid(801), uid(805)]);
    expect(await asApi(A, (rc) => summaries.listSummariesByOrder(rc, uid(15)))).toEqual([]);
  });

  it('review queue: one status, oldest built_at first, limit honoured, optional centre filter', async () => {
    expect(ids(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: 'draft', limit: 50 })))).toEqual([uid(801), uid(804)]);
    expect(ids(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: 'draft', limit: 1 })))).toEqual([uid(801)]);
    expect(ids(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: 'draft', centreId: CENTRE_A1, limit: 50 })))).toEqual([uid(801), uid(804)]);
    expect(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: 'draft', centreId: CENTRE_A2, limit: 50 }))).toEqual([]);
    expect(ids(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: 'approved', centreId: CENTRE_A2, limit: 50 })))).toEqual([uid(802)]);
    expect(ids(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: 'rejected', limit: 50 })))).toEqual([uid(803)]);
    expect(ids(await asApi(A, (rc) => summaries.listReviewQueue(rc, { status: 'superseded', limit: 50 })))).toEqual([uid(805)]);
  });

  it('class A children: bindings by report version, reviews oldest first', async () => {
    expect(ids(await asApi(A, (rc) => bindings.listBindingsBySummary(rc, uid(802))))).toEqual([uid(901), uid(902)]);
    expect(ids(await asApi(A, (rc) => reviews.listSummaryReviews(rc, uid(802))))).toEqual([uid(911), uid(912)]);
    expect(ids(await asApi(A, (rc) => reviews.listLibraryReviews(rc, uid(102))))).toEqual([uid(921), uid(922)]);
    expect(ids(await asApi(A, (rc) => llmRuns.listLlmRuns(rc, uid(801))))).toEqual([uid(931)]);
    expect(await asApi(A, (rc) => bindings.listBindingsBySummary(rc, uid(801)))).toEqual([]);
  });
});
