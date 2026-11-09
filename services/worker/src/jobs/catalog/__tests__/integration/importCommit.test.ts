// T-23 (C3) — worker task catalog.import_commit for kind price_list (02-TRD §8.5, §10), worker integration against the composite fake (helpers/commitDb.ts).
// Spec: PRD AC-16.6 (one new published version = sheet contents, full replacement; one catalog.changed.v1 price_list/versioned; import committed with
//       result_price_list_version_id; open draft -> commit_failed + file.draft_exists unless replace_draft), AC-16.7 (no second version on duplicates / redelivery);
//       02-TRD §8.5 (single tx; re-validate; actor-on-behalf = imports.committed_by; source_import_id; committed no-op), §8.6 (issue codes), §9.1 (event row), §12 (metric);
//       07-SECURITY S-1/S-13 (tenancy, no cell values in issues/logs), AB-16.
// Contract (SEAM = not fixed by the spec; see .orchestra/notes/C3.T-23-tests.md):
//   tasks/catalog.import_commit.ts exports IMPORT_COMMIT = 'catalog.import_commit' and importCommit: TaskHandler; payload { tenant_id, import_id, replace_draft? } (replace_draft: ASSUMED
//   in the payload, 05-SCHEMA has no column for it). The job re-reads the import row (status 'committing' is the only working state), loads the sheet from catalog.files(upload_file_id),
//   applies through the API services (pricing.service: draft -> items -> publish) inside ctx.tx, and runs as ctx.actor (system) while recording imports.committed_by on the rows it writes.
//   Commit params come from the import row: commit_effective_from (NULL -> ctx.now()), commit_change_reason, commit_publish, commit_accept_stale_base.
//   A failed commit (draft exists / re-validation error) RESOLVES with the import in commit_failed + appended import_issues (the failure state must be committed); a crash THROWS and leaves nothing.
//   ASSUMED (spec silent): row_no = worksheet row (header = 1), as in T-22; new version_no = max(version_no)+1 over ALL versions incl. discarded.
import { describe, expect, it } from 'vitest';
import { IMPORT_COMMIT, importCommit } from '../../tasks/catalog.import_commit.js';
import {
  COMMITTER, DRAFT_ID, IMPORT_ID, NOW, PRICE_LIST_ID, TENANT_A, TENANT_B, VER3_ID, eventsOf, makeCommitDb, makeCommitRunner, seedCommitting, type CommitDb, type WorldOpts,
} from '../helpers/commitDb.js';
import { makeKindsDb, makeKindsRunner, seedKindImport } from '../helpers/kindsDb.js';
import { priceWorkbook, prow } from '../helpers/workbooks.js';

const T = 20_000;
const EFFECTIVE = '2026-11-10T00:00:00.000Z';
const REASON = 'Synthetic tariff revision';
const payload = (o: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, import_id: IMPORT_ID, ...o });
// CBC changed (1500.00), LFT unchanged (2000.00), TSH removed from the sheet, HBA1C new (500.50)
const sheet = () => priceWorkbook([prow('CBC', 1500), prow('LFT', 2000), prow('HBA1C', 500.5)]);
const SHEET_PAISE = { CBC: 150000, LFT: 200000, HBA1C: 50050 };

async function setup(w: WorldOpts = {}, s: Parameters<typeof seedCommitting>[2] = {}, bytes?: Uint8Array) {
  const db = makeCommitDb(w);
  seedCommitting(db, bytes ?? (await sheet()), s);
  const runner = makeCommitRunner(db, importCommit);
  return { db, runner, run: (p: Record<string, unknown> = payload(), attempt?: number, max?: number) => runner.run(p, attempt, max) };
}
const newest = (db: CommitDb) => db.versions().at(-1)!;
const unchanged = (db: CommitDb) => ({ ...db.snapshot(), imports: undefined, import_issues: undefined, files: undefined });
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error; } return undefined; };

it('exports the task name', () => { expect(IMPORT_COMMIT).toBe('catalog.import_commit'); });

