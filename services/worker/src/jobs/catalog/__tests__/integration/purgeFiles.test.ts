// T-26 (C3) worker integration: catalog.purge_files — 02-TRD §10 (delete catalog.files where expires_at < now(), NULL the referencing
// imports.upload_file_id / report_file_id / exports.file_id in the SAME transaction, delete import_issues where expires_at < now(); DELETE … RETURNING;
// max_attempts 1), 05-SCHEMA §10.1 (plain uuid refs, purge NULLs them, imports/exports rows are kept), §10.3 l.1307-1308, REQ-SEC-139 (files purged at 30 d),
// 08 A13 P-6 (per_tenant, payload {tenant_id}), 07-SECURITY S-13 (log scan).
// Task under test: services/worker/src/jobs/catalog/tasks/catalog.purge_files.ts exporting PURGE_FILES = 'catalog.purge_files' and
//   purgeFiles: TaskHandler; payload { tenant_id }. All DB access via ctx.tx.query in the dialect of helpers/cronDb.ts (the writer adapts the SQL, not the fake).
// ASSUMED (spec silent) — the writer may NOT change these tests, only raise a CR:
//   * "expired" = expires_at strictly before now(); file purpose does not matter (import_upload, import_report, export are all purged).
//   * files and issues expire independently (an expired issue is deleted even if its upload file is not, and vice versa).
//   * the task never reads files.content (up to 15 MB per row) and never SELECT *s from files.
//   * a run purges everything due (no cap that leaves due rows behind).
import { describe, expect, it } from 'vitest';
import { purgeFiles } from '../../tasks/catalog.purge_files.js';
import { DAY, TENANT_A, TENANT_B, USER, ago, ahead, makeCronDb, makeRunner, uid, type CronDb } from '../helpers/cronRunner.js';

const snap = (db: CronDb) => JSON.stringify(['imports', 'exports', 'files', 'import_issues', 'catalog_state'].map((t) => db.rows(t)));
const fileIds = (db: CronDb, tenant?: string) => db.rows('files', tenant).map((f) => f.id as string).sort();
const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);

/** Tenant A: 3 expired files (one per purpose) referenced by an expired import + an expired export; 2 live files referenced by a committed import
 *  + a ready export; 1 expired orphan; issues: 2 expired (import i1) + 1 live (i2) + 1 expired issue of a LIVE-file import. Tenant B mirrors the expired parts. */
function setup() {
  const db = makeCronDb();
  const x: Record<string, string> = {};
  const file = (key: string, tenant: string, purpose: string, expires: Date, name = `${key}.xlsx`) => { x[key] = db.seed.file(tenant, { id: uid(Object.keys(x).length + 100), purpose, expires_at: expires, file_name: name, content: bytes }).id as string; };
  file('fUp', TENANT_A, 'import_upload', ago(DAY));
  file('fRep', TENANT_A, 'import_report', ago(1000));
  file('fExp', TENANT_A, 'export', ago(2 * DAY));
  file('fOrphan', TENANT_A, 'export', ago(DAY));
  file('fLiveUp', TENANT_A, 'import_upload', ahead(DAY));
  file('fLiveExp', TENANT_A, 'export', ahead(29 * DAY));
  file('bUp', TENANT_B, 'import_upload', ago(DAY));
  file('bExp', TENANT_B, 'export', ago(DAY));
  const imp = (key: string, tenant: string, over: Record<string, unknown>) => { x[key] = db.seed.import(tenant, { id: uid(Object.keys(x).length + 100), ...over }).id as string; };
  imp('i1', TENANT_A, { status: 'expired', upload_file_id: x.fUp, report_file_id: x.fRep, expires_at: ago(DAY), summary: { rows: 3 } });
  imp('i2', TENANT_A, { status: 'committed', upload_file_id: x.fLiveUp, report_file_id: null });
  imp('i3', TENANT_A, { status: 'validated', upload_file_id: x.fLiveUp, report_file_id: null });   // second ref to a live file
  imp('bi', TENANT_B, { status: 'expired', upload_file_id: x.bUp });
  const exp = (key: string, tenant: string, over: Record<string, unknown>) => { x[key] = db.seed.export(tenant, { id: uid(Object.keys(x).length + 100), ...over }).id as string; };
  exp('e1', TENANT_A, { status: 'expired', file_id: x.fExp, expires_at: ago(2 * DAY) });
  exp('e2', TENANT_A, { status: 'ready', file_id: x.fLiveExp, expires_at: ahead(29 * DAY) });
  exp('be', TENANT_B, { status: 'expired', file_id: x.bExp });
  db.seed.issue(TENANT_A, x.i1!, 1, { expires_at: ago(DAY), message: 'PLANTED-ISSUE-MSG-1' });
  db.seed.issue(TENANT_A, x.i1!, 2, { expires_at: ago(1000) });
  db.seed.issue(TENANT_A, x.i2!, 1, { expires_at: ahead(DAY) });
  db.seed.issue(TENANT_A, x.i2!, 2, { expires_at: ago(DAY) });                                    // issue due, its import's file is live
  db.seed.issue(TENANT_B, x.bi!, 1, { expires_at: ago(DAY) });
  const r = makeRunner(db, purgeFiles, { tenantId: TENANT_A });
  return { db, x, r, go: () => r.run({ tenant_id: TENANT_A }) };
}
const row = (db: CronDb, t: string, id: string) => db.rows(t).find((r) => r.id === id)!;
const issueKeys = (db: CronDb, tenant: string) => db.rows('import_issues', tenant).map((i) => `${i.import_id}#${i.seq}`).sort();

