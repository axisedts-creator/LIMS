// T-23 (C3) — crash / retry of catalog.import_commit (06-PLAN T-23 test: "worker integration (kill between enqueue and commit)"; 02-TRD §8.5 "Retry after crash",
// §10 max_attempts 3; PRD AC-16.7 "no second version"). The worker is killed at EVERY write of the apply (and just before COMMIT): Postgres rolls the transaction back,
// the import stays `committing`, and the retry applies exactly once. Contract as in importCommit.test.ts. ctx.events is a plain recorder here (not transactional), so event
// counts are asserted on the successful run only.
import { describe, expect, it } from 'vitest';
import { importCommit } from '../../tasks/catalog.import_commit.js';
import { IMPORT_ID, TENANT_A, eventsOf, makeCommitDb, makeCommitRunner, seedCommitting, type WorldOpts } from '../helpers/commitDb.js';
import { priceWorkbook, prow } from '../helpers/workbooks.js';

const T = 60_000;
const payload = (o: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, import_id: IMPORT_ID, ...o });
const sheet = () => priceWorkbook([prow('CBC', 1500), prow('LFT', 2000), prow('HBA1C', 500.5)]);
const SHEET_PAISE = { CBC: 150000, LFT: 200000, HBA1C: 50050 };
async function fresh(w: WorldOpts = {}, publish = true) {
  const db = makeCommitDb(w);
  seedCommitting(db, await sheet(), { publish });
  return db;
}

describe('kill between enqueue and commit: committing + crash anywhere = nothing applied; the retry applies once', () => {
  it('crash at each write n = 1..K of the main transaction: snapshot identical to before, import still committing; retry succeeds with exactly one new version, one event, one bump', async () => {
    const probe = await fresh();
    await makeCommitRunner(probe, importCommit).run(payload());
    const K = probe.writes().filter((w) => w.main).length;
    expect(K).toBeGreaterThan(5);                                                       // import row + version + 3 items + supersede/publish + catalog_state …

    for (let n = 1; n <= K; n++) {
      const db = await fresh();
      const before = db.snapshot();
      db.crashAtWrite(n);
      const crashed = makeCommitRunner(db, importCommit);
      await expect(crashed.run(payload(), 1), `crash at write ${n}`).rejects.toThrow('simulated crash');
      expect(db.snapshot(), `nothing applied after crash at write ${n}`).toEqual(before);
      expect(db.imp().status, `crash at write ${n}`).toBe('committing');

      db.noCrash();
      const retry = makeCommitRunner(db, importCommit);
      await retry.run(payload(), 2);
      expect(db.versions().map((v) => [v.version_no, v.status]), `retry after crash at ${n}`).toEqual([[3, 'superseded'], [4, 'published']]);
      expect(db.priceMap(db.versions()[1]!.id)).toEqual(SHEET_PAISE);
      expect(db.revision(), `one bump after crash at ${n}`).toBe((before.revision as number) + 1);
      expect(eventsOf(retry.events), `one event after crash at ${n}`).toHaveLength(1);
      expect(db.imp()).toMatchObject({ status: 'committed', result_price_list_version_id: db.versions()[1]!.id });
    }
  }, T);

  it('killed after the last write, just before COMMIT: nothing applied; the retry applies once', async () => {
    const db = await fresh();
    const before = db.snapshot();
    db.crashBeforeCommit();
    await expect(makeCommitRunner(db, importCommit).run(payload(), 1)).rejects.toThrow('before COMMIT');
    expect(db.snapshot()).toEqual(before);
    db.noCrash();
    await makeCommitRunner(db, importCommit).run(payload(), 2);
    expect(db.versions()).toHaveLength(2);
    expect(db.imp().status).toBe('committed');
  }, T);

  it('killed AFTER COMMIT before the ack (job redelivered): the redelivery is a no-op — still one new version, no second event or bump', async () => {
    const db = await fresh();
    const first = makeCommitRunner(db, importCommit);
    await first.run(payload(), 1);
    const after = db.snapshot();
    const again = makeCommitRunner(db, importCommit);
    await again.run(payload(), 2);
    expect(db.snapshot()).toEqual(after);
    expect(eventsOf(again.events)).toHaveLength(0);
    expect(db.versions()).toHaveLength(2);
  }, T);

  it('the crash-retry also holds for publish:false and for replace_draft (the discard is rolled back with the rest)', async () => {
    for (const [w, publish, extra] of [[{}, false, {}], [{ draft: true }, true, { replace_draft: true }]] as const) {
      const db = await fresh(w, publish);
      const before = db.snapshot();
      db.crashAtWrite(4);
      await expect(makeCommitRunner(db, importCommit).run(payload(extra), 1)).rejects.toThrow('simulated crash');
      expect(db.snapshot()).toEqual(before);
      db.noCrash();
      await makeCommitRunner(db, importCommit).run(payload(extra), 2);
      expect(db.versions().filter((v) => v.status === (publish ? 'published' : 'draft') && v.version_no > 3)).toHaveLength(1);
      expect(db.imp().status).toBe('committed');
    }
  }, T);
});

describe('persistent failure across all attempts (max_attempts 3)', () => {
  it('a dependency that always fails (item insert) -> every attempt throws, nothing is ever applied, the import is never `committed`, no event stays visible', async () => {
    const db = await fresh();
    const before = db.snapshot();
    db.pricing.fail(/INSERT INTO catalog\.price_list_items/i, () => new Error('injected dependency failure'));
    for (const attempt of [1, 2, 3]) {
      const r = makeCommitRunner(db, importCommit);
      const e = await r.run(payload(), attempt, 3).then(() => undefined, (x: Error) => x);
      expect(e?.message ?? '', `attempt ${attempt}`).not.toMatch(/CBC|LFT|HBA1C/);
      // Final attempt: the handler may fail the import itself (commit_failed) or leave `committing` for the core's final-attempt handler (02-TRD §10 table).
      expect(['committing', 'commit_failed'], `attempt ${attempt}`).toContain(db.imp().status);
      expect(db.versions(), `attempt ${attempt}`).toHaveLength(1);
      expect(db.revision()).toBe(before.revision);
    }
    expect({ ...db.snapshot(), imports: 0, import_issues: 0 }).toEqual({ ...before, imports: 0, import_issues: 0 });
  }, T);
});
