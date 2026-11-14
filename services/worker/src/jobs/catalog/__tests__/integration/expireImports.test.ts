// T-26 (C3) worker integration: catalog.expire_imports — 02-TRD §10 ("validated|invalid past expires_at -> expired; exports past expires_at -> expired",
// set-based UPDATE, max_attempts 1), 08 A13 P-6 (per_tenant: runs under ONE tenant's claims, payload {tenant_id}), 05-SCHEMA §10.3 l.1308, TRD §9.1 (no revision, no event).
// Task under test: services/worker/src/jobs/catalog/tasks/catalog.expire_imports.ts exporting EXPIRE_IMPORTS = 'catalog.expire_imports' and
//   expireImports: TaskHandler; payload { tenant_id }. All DB access via ctx.tx.query in the dialect of helpers/cronDb.ts (the writer adapts the SQL, not the fake).
// ASSUMED (spec silent) — the writer may NOT change these tests, only raise a CR:
//   * "past" = expires_at strictly before ctx.now()/now() (same `< now()` as purge_files); a row with expires_at IS NULL never expires.
//   * exports: only status 'ready' expires; queued/building (in flight) are never touched.
//   * only `expires_at`-bearing, non-terminal rows change; nothing else is written (no files, no issues, no catalog_state, no job, no event).
import { describe, expect, it } from 'vitest';
import { expireImports } from '../../tasks/catalog.expire_imports.js';
import { DAY, TENANT_A, TENANT_B, USER, ago, ahead, makeCronDb, makeRunner, uid, type CronDb } from '../helpers/cronRunner.js';

const snap = (db: CronDb) => JSON.stringify(['imports', 'exports', 'files', 'import_issues', 'catalog_state'].map((t) => db.rows(t)));
const byId = (db: CronDb, t: string, id: string) => db.rows(t).find((r) => r.id === id)!;

function setup() {
  const db = makeCronDb();
  const ids: Record<string, string> = {};
  let n = 100;
  const imp = (key: string, tenant: string, status: string, expires: Date | null) => { ids[key] = db.seed.import(tenant, { id: uid(n++), status, expires_at: expires }).id as string; };
  const exp = (key: string, tenant: string, status: string, expires: Date | null) => { ids[key] = db.seed.export(tenant, { id: uid(n++), status, expires_at: expires }).id as string; };
  imp('valPast', TENANT_A, 'validated', ago(DAY));
  imp('invPast', TENANT_A, 'invalid', ago(1000));
  imp('valFuture', TENANT_A, 'validated', ahead(DAY));
  imp('invFuture', TENANT_A, 'invalid', ahead(DAY));
  imp('valNull', TENANT_A, 'validated', null);
  for (const s of ['uploaded', 'scanning', 'validating', 'quarantined', 'committing', 'committed', 'commit_failed', 'discarded', 'failed', 'expired']) imp(`other_${s}`, TENANT_A, s, ago(5 * DAY));
  exp('exReadyPast', TENANT_A, 'ready', ago(DAY));
  exp('exReadyFuture', TENANT_A, 'ready', ahead(DAY));
  exp('exQueuedPast', TENANT_A, 'queued', ago(DAY));
  exp('exBuildingPast', TENANT_A, 'building', ago(DAY));
  exp('exFailed', TENANT_A, 'failed', null);
  imp('bVal', TENANT_B, 'validated', ago(DAY));
  imp('bInv', TENANT_B, 'invalid', ago(DAY));
  exp('bEx', TENANT_B, 'ready', ago(DAY));
  const r = makeRunner(db, expireImports, { tenantId: TENANT_A });
  return { db, ids, r, go: () => r.run({ tenant_id: TENANT_A }) };
}