describe('catalog.purge_files (T-26)', () => {
  it('deletes every file past expires_at — upload, report and export alike — and keeps the live ones', async () => {
    const { db, x, go } = setup();
    await go();
    expect(fileIds(db, TENANT_A)).toEqual([x.fLiveUp!, x.fLiveExp!].sort());
  });

  it('keeps the bytes and metadata of live files exactly as they were', async () => {
    const { db, x, go } = setup();
    const before = JSON.stringify(row(db, 'files', x.fLiveUp!));
    await go();
    expect(JSON.stringify(row(db, 'files', x.fLiveUp!))).toBe(before);
    expect([...row(db, 'files', x.fLiveExp!).content]).toEqual([...bytes]);
  });

  it('NULLs imports.upload_file_id / report_file_id and exports.file_id that pointed at purged files', async () => {
    const { db, x, go } = setup();
    await go();
    expect(row(db, 'imports', x.i1!).upload_file_id).toBeNull();
    expect(row(db, 'imports', x.i1!).report_file_id).toBeNull();
    expect(row(db, 'exports', x.e1!).file_id).toBeNull();
  });

  it('leaves references to live files alone (both imports pointing at the same live file)', async () => {
    const { db, x, go } = setup();
    await go();
    expect(row(db, 'imports', x.i2!).upload_file_id).toBe(x.fLiveUp);
    expect(row(db, 'imports', x.i3!).upload_file_id).toBe(x.fLiveUp);
    expect(row(db, 'exports', x.e2!).file_id).toBe(x.fLiveExp);
  });

  it('never deletes imports/exports rows nor changes their status, summary or expiry (05-SCHEMA §10.1: rows are kept forever)', async () => {
    const { db, x, go } = setup();
    const before = [...['i1', 'i2', 'i3'].map((k) => ['imports', row(db, 'imports', x[k]!)] as const), ...['e1', 'e2'].map((k) => ['exports', row(db, 'exports', x[k]!)] as const)];
    await go();
    expect(db.rows('imports', TENANT_A)).toHaveLength(3);
    expect(db.rows('exports', TENANT_A)).toHaveLength(2);
    for (const [t, b] of before) {
      const a = row(db, t, b.id);
      for (const k of ['status', 'expires_at', 'kind', 'summary', 'file_name', 'last_error_code'].filter((k) => k in b)) expect(a[k], `${b.id}.${k}`).toEqual(b[k]);
    }
  });

  it('a purged file leaves no dangling reference anywhere in the tenant (invariant, any implementation)', async () => {
    const { db, go } = setup();
    await go();
    const live = new Set(fileIds(db, TENANT_A));
    const refs = [
      ...db.rows('imports', TENANT_A).flatMap((i) => [i.upload_file_id, i.report_file_id]),
      ...db.rows('exports', TENANT_A).map((e) => e.file_id),
    ].filter((v) => v != null);
    for (const ref of refs) expect(live.has(ref), String(ref)).toBe(true);
  });

  it('deletes an expired file that nothing references', async () => {
    const { db, x, go } = setup();
    await go();
    expect(db.rows('files').some((f) => f.id === x.fOrphan)).toBe(false);
  });

  it('deletes import_issues past expires_at, keeps the others — independent of the file purge', async () => {
    const { db, x, go } = setup();
    await go();
    expect(issueKeys(db, TENANT_A)).toEqual([`${x.i2}#1`]);
  });

  it('boundary: a file/issue 1 ms past expiry goes, 1 ms before expiry stays', async () => {
    const db = makeCronDb();
    const gone = db.seed.file(TENANT_A, { id: uid(1), expires_at: ago(1) });
    const stays = db.seed.file(TENANT_A, { id: uid(2), expires_at: ahead(1) });
    const imp = db.seed.import(TENANT_A, { id: uid(3), status: 'validated' });
    db.seed.issue(TENANT_A, imp.id, 1, { expires_at: ago(1) });
    db.seed.issue(TENANT_A, imp.id, 2, { expires_at: ahead(1) });
    await makeRunner(db, purgeFiles).run({ tenant_id: TENANT_A });
    expect(fileIds(db)).toEqual([stays.id]);
    expect(db.rows('import_issues').map((i) => i.seq)).toEqual([2]);
    expect(gone.id).not.toBe(stays.id);
  });

  it('is idempotent: a second run (and a run with nothing due) changes nothing and does not fail', async () => {
    const { db, go } = setup();
    await go();
    const once = snap(db);
    await go();
    expect(snap(db)).toBe(once);
    const empty = makeCronDb();
    await expect(makeRunner(empty, purgeFiles).run({ tenant_id: TENANT_A })).resolves.toBeUndefined();
  });

  it('runs under tenant claims: the other tenant\'s expired files, issues and references are untouched', async () => {
    const { db, x, go } = setup();
    await go();
    expect(fileIds(db, TENANT_B)).toEqual([x.bUp!, x.bExp!].sort());
    expect(row(db, 'imports', x.bi!).upload_file_id).toBe(x.bUp);
    expect(row(db, 'exports', x.be!).file_id).toBe(x.bExp);
    expect(issueKeys(db, TENANT_B)).toEqual([`${x.bi}#1`]);
  });

  it('a payload naming another tenant than the job claims cannot purge that tenant', async () => {
    const { db, x, r } = setup();
    await r.run({ tenant_id: TENANT_B }).catch(() => undefined);
    expect(fileIds(db, TENANT_B)).toEqual([x.bUp!, x.bExp!].sort());
    expect(issueKeys(db, TENANT_B)).toEqual([`${x.bi}#1`]);
  });

  it('is one transaction: a failing reference update rolls the file and issue deletes back (imports)', async () => {
    const { db, x, go } = setup();
    const before = snap(db);
    db.fail(/UPDATE catalog\.imports/i, () => Object.assign(new Error('injected'), { code: '57014' }));
    await expect(go()).rejects.toThrow();
    expect(snap(db)).toBe(before);
    expect(row(db, 'imports', x.i1!).upload_file_id).toBe(x.fUp);
  });

  it('is one transaction: a failing reference update rolls everything back (exports)', async () => {
    const { db, go } = setup();
    const before = snap(db);
    db.fail(/UPDATE catalog\.exports/i);
    await expect(go()).rejects.toThrow();
    expect(snap(db)).toBe(before);
  });

  it('is one transaction: a failing issue delete leaves the files and references intact', async () => {
    const { db, go } = setup();
    const before = snap(db);
    db.fail(/DELETE FROM catalog\.import_issues/i);
    await expect(go()).rejects.toThrow();
    expect(snap(db)).toBe(before);
  });

  it('all statements run in the one job transaction of the claimed tenant', async () => {
    const { db, go } = setup();
    await go();
    expect(new Set(db.stmts.map((s) => s.txId)).size).toBe(1);
    expect(new Set(db.stmts.map((s) => s.tenantId))).toEqual(new Set([TENANT_A]));
  });

  it('only touches files, import_issues, imports, exports; no INSERT, no revision bump, no event, no job (TRD §9.1)', async () => {
    const { db, r, go } = setup();
    db.seed.catalogState(TENANT_A, { catalog_revision: 7 });
    const state = JSON.stringify(db.rows('catalog_state'));
    await go();
    expect(JSON.stringify(db.rows('catalog_state'))).toBe(state);
    expect(r.events).toEqual([]);
    expect(db.jobs).toEqual([]);
    expect(db.stmts.some((s) => /^\s*INSERT\b/i.test(s.text))).toBe(false);
    for (const s of db.stmts.filter((s) => /^\s*(DELETE|UPDATE)\b/i.test(s.text))) expect(s.text, s.text).toMatch(/catalog\.(files|import_issues|imports|exports)\b/i);
  });

  it('never loads file bytes: no statement reads files.content or SELECT * from files', async () => {
    const { db, go } = setup();
    await go();
    for (const s of db.stmts.filter((s) => /catalog\.files\b/i.test(s.text))) {
      expect(s.text, s.text).not.toMatch(/\bcontent\b/i);
      expect(s.text, s.text).not.toMatch(/\bSELECT\s+(\w+\.)?\*|RETURNING\s+(\w+\.)?\*/i);
    }
  });

  it('purges everything due in one run — 1500 expired files with their references, no silent cap', async () => {
    const db = makeCronDb();
    for (let i = 0; i < 1500; i++) {
      const f = db.seed.file(TENANT_A, { id: uid(20_000 + i), expires_at: ago(DAY) });
      db.seed.export(TENANT_A, { id: uid(40_000 + i), status: 'expired', file_id: f.id });
    }
    await makeRunner(db, purgeFiles).run({ tenant_id: TENANT_A });
    expect(db.rows('files')).toHaveLength(0);
    expect(db.rows('exports').every((e) => e.file_id === null)).toBe(true);
  });

  it('does not log file names, issue messages, hashes or user ids (S-13)', async () => {
    const { db, r, go } = setup();
    db.seed.file(TENANT_A, { id: uid(7001), expires_at: ago(DAY), file_name: 'PLANTED-FILE-NAME-77.xlsx', sha256: 'd'.repeat(64) });
    await go();
    const text = r.log.text();
    for (const secret of ['PLANTED-FILE-NAME-77', 'PLANTED-ISSUE-MSG-1', 'd'.repeat(64), USER]) expect(text, secret).not.toContain(secret);
  });
});
