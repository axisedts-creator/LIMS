// T-25 (C3) test fixture: ONE in-memory Postgres fake + JobContext for the worker tasks catalog.import_validate / catalog.import_commit of the kinds
// `catalog_master`, `referrers` and `credit_parties` (02-TRD §8.2, §8.3, §8.5, §8.6, §10). Same construction as commitDb.ts (T-23): several existing API fakes behind ONE
// transaction, statements routed by the FIRST `catalog.<table>` they name (commit/rollback hit every sub-fake, so "one transaction" is observable).
//   imports | files | import_issues                       -> T-22 validateDb
//   kind catalog_master:
//     g_/cs_ units, value sets, value set values          -> T-05 setsDb  (the only fake whose value-set tables are WRITABLE)
//     comment_codes, comment_code_texts                   -> T-13 commentsDb (its department FK target is MIRRORED from the masters view before each statement)
//     everything else in catalog.* (departments … methods, orderables, tests, panels, analytes, analyte_versions, reference/critical sets + bands,
//       tat_targets, formula_dependencies, catalog_state) + core.event_log + app.enqueue_job -> T-06 testsDb chain (this one owns catalog_state = the revision)
//   kind referrers      : doctors, code_counters + catalog_state/event_log                -> T-15 doctorsDb
//   kind credit_parties : credit_parties, code_counters + catalog_state/event_log         -> T-16 creditPartiesDb
// Known limits (documented, not hidden): the sub-fakes do not know each other's rows except the department mirror above; the SQL dialects are the fakes' (see their headers;
// anything else raises "fake: unsupported SQL" and the writer adapts the SQL). Statement-level fault injection and the imports row lock work as in commitDb.ts.
// JobContext: as T-23 makeCommitRunner (reused unchanged): ctx.tx commits when the handler resolves and ROLLS BACK when it throws; ctx.db.tx REUSES ctx.tx;
// ctx.events.publish is a recorder (see eventsOf in commitDb.ts). Synthetic data only.
import { ROOT_A, ROOT_B } from '../../../../../../api/src/modules/catalog/__tests__/helpers/catalogDb.js';
import { makeCreditPartiesDb } from '../../../../../../api/src/modules/catalog/__tests__/helpers/creditPartiesDb.js';
import { makeCommentsDb } from '../../../../../../api/src/modules/catalog/__tests__/helpers/commentsDb.js';
import { makeDoctorsDb } from '../../../../../../api/src/modules/catalog/__tests__/helpers/doctorsDb.js';
import { RowLock } from '../../../../../../api/src/modules/catalog/__tests__/helpers/mastersDb.js';
import { makeSetsDb } from '../../../../../../api/src/modules/catalog/__tests__/helpers/setsDb.js';
import { makeTestsDb } from '../../../../../../api/src/modules/catalog/__tests__/helpers/testsDb.js';
import { COMMITTER, eventsOf, makeCommitRunner } from './commitDb.js';
import { IMPORT_ID, NOW, TENANT_A, TENANT_B, UPLOAD_FILE_ID, USER, makeValidateDb, seedImport, uid } from './validateDb.js';

export { COMMITTER, IMPORT_ID, NOW, TENANT_A, TENANT_B, UPLOAD_FILE_ID, USER, eventsOf, uid };
export type Row = Record<string, any>;
export type Kind = 'catalog_master' | 'referrers' | 'credit_parties';

export interface KStmt { readonly txId: number; readonly main: boolean; readonly tenantId: string; readonly text: string; readonly values: readonly unknown[] }
const FILE_TABLES = new Set(['imports', 'files', 'import_issues']);
const SETS_TABLES = new Set(['g_units', 'g_value_sets', 'g_value_set_values', 'cs_units', 'cs_value_sets', 'cs_value_set_values']);
const COMMENT_TABLES = new Set(['comment_codes', 'comment_code_texts']);
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;
const MASTER_TABLES = ['departments', 'specimen_types', 'containers', 'methods'] as const;
const T6 = ['orderables', 'tests', 'panels', 'panel_members', 'test_specimen_types', 'analytes', 'analyte_versions', 'reference_range_sets', 'reference_ranges', 'critical_limit_sets',
  'critical_limits', 'formula_dependencies', 'tat_targets'] as const;
const SETS_ROWS = ['cs_units', 'cs_value_sets', 'cs_value_set_values'] as const;
const COMMENT_ROWS = ['comment_codes', 'comment_code_texts'] as const;