describe('catalog.expire_imports (T-26)', () => {
  it('validated and invalid imports past expires_at become expired', async () => {
    const { db, ids, go } = setup();
    await go();
    expect(byId(db, 'imports', ids.valPast!).status).toBe('expired');
    expect(byId(db, 'imports', ids.invPast!).status).toBe('expired');
  });

  it('validated/invalid imports not yet expired (or with no expires_at) are untouched', async () => {
    const { db, ids, go } = setup();
    await go();
    expect(byId(db, 'imports', ids.valFuture!).status).toBe('validated');
    expect(byId(db, 'imports', ids.invFuture!).status).toBe('invalid');
    expect(byId(db, 'imports', ids.valNull!).status).toBe('validated');
  });

  it('imports in any other status keep it even when expires_at is past (committed history is never rewritten)', async () => {
    const { db, ids, go } = setup();
    await go();
    for (const s of ['uploaded', 'scanning', 'validating', 'quarantined', 'committing', 'committed', 'commit_failed', 'discarded', 'failed', 'expired']) {
      expect(byId(db, 'imports', ids[`other_${s}`]!).status, s).toBe(s);
    }
  });

  it('ready exports past expires_at become expired; future ones and in-flight exports are untouched', async () => {
    const { db, ids, go } = setup();
    await go();
    expect(byId(db, 'exports', ids.exReadyPast!).status).toBe('expired');
    expect(byId(db, 'exports', ids.exReadyFuture!).status).toBe('ready');
    expect(byId(db, 'exports', ids.exQueuedPast!).status).toBe('queued');
    expect(byId(db, 'exports', ids.exBuildingPast!).status).toBe('building');
    expect(byId(db, 'exports', ids.exFailed!).status).toBe('failed');
  });

  it('boundary: 1 ms past expires; 1 ms to go does not (compared with the job clock)', async () => {
    const db = makeCronDb();
    const a = db.seed.import(TENANT_A, { id: uid(1), status: 'validated', expires_at: ago(1) });
    const b = db.seed.import(TENANT_A, { id: uid(2), status: 'validated', expires_at: ahead(1) });
    await makeRunner(db, expireImports).run({ tenant_id: TENANT_A });
    expect(byId(db, 'imports', a.id).status).toBe('expired');
    expect(byId(db, 'imports', b.id).status).toBe('validated');
  });

  it('changes only the status columns of expired rows (identity, file refs, summary, expires_at kept)', async () => {
    const { db, ids, go } = setup();
    const before = byId(db, 'imports', ids.valPast!);
    await go();
    const after = byId(db, 'imports', ids.valPast!);
    for (const k of ['id', 'tenant_id', 'kind', 'file_name', 'file_sha256', 'summary', 'upload_file_id', 'report_file_id', 'expires_at', 'created_by', 'created_at']) {
      expect(after[k], k).toEqual(before[k]);
    }
  });

  it('is idempotent: a second run (and a run with nothing due) changes nothing', async () => {
    const { db, go } = setup();
    await go();
    const once = snap(db);
    await go();
    expect(snap(db)).toBe(once);
    const empty = makeCronDb();
    const r = makeRunner(empty, expireImports);
    await expect(r.run({ tenant_id: TENANT_A })).resolves.toBeUndefined();
    expect(snap(empty)).toBe(snap(makeCronDb()));
  });

  it('runs under tenant claims: the other tenant\'s due rows are untouched', async () => {
    const { db, ids, go } = setup();
    await go();
    expect(byId(db, 'imports', ids.bVal!).status).toBe('validated');
    expect(byId(db, 'imports', ids.bInv!).status).toBe('invalid');
    expect(byId(db, 'exports', ids.bEx!).status).toBe('ready');
  });

  it('a payload naming another tenant than the job claims cannot expire that tenant\'s rows', async () => {
    const { db, ids, r } = setup();
    await r.run({ tenant_id: TENANT_B }).catch(() => undefined);      // may reject or no-op; either way B stays untouched
    expect(byId(db, 'imports', ids.bVal!).status).toBe('validated');
    expect(byId(db, 'exports', ids.bEx!).status).toBe('ready');
  });

  it('writes nothing besides imports/exports: no files, issues, revision, event or job (TRD §9.1)', async () => {
    const { db, r, go } = setup();
    db.seed.catalogState(TENANT_A, { catalog_revision: 7 });
    db.seed.file(TENANT_A, { expires_at: ago(DAY) });
    const before = JSON.stringify([db.rows('files'), db.rows('import_issues'), db.rows('catalog_state')]);
    await go();
    expect(JSON.stringify([db.rows('files'), db.rows('import_issues'), db.rows('catalog_state')])).toBe(before);
    expect(r.events).toEqual([]);
    expect(db.jobs).toEqual([]);
    expect(db.stmts.some((s) => /^\s*(DELETE|INSERT)\b/i.test(s.text))).toBe(false);
  });

  it('all statements run in the one job transaction of the claimed tenant', async () => {
    const { db, go } = setup();
    await go();
    expect(db.stmts.length).toBeGreaterThan(0);
    expect(new Set(db.stmts.map((s) => s.txId)).size).toBe(1);
    expect(new Set(db.stmts.map((s) => s.tenantId))).toEqual(new Set([TENANT_A]));
  });

  it('is atomic: if the exports update fails, the imports update is rolled back too and the error surfaces', async () => {
    const { db, ids, go } = setup();
    db.fail(/UPDATE catalog\.exports/i, () => Object.assign(new Error('injected'), { code: '57014' }));
    await expect(go()).rejects.toThrow();
    expect(byId(db, 'imports', ids.valPast!).status).toBe('validated');
    expect(byId(db, 'exports', ids.exReadyPast!).status).toBe('ready');
  });

  it('scales: 2000 due imports are all expired in one run (no silent cap)', async () => {
    const db = makeCronDb();
    for (let i = 0; i < 2000; i++) db.seed.import(TENANT_A, { id: uid(10_000 + i), status: i % 2 ? 'validated' : 'invalid', expires_at: ago(DAY) });
    await makeRunner(db, expireImports).run({ tenant_id: TENANT_A });
    expect(db.rows('imports').every((r) => r.status === 'expired')).toBe(true);
  });

  it('does not log file names, hashes or user ids (S-13)', async () => {
    const { db, r, go } = setup();
    db.seed.import(TENANT_A, { id: uid(7777), status: 'validated', expires_at: ago(DAY), file_name: 'PLANTED-NAME-9f3.xlsx', file_sha256: 'c'.repeat(64) });
    await go();
    expect(r.log.text()).not.toContain('PLANTED-NAME-9f3');
    expect(r.log.text()).not.toContain('c'.repeat(64));
    expect(r.log.text()).not.toContain(USER);
  });
});