describe('AC-16.6 — a validated price_list import commits as exactly one new published version', () => {
  it('v(n+1) is published with the sheet contents (full replacement: TSH dropped, HBA1C added), the predecessor is superseded, the import is committed', async () => {
    const { db, run } = await setup();
    const otherTenant = db.snapshot(TENANT_B);
    await run();
    const versions = db.versions();
    expect(versions.map((v) => [v.version_no, v.status])).toEqual([[3, 'superseded'], [4, 'published']]);
    const v4 = versions[1]!;
    expect(new Date(v4.effective_from).toISOString()).toBe(EFFECTIVE);
    expect(new Date(versions[0]!.effective_to).toISOString()).toBe(EFFECTIVE);
    expect(v4).toMatchObject({ price_list_id: PRICE_LIST_ID, change_reason: REASON, item_count: 3, source_import_id: IMPORT_ID });
    expect(new Date(v4.published_at).toISOString()).toBe(NOW);
    expect(db.priceMap(v4.id)).toEqual(SHEET_PAISE);
    expect(db.priceMap(VER3_ID)).toEqual({ CBC: 100000, LFT: 200000, TSH: 300000 });         // history untouched
    const imp = db.imp();
    expect(imp).toMatchObject({ status: 'committed', result_price_list_version_id: v4.id, committed_by: COMMITTER });
    expect(imp.version).toBeGreaterThan(5);                                                  // seeded at 5; every state change bumps it
    expect(new Date(imp.committed_at).toISOString()).toBe(NOW);
    expect(imp.last_error_code ?? null).toBeNull();
    expect(db.snapshot(TENANT_B)).toEqual(otherTenant);                                      // no cross-tenant write
  }, T);

  it('exactly one catalog.changed.v1 {price_list, versioned} and exactly one revision bump (02-TRD §8.5 / §9.1)', async () => {
    const { db, runner, run } = await setup();
    const rev = db.revision();
    await run();
    expect(db.revision()).toBe(rev + 1);
    const ev = eventsOf(runner.events);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ entity_type: 'price_list', entity_id: PRICE_LIST_ID, change_kind: 'versioned', catalog_revision: rev + 1 });
    expect(new Date(ev[0]!.payload.effective_from).toISOString()).toBe(EFFECTIVE);
    expect(runner.metrics.filter((m) => m.name === 'lims_catalog_imports_total' && m.labels.outcome === 'committed')).toEqual([{ kind: 'inc', name: 'lims_catalog_imports_total', labels: { kind: 'price_list', outcome: 'committed' } }]);
  }, T);

  it('single transaction: every write of the commit (import row, version, items, catalog_state) is in ONE transaction', async () => {
    const { db, run } = await setup();
    await run();
    const writes = db.writes();
    expect(writes.length).toBeGreaterThan(5);
    expect(new Set(writes.map((w) => w.txId)).size).toBe(1);
    expect(writes.every((w) => w.main)).toBe(true);
    const names = writes.map((w) => /(?:INTO|UPDATE)\s+catalog\.(\w+)/i.exec(w.text)?.[1]);
    expect(names).toEqual(expect.arrayContaining(['imports', 'price_list_versions', 'price_list_items', 'catalog_state']));
  }, T);

  it('rows are written on behalf of imports.committed_by (actor-on-behalf), not the system actor', async () => {
    const { db, run } = await setup();
    await run();
    const v4 = newest(db);
    expect(v4).toMatchObject({ created_by: COMMITTER, published_by: COMMITTER, updated_by: COMMITTER });
    const items = db.items(v4.id);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.created_by === COMMITTER && i.updated_by === COMMITTER)).toBe(true);
  }, T);

  it('prices are converted exactly to paise (1234.57, 19.99, 0, text "1500.5", 9999999.99 — no float drift)', async () => {
    const bytes = await priceWorkbook([prow('CBC', 1234.57), prow('LFT', 19.99), prow('TSH', 0), prow('HBA1C', '1500.5')]);
    const { db, run } = await setup({}, {}, bytes);
    await run();
    expect(db.priceMap(newest(db).id)).toEqual({ CBC: 123457, LFT: 1999, TSH: 0, HBA1C: 150050 });
    const big = await setup({}, {}, await priceWorkbook([prow('CBC', 9999999.99)]));
    await big.run();
    expect(big.db.priceMap(newest(big.db).id)).toEqual({ CBC: 999999999 });
  }, T);

  it('effective_from NULL -> the job clock (ctx.now()); the predecessor window closes at that instant', async () => {
    const { db, run } = await setup({}, { effectiveFrom: null });
    await run();
    expect(new Date(newest(db).effective_from).toISOString()).toBe(NOW);
    expect(new Date(db.versions()[0]!.effective_to).toISOString()).toBe(NOW);
  }, T);

  it('publish:false -> the new version stays a draft: v3 still published, no event, no revision bump, import committed with the draft as result', async () => {
    const { db, runner, run } = await setup({}, { publish: false });
    const rev = db.revision();
    await run();
    const v4 = newest(db);
    expect(v4).toMatchObject({ version_no: 4, status: 'draft', source_import_id: IMPORT_ID });
    expect(db.versions()[0]).toMatchObject({ version_no: 3, status: 'published' });
    expect(db.priceMap(v4.id)).toEqual(SHEET_PAISE);
    expect(db.revision()).toBe(rev);
    expect(eventsOf(runner.events)).toHaveLength(0);
    expect(db.imp()).toMatchObject({ status: 'committed', result_price_list_version_id: v4.id });
  }, T);

  it('the sheet is the whole truth, not a diff on the base: a stale base accepted at commit time replaces the CURRENT latest version (v4 -> v5)', async () => {
    const { db, run } = await setup({ v4: true }, { baseVersionNo: 3, acceptStaleBase: true });
    await run();
    expect(db.versions().map((v) => [v.version_no, v.status])).toEqual([[3, 'superseded'], [4, 'superseded'], [5, 'published']]);
    expect(db.priceMap(newest(db).id)).toEqual(SHEET_PAISE);
    expect(db.imp()).toMatchObject({ status: 'committed', result_price_list_version_id: newest(db).id });
  }, T);

});