export function makeKindsDb(kind: Kind) {
  const catalog = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 10 }, [TENANT_B]: { rootId: ROOT_B, revision: 20 } } };
  const v = makeValidateDb();
  const tests: any = kind === 'catalog_master' ? makeTestsDb({ catalog }) : undefined;
  const sets: any = kind === 'catalog_master' ? makeSetsDb({ catalog }) : undefined;
  const comments: any = kind === 'catalog_master' ? makeCommentsDb({ catalog }) : undefined;
  const doctors: any = kind === 'referrers' ? makeDoctorsDb({ catalog }) : undefined;
  const parties: any = kind === 'credit_parties' ? makeCreditPartiesDb({ catalog }) : undefined;
  const main: any = tests ?? doctors ?? parties;
  const stmts: KStmt[] = [];
  const crash = { at: 0, beforeCommit: false };
  let nextTx = 1;
  const at = new Date(NOW);
  const importLocks = new Map<string, RowLock>();
  const importLock = (tenantId: string) => { let l = importLocks.get(tenantId); if (!l) importLocks.set(tenantId, (l = new RowLock())); return l; };

  function begin(tenantId: string, isMain: boolean, actorId = USER) {
    const id = nextTx++;
    const m = main.begin(tenantId, actorId, at);
    const t = v.begin(tenantId);
    const s = sets?.begin(tenantId, actorId);
    const c = comments?.begin(tenantId, actorId, at);
    const subs = [m, s, c].filter(Boolean);
    let writes = 0, open = true, holds = false;
    const release = () => { if (holds) importLock(tenantId).release(id); holds = false; };
    const mirrorDepartments = async () => {
      const { rows } = await m.facade.query('SELECT * FROM catalog.departments WHERE tenant_id = $1', [tenantId]);
      comments.masters.mirror('departments', rows);
    };
    const facade: any = {
      ...m.facade,
      async query(text: string, values: unknown[] = []) {
        if (!open) throw new Error('fake: tx closed');
        stmts.push({ txId: id, main: isMain, tenantId, text, values });
        if (IS_WRITE.test(text) && isMain && crash.at > 0 && ++writes === crash.at) throw new Error('simulated crash: worker killed');
        const table = /\bcatalog\.(\w+)/i.exec(text)?.[1]?.toLowerCase();
        if (table === 'imports' && (/\bFOR UPDATE\b/i.test(text) || /^\s*UPDATE\b/i.test(text))) { await importLock(tenantId).acquire(id); holds = true; }
        if (table && FILE_TABLES.has(table)) return t.query(text, values);
        if (table && sets && SETS_TABLES.has(table)) return s.facade.query(text, values);
        if (table && comments && COMMENT_TABLES.has(table)) { await mirrorDepartments(); return c.facade.query(text, values); }
        return m.facade.query(text, values);
      },
      savepoint: async <T>(fn: (x: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id, tenantId, facade,
      commit() {
        if (!open) return; open = false;
        if (isMain && crash.beforeCommit) { for (const x of subs) x.rollback(); t.rollback(); release(); throw new Error('simulated crash: killed before COMMIT'); }
        for (const x of subs) x.commit();
        t.commit(); release();
      },
      rollback() { if (!open) return; open = false; for (const x of subs) x.rollback(); t.rollback(); release(); },
    };
  }

  const rowsOf = (fake: any, names: readonly string[], tenantId: string) => Object.fromEntries(names.map((n) => [n, fake.rows(n, tenantId)]));
  /** Deep, comparable copy of every committed table a commit may touch (+ revision). */
  const snapshot = (tenantId = TENANT_A) => JSON.parse(JSON.stringify({
    imports: v.rows('imports', tenantId), files: v.rows('files', tenantId), import_issues: v.rows('import_issues', tenantId),
    ...(tests ? { masters: Object.fromEntries(MASTER_TABLES.map((n) => [n, tests.masters.rows(n, tenantId)])), t6: rowsOf(tests, T6, tenantId), sets: rowsOf(sets, SETS_ROWS, tenantId), comments: rowsOf(comments, COMMENT_ROWS, tenantId) } : {}),
    ...(doctors ? { doctors: rowsOf(doctors, ['doctors', 'code_counters'], tenantId) } : {}),
    ...(parties ? { parties: rowsOf(parties, ['credit_parties', 'code_counters'], tenantId) } : {}),
    revision: main.revisionOf(tenantId),
  }));

  return {
    kind, v, tests, sets, comments, doctors, parties, main, begin, stmts, snapshot,
    crashAtWrite(n: number) { crash.at = n; crash.beforeCommit = false; },
    crashBeforeCommit() { crash.at = 0; crash.beforeCommit = true; },
    noCrash() { crash.at = 0; crash.beforeCommit = false; },
    revision: (tenantId = TENANT_A) => main.revisionOf(tenantId) as number,
    imp: (id = IMPORT_ID, tenantId = TENANT_A): Row => v.rows('imports', tenantId).find((r) => r.id === id) as Row,
    issues: (id = IMPORT_ID, tenantId = TENANT_A): Row[] => v.rows('import_issues', tenantId).filter((r) => r.import_id === id).sort((a, b) => a.seq - b.seq),
    writes: () => stmts.filter((x) => IS_WRITE.test(x.text)),
    // ---- committed-state readers (tenant A by default)
    master: (t: (typeof MASTER_TABLES)[number], tenantId = TENANT_A): Row[] => tests.masters.rows(t, tenantId),
    t6: (t: (typeof T6)[number], tenantId = TENANT_A): Row[] => tests.rows(t, tenantId),
    cs: (t: (typeof SETS_ROWS)[number], tenantId = TENANT_A): Row[] => sets.rows(t, tenantId),
    cmt: (t: (typeof COMMENT_ROWS)[number], tenantId = TENANT_A): Row[] => comments.rows(t, tenantId),
    doctorRows: (tenantId = TENANT_A): Row[] => doctors.rows('doctors', tenantId),
    partyRows: (tenantId = TENANT_A): Row[] => parties.rows('credit_parties', tenantId),
    /** counts of every committed domain row (for "nothing written" / "no new rows" assertions) */
    domainCounts: (tenantId = TENANT_A): Record<string, number> => {
      const o: Record<string, number> = {};
      const s = snapshot(tenantId);
      for (const grp of ['masters', 't6', 'sets', 'comments', 'doctors', 'parties']) for (const [k, rows] of Object.entries((s as any)[grp] ?? {})) o[`${grp}.${k}`] = (rows as unknown[]).length;
      return o;
    },
  };
}
export type KindsDb = ReturnType<typeof makeKindsDb>;

/** An `uploaded` import of `kind` + its upload file; status override for committing/validated seeds. Commit parameters are what the API stored (as seedCommitting in commitDb.ts). */
export function seedKindImport(db: KindsDb, bytes: Uint8Array, o: {
  tenantId?: string; importId?: string; fileId?: string; status?: string; reason?: string | null; effectiveFrom?: string | null; committedBy?: string | null; fileName?: string;
} = {}) {
  const tenantId = o.tenantId ?? TENANT_A;
  const { importId } = seedImport(db.v, tenantId, bytes, { importId: o.importId, fileId: o.fileId, status: o.status ?? 'uploaded', fileName: o.fileName ?? `${db.kind}.xlsx` });
  const row = db.v.committed['imports']!.find((r) => r.id === importId && r.tenant_id === tenantId)!;
  Object.assign(row, { kind: db.kind, target_price_list_id: null });
  if ((o.status ?? 'uploaded') !== 'uploaded') commitParams(db, importId, o);
  return { importId, tenantId };
}

/** What the API's commitImport stores before it enqueues the job (status -> committing). */
export function commitParams(db: KindsDb, importId = IMPORT_ID, o: { tenantId?: string; reason?: string | null; effectiveFrom?: string | null; committedBy?: string | null; status?: string } = {}) {
  const row = db.v.committed['imports']!.find((r) => r.id === importId && r.tenant_id === (o.tenantId ?? TENANT_A))!;
  Object.assign(row, {
    status: o.status ?? 'committing',
    commit_effective_from: o.effectiveFrom === null ? null : new Date(o.effectiveFrom ?? '2026-11-10T00:00:00.000Z'),
    commit_change_reason: o.reason === null ? null : (o.reason ?? 'Synthetic catalog import'),
    commit_publish: true, commit_accept_stale_base: false,
    committed_by: o.committedBy === undefined ? COMMITTER : o.committedBy,
    expires_at: new Date(Date.parse(NOW) + 168 * 3600_000), version: (row.version ?? 1) + 1,
  });
}

/** Runner = T-23 makeCommitRunner (ctx.tx = the composite transaction). */
export const makeKindsRunner = (db: KindsDb, handler: (payload: any, ctx: any) => Promise<void>, o: Parameters<typeof makeCommitRunner>[2] = {}) => makeCommitRunner(db as never, handler, o);