describe('AC-16.6 — open drafts (02-TRD §8.5 open drafts)', () => {
  it('open manual draft and no replace_draft -> commit_failed + one file.draft_exists error appended; the draft, v3, revision and events are untouched', async () => {
    const { db, runner, run } = await setup({ draft: true }, { warnings: 2 });
    const before = unchanged(db);
    await run();                                                                          // resolves: the failure state is committed
    expect(db.imp()).toMatchObject({ status: 'commit_failed' });
    expect(db.imp().result_price_list_version_id ?? null).toBeNull();
    expect(db.imp().committed_at ?? null).toBeNull();
    const issues = db.issues();
    const draftIssues = issues.filter((i) => i.issue_code === 'file.draft_exists');
    expect(draftIssues).toHaveLength(1);
    expect(draftIssues[0]).toMatchObject({ severity: 'error', seq: 3 });                   // appended after the 2 validation warnings
    expect(draftIssues[0]!.message.length).toBeLessThanOrEqual(300);
    expect(issues.slice(0, 2).map((i) => i.issue_code)).toEqual(['row.price_change_large', 'row.price_change_large']);
    expect(unchanged(db)).toEqual(before);                                                // pricing tables + revision identical
    expect(db.versions().find((v) => v.id === DRAFT_ID)).toMatchObject({ status: 'draft', version_no: 4 });
    expect(db.priceMap(DRAFT_ID)).toEqual({ HBA1C: 77700 });
    expect(eventsOf(runner.events)).toHaveLength(0);
    expect(runner.metrics.some((m) => m.name === 'lims_catalog_imports_total' && m.labels.outcome === 'commit_failed')).toBe(true);
  }, T);

  it('replace_draft:true -> the draft is discarded first (status discarded), then one new published version equal to the sheet; one event, one bump', async () => {
    const { db, runner, run } = await setup({ draft: true });
    const rev = db.revision();
    await run(payload({ replace_draft: true }));
    expect(db.versions().map((v) => [v.version_no, v.status])).toEqual([[3, 'superseded'], [4, 'discarded'], [5, 'published']]);
    expect(db.priceMap(newest(db).id)).toEqual(SHEET_PAISE);
    expect(db.imp()).toMatchObject({ status: 'committed', result_price_list_version_id: newest(db).id });
    expect(db.revision()).toBe(rev + 1);
    expect(eventsOf(runner.events)).toHaveLength(1);
    expect(db.issues().filter((i) => i.issue_code === 'file.draft_exists')).toHaveLength(0);
  }, T);

  it('replace_draft:true with publish:false leaves the NEW version as the single open draft (the old one is discarded)', async () => {
    const { db, run } = await setup({ draft: true }, { publish: false });
    await run(payload({ replace_draft: true }));
    expect(db.versions().filter((v) => v.status === 'draft')).toHaveLength(1);
    expect(db.versions().find((v) => v.id === DRAFT_ID)!.status).toBe('discarded');
    expect(db.priceMap(newest(db).id)).toEqual(SHEET_PAISE);
  }, T);

  it('replace_draft:true with no draft present behaves like a normal commit (nothing discarded)', async () => {
    const { db, run } = await setup();
    await run(payload({ replace_draft: true }));
    expect(db.versions().map((v) => v.status)).toEqual(['superseded', 'published']);
  }, T);

  it('replace_draft must be exactly true: "true", 1 or "yes" do not discard (commit_failed with file.draft_exists)', async () => {
    for (const bad of ['true', 1, 'yes']) {
      const { db, run } = await setup({ draft: true });
      await run(payload({ replace_draft: bad }));
      expect(db.imp().status, String(bad)).toBe('commit_failed');
      expect(db.versions().find((v) => v.id === DRAFT_ID)!.status, String(bad)).toBe('draft');
    }
  }, T);
});

describe('re-validation at commit time (catalog may have changed since validation)', () => {
  it('an orderable removed meanwhile -> commit_failed + row.orderable_unknown for its row; nothing applied, no event, no cell value in the issue', async () => {
    const { db, runner, run } = await setup({ drop: ['HBA1C'] });
    const before = unchanged(db);
    await run();
    expect(db.imp().status).toBe('commit_failed');
    const bad = db.issues().filter((i) => i.issue_code === 'row.orderable_unknown');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ severity: 'error', sheet: 'Prices', row_no: 4 });
    expect(JSON.stringify(bad)).not.toMatch(/HBA1C|50050|500\.5/);
    expect(unchanged(db)).toEqual(before);
    expect(eventsOf(runner.events)).toHaveLength(0);
  }, T);

  it('an upload that is no longer a readable workbook -> commit_failed with a file.* error; nothing applied', async () => {
    const { db, run } = await setup({}, {}, new TextEncoder().encode('PK\u0003\u0004 this is not a workbook'));
    const before = unchanged(db);
    await run();
    expect(db.imp().status).toBe('commit_failed');
    expect(db.issues().some((i) => i.severity === 'error' && /^file\./.test(i.issue_code))).toBe(true);
    expect(unchanged(db)).toEqual(before);
  }, T);

  it('the upload file row is gone (purged) -> never a half-commit: nothing applied (throws or commit_failed)', async () => {
    const { db, run } = await setup();
    db.v.committed['files']!.length = 0;
    const before = unchanged(db);
    await errOf(run());
    expect(['committing', 'commit_failed']).toContain(db.imp().status);
    expect(unchanged(db)).toEqual(before);
  }, T);

  it('a missing commit_change_reason (corrupt row) can never publish a version with an empty reason', async () => {
    const { db, run } = await setup({}, { reason: null });
    const e = await errOf(run());
    expect(db.versions().filter((v) => v.status === 'published' && v.version_no > 3)).toHaveLength(0);
    if (e) expect(db.imp().status).toBe('committing'); else expect(db.imp().status).toBe('commit_failed');
  }, T);
});

describe('AC-16.7 — duplicates, redelivery, wrong state: no second version', () => {
  it('status committed -> no-op (no write, no event); the job run twice in a row yields exactly one new version', async () => {
    const { db, runner, run } = await setup();
    await run();
    const after = db.snapshot();
    const writesBefore = db.writes().length;
    const eventsBefore = runner.events.length;
    await run();
    await run();
    expect(db.snapshot()).toEqual(after);
    expect(db.writes().length).toBe(writesBefore);
    expect(runner.events.length).toBe(eventsBefore);
    expect(db.versions()).toHaveLength(2);
  }, T);

  it.each(['uploaded', 'scanning', 'validating', 'validated', 'invalid', 'quarantined', 'commit_failed', 'discarded', 'expired', 'failed'])(
    'status %s -> no-op: nothing written, no event', async (status) => {
      const { db, runner, run } = await setup({}, { status });
      const before = db.snapshot();
      await run();
      expect(db.snapshot()).toEqual(before);
      expect(db.writes()).toHaveLength(0);
      expect(runner.events).toHaveLength(0);
    }, T);

  it('two deliveries of the same job at once (duplicate job, many workers): exactly one new version, one event in total, one revision bump', async () => {
    const db = makeCommitDb();
    seedCommitting(db, await sheet());
    const a = makeCommitRunner(db, importCommit);
    const b = makeCommitRunner(db, importCommit);
    const rev = db.revision();
    const res = await Promise.allSettled([a.run(payload()), b.run(payload())]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(db.versions().filter((v) => v.version_no > 3)).toHaveLength(1);
    expect(eventsOf(a.events).length + eventsOf(b.events).length).toBe(1);
    expect(db.revision()).toBe(rev + 1);
    expect(db.imp().status).toBe('committed');
  }, T);
});

describe('tenancy and hostile payloads (S-1, AB-5)', () => {
  it('payload.tenant_id different from the job tenant -> no-op (resolves), nothing changes', async () => {
    const { db, run } = await setup();
    const before = db.snapshot();
    await run(payload({ tenant_id: TENANT_B }));
    expect(db.snapshot()).toEqual(before);
    expect(db.writes()).toHaveLength(0);
  }, T);

  it('a tenant-B job naming a tenant-A import id -> no-op; tenant A and B data unchanged', async () => {
    const db = makeCommitDb();
    seedCommitting(db, await sheet());
    const a = db.snapshot(TENANT_A), b = db.snapshot(TENANT_B);
    await makeCommitRunner(db, importCommit, { tenantId: TENANT_B }).run({ tenant_id: TENANT_B, import_id: IMPORT_ID });
    expect(db.snapshot(TENANT_A)).toEqual(a);
    expect(db.snapshot(TENANT_B)).toEqual(b);
  }, T);

  it.each([[{}], [{ tenant_id: TENANT_A }], [{ tenant_id: TENANT_A, import_id: 42 }], [{ tenant_id: TENANT_A, import_id: "'; DROP TABLE catalog.imports; --" }],
    [{ tenant_id: TENANT_A, import_id: '0190c322-0000-7000-8000-00000000dead' }], [null], ['x']])('malformed / unknown payload %j -> no-op, no throw, no write', async (p) => {
    const { db, run } = await setup();
    const before = db.snapshot();
    await run(p as never);
    expect(db.snapshot()).toEqual(before);
    expect(db.writes()).toHaveLength(0);
  }, T);

  // T-25 ruling (C3.T-25-ruling.md #6): superseded the T-23 "other kind untouched" test. 02-TRD.md:661 gives ONE commit job for all kinds (re-validates in one tx,
  // a new error -> commit_failed); T-25 extends it to catalog_master. A catalog_master import holding a price-list workbook therefore fails re-validation.
  it('a catalog_master import holding a price-list workbook -> commit_failed; no domain row, no revision change', async () => {
    // the price-list composite fake has no catalog_master tables, so this one runs over the kinds composite (same runner, same task)
    const db = makeKindsDb('catalog_master');
    seedKindImport(db, await sheet(), { status: 'committing' });
    const before = { ...db.snapshot(), imports: undefined, import_issues: undefined, files: undefined }, rev = db.revision();
    await makeKindsRunner(db, importCommit).run(payload());
    expect(db.imp()).toMatchObject({ status: 'commit_failed' });
    expect(db.imp().committed_at ?? null).toBeNull();
    expect({ ...db.snapshot(), imports: undefined, import_issues: undefined, files: undefined }).toEqual(before);
    expect(db.revision()).toBe(rev);
  }, T);

  it('mass assignment: payload fields other than tenant_id/import_id/replace_draft (status, committed_by, effective_from) are ignored', async () => {
    const { db, run } = await setup();
    await run(payload({ status: 'committed', committed_by: TENANT_B, effective_from: '2030-01-01T00:00:00.000Z', change_reason: 'injected', publish: false }));
    const v4 = newest(db);
    expect(v4).toMatchObject({ status: 'published', change_reason: REASON, created_by: COMMITTER });
    expect(new Date(v4.effective_from).toISOString()).toBe(EFFECTIVE);
  }, T);
});

describe('S-13 — no cell values in logs or issues', () => {
  it('a successful and a failed commit log no orderable codes, prices or file names', async () => {
    for (const w of [{}, { draft: true }, { drop: ['HBA1C'] as WorldOpts['drop'] }]) {
      const { db, runner, run } = await setup(w);
      await run();
      const text = runner.log.text() + JSON.stringify(db.issues());
      expect(text, JSON.stringify(w)).not.toMatch(/\b(CBC|LFT|TSH|HBA1C)\b|150000|50050|1500|prices\.xlsx/);
    }
  }, T);
});
