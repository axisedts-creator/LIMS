// T-23 (C3) test fixture: ONE in-memory Postgres fake + JobContext for the worker task catalog.import_commit (02-TRD §8.5, §10).
// It composes two existing fakes behind a single transaction (commit/rollback hit both, so "one transaction" is observable):
//   - API pricingDb (price_lists, price_list_versions, price_list_items, orderables[read-only], catalog_state, app.enqueue_job): the REAL price-list
//     constraints and triggers (published-fields CHECK, draft-only items, supersede rules, partial UNIQUE one-draft-per-list), lock-then-re-evaluate, RLS.
//   - T-22 validateDb (catalog.imports / files / import_issues).
// Statements are routed by table: catalog.imports|files|import_issues -> validateDb, everything else -> pricingDb. The SQL dialects are the two fakes' (documented
// in their headers); the writer adapts the SQL. Anything else raises "fake: unsupported SQL".
// JobContext (as T-22 makeRunner): ctx.tx commits when the handler resolves and ROLLS BACK when it throws; ctx.db.tx(fn) REUSES ctx.tx (as the real
// worker consumer does, unlike the T-22 fake). Fault injection: crashAtWrite(n) makes the n-th INSERT/UPDATE/DELETE of the MAIN transaction throw (a killed worker: Postgres
// rolls the transaction back), crashBeforeCommit() makes the main COMMIT throw (killed between the last write and COMMIT).
// ctx.events.publish is a recorder (any signature; see eventsOf). Synthetic data only.
import { ROOT_A, ROOT_B } from '../../../../../../api/src/modules/catalog/__tests__/helpers/catalogDb.js';
import { RowLock } from '../../../../../../api/src/modules/catalog/__tests__/helpers/mastersDb.js';
import { makePricingDb, orderable, plist, pitem, pver } from '../../../../../../api/src/modules/catalog/__tests__/helpers/pricingDb.js';
import { IMPORT_ID, NOW, PRICE_LIST_ID, SYS, TENANT_A, TENANT_B, UPLOAD_FILE_ID, USER, makeLog, makeValidateDb, seedImport, sha256, uid } from './validateDb.js';

export { IMPORT_ID, NOW, PRICE_LIST_ID, SYS, TENANT_A, TENANT_B, UPLOAD_FILE_ID, USER, uid };
export const COMMITTER = '0190a000-0000-7000-8000-00000000a0c1';     // the user who pressed "commit" (imports.committed_by)
export type Row = Record<string, any>;

export interface CStmt { readonly txId: number; readonly main: boolean; readonly tenantId: string; readonly text: string; readonly values: readonly unknown[] }
const FILE_TABLES = /\bcatalog\.(imports|files|import_issues)\b/i;
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

// ---------------------------------------------------------------------------------------------------------- synthetic world
/** Orderables CBC/LFT/TSH/HBA1C (tenant A), CBC (tenant B). */
export const ORD = {
  CBC: orderable(1, TENANT_A, { code: 'CBC', name: 'Synthetic CBC' }),
  LFT: orderable(2, TENANT_A, { code: 'LFT', name: 'Synthetic LFT' }),
  TSH: orderable(3, TENANT_A, { code: 'TSH', name: 'Synthetic TSH' }),
  HBA1C: orderable(4, TENANT_A, { code: 'HBA1C', name: 'Synthetic HbA1c' }),
  CBC_B: orderable(5, TENANT_B, { code: 'CBC', name: 'Synthetic CBC (B)' }),
};
export const VER3_ID = uid(3003);
export const VER4_ID = uid(3004);
export const DRAFT_ID = uid(3010);

export interface WorldOpts {
  /** published versions of the list: v3 (default) and optionally a later v4 */
  v4?: boolean;
  /** an open manual draft (version_no 4, or 5 when v4) holding item `X` = 777.00 NPR */
  draft?: boolean;
  /** orderable codes removed from the catalog after validation (AC: re-validation) */
  drop?: Array<keyof typeof ORD>;
}
/** v3 published (CBC 1000.00, LFT 2000.00, TSH 3000.00 NPR); optional v4 / open draft. */
export function worldRows(o: WorldOpts = {}) {
  const dropped = new Set((o.drop ?? []).map((k) => ORD[k].id));
  const lists = [plist(1, TENANT_A, { id: PRICE_LIST_ID, code: 'RETAIL', owner_kind: 'default', name: 'Retail (synthetic)' })];
  const draftNo = o.v4 ? 5 : 4;
  const versions = [
    pver(3, TENANT_A, PRICE_LIST_ID, 3, { id: VER3_ID, status: o.v4 ? 'superseded' : 'published', ...(o.v4 ? { effective_to: new Date('2026-10-01T00:00:00Z') } : {}) }),
    ...(o.v4 ? [pver(4, TENANT_A, PRICE_LIST_ID, 4, { id: VER4_ID, status: 'published', effective_from: new Date('2026-10-01T00:00:00Z') })] : []),
    ...(o.draft ? [pver(10, TENANT_A, PRICE_LIST_ID, draftNo, { id: DRAFT_ID, status: 'draft', item_count: 1 })] : []),
  ];
  const items = [
    pitem(1, TENANT_A, o.v4 ? VER4_ID : VER3_ID, ORD.CBC.id, 100000), pitem(2, TENANT_A, o.v4 ? VER4_ID : VER3_ID, ORD.LFT.id, 200000), pitem(3, TENANT_A, o.v4 ? VER4_ID : VER3_ID, ORD.TSH.id, 300000),
    ...(o.draft ? [pitem(9, TENANT_A, DRAFT_ID, ORD.HBA1C.id, 77700)] : []),
  ];
  const orderables = Object.values(ORD).filter((x) => !dropped.has(x.id));
  return { price_lists: lists, price_list_versions: versions, price_list_items: items, orderables };
}

// ---------------------------------------------------------------------------------------------------------------- composite
export function makeCommitDb(o: WorldOpts = {}) {
  const pricing = makePricingDb({ catalog: { state: { [TENANT_A]: { rootId: ROOT_A, revision: 10 }, [TENANT_B]: { rootId: ROOT_B, revision: 20 } } }, rows: worldRows(o) });
  const v = makeValidateDb();
  const stmts: CStmt[] = [];
  const crash = { at: 0, beforeCommit: false };
  let nextTx = 1;
  const at = new Date(NOW);

  // The imports row lock (SELECT … FROM catalog.imports … FOR UPDATE, and every UPDATE of it) is held until COMMIT/ROLLBACK; others queue and, as in
  // Postgres READ COMMITTED, the statement then runs against the latest committed state (validateDb itself has no locks).
  const importLocks = new Map<string, RowLock>();
  const importLock = (tenantId: string) => { let l = importLocks.get(tenantId); if (!l) importLocks.set(tenantId, (l = new RowLock())); return l; };

  function begin(tenantId: string, main: boolean, actorId = USER) {
    const id = nextTx++;
    const p = pricing.begin(tenantId, actorId, at);
    const t = v.begin(tenantId);
    let writes = 0;
    let open = true;
    let holds = false;
    const release = () => { if (holds) importLock(tenantId).release(id); holds = false; };
    const facade: any = {
      ...p.facade,
      async query(text: string, values: unknown[] = []) {
        if (!open) throw new Error('fake: tx closed');
        stmts.push({ txId: id, main, tenantId, text, values });
        if (IS_WRITE.test(text) && main && crash.at > 0 && ++writes === crash.at) throw new Error('simulated crash: worker killed');
        if (/\bcatalog\.imports\b/i.test(text) && (/\bFOR UPDATE\b/i.test(text) || /^\s*UPDATE\b/i.test(text))) { await importLock(tenantId).acquire(id); holds = true; }
        return FILE_TABLES.test(text) ? t.query(text, values) : p.facade.query(text, values);
      },
      savepoint: async <T>(fn: (x: unknown) => Promise<T>) => fn(facade),
    };
    return {
      id, tenantId, facade,
      commit() {
        if (!open) return; open = false;
        if (main && crash.beforeCommit) { p.rollback(); t.rollback(); release(); throw new Error('simulated crash: killed before COMMIT'); }
        p.commit(); t.commit(); release();
      },
      rollback() { if (!open) return; open = false; p.rollback(); t.rollback(); release(); },
    };
  }

  /** Deep, comparable copy of every committed table the commit may touch + the tenant's catalog revision. */
  const snapshot = (tenantId = TENANT_A) => JSON.parse(JSON.stringify({
    imports: v.rows('imports', tenantId), files: v.rows('files', tenantId), import_issues: v.rows('import_issues', tenantId),
    price_lists: pricing.rows('price_lists', tenantId), price_list_versions: pricing.rows('price_list_versions', tenantId), price_list_items: pricing.rows('price_list_items', tenantId),
    revision: pricing.revisionOf(tenantId),
  }));

  return {
    pricing, v, begin, stmts, snapshot,
    /** The n-th write of the main transaction throws; 0 = off. */
    crashAtWrite(n: number) { crash.at = n; crash.beforeCommit = false; },
    crashBeforeCommit() { crash.at = 0; crash.beforeCommit = true; },
    noCrash() { crash.at = 0; crash.beforeCommit = false; },
    revision: (tenantId = TENANT_A) => pricing.revisionOf(tenantId) as number,
    imp: (id = IMPORT_ID, tenantId = TENANT_A): Row => v.rows('imports', tenantId).find((r) => r.id === id) as Row,
    issues: (id = IMPORT_ID, tenantId = TENANT_A): Row[] => v.rows('import_issues', tenantId).filter((r) => r.import_id === id).sort((a, b) => a.seq - b.seq),
    versions: (tenantId = TENANT_A): Row[] => pricing.rows('price_list_versions', tenantId).sort((a, b) => a.version_no - b.version_no),
    items: (versionId: string, tenantId = TENANT_A): Row[] => pricing.rows('price_list_items', tenantId).filter((r) => r.price_list_version_id === versionId),
    /** code -> paise for a version's items */
    priceMap: (versionId: string, tenantId = TENANT_A): Record<string, number> => {
      const byId = new Map(Object.values(ORD).map((x) => [x.id, x.code]));
      return Object.fromEntries(pricing.rows('price_list_items', tenantId).filter((r) => r.price_list_version_id === versionId).map((r) => [byId.get(r.orderable_id) ?? r.orderable_id, Number(r.unit_price_paisa)]));
    },
    /** statements of the main transaction(s) that wrote anything (INSERT/UPDATE/DELETE) */
    writes: () => stmts.filter((s) => IS_WRITE.test(s.text)),
  };
}
export type CommitDb = ReturnType<typeof makeCommitDb>;

/** A `committing` price_list import + its upload file (the sheet bytes), with the commit parameters the API stored. */
export function seedCommitting(db: CommitDb, bytes: Uint8Array, o: {
  tenantId?: string; importId?: string; status?: string; baseVersionNo?: number | null;
  effectiveFrom?: string | null; reason?: string | null; publish?: boolean; acceptStaleBase?: boolean; committedBy?: string | null;
  warnings?: number;
} = {}) {
  const tenantId = o.tenantId ?? TENANT_A;
  const { importId } = seedImport(db.v, tenantId, bytes, { importId: o.importId, status: o.status ?? 'committing' });
  const row = db.v.committed['imports']!.find((r) => r.id === importId && r.tenant_id === tenantId)!;
  Object.assign(row, {
    base_version_no: o.baseVersionNo === undefined ? 3 : o.baseVersionNo,
    commit_effective_from: o.effectiveFrom === null ? null : new Date(o.effectiveFrom ?? '2026-11-10T00:00:00.000Z'),
    commit_change_reason: o.reason === null ? null : (o.reason ?? 'Synthetic tariff revision'),
    commit_publish: o.publish ?? true, commit_accept_stale_base: o.acceptStaleBase ?? false,
    committed_by: o.committedBy === undefined ? COMMITTER : o.committedBy,
    validated_at: new Date(NOW), expires_at: new Date(Date.parse(NOW) + 168 * 3600_000),
    summary: { rows: 3, added: 1, changed: 1, removed: 1, unchanged: 1, errors: 0, warnings: o.warnings ?? 0 }, error_count: 0, warning_count: o.warnings ?? 0, version: 5,
  });
  for (let i = 1; i <= (o.warnings ?? 0); i++) {
    db.v.seed('import_issues', { tenant_id: tenantId, import_id: importId, seq: i, severity: 'warning', sheet: 'Prices', row_no: 1 + i, column_key: 'unit_price_npr', issue_code: 'row.price_change_large',
      message: 'The price changes by more than the warning threshold.', created_at: new Date(NOW), created_by: USER, expires_at: new Date(Date.parse(NOW) + 30 * 86400_000) });
  }
  return { importId, tenantId };
}

// ------------------------------------------------------------------------------------------------------------------ runner
export interface RunOpts { tenantId?: string; attempt?: number; maxAttempts?: number; now?: string }
/** Runs `handler(payload, ctx)` the way the worker core does. Rejects when the handler throws (after rolling back ctx.tx). */
export function makeCommitRunner(db: CommitDb, handler: (payload: any, ctx: any) => Promise<void>, o: RunOpts = {}) {
  const tenantId = o.tenantId ?? TENANT_A;
  const events: unknown[][] = [];
  const metrics: Array<{ kind: string; name: string; labels: any }> = [];
  const l = makeLog();
  const build = (tx: any, attempt: number, maxAttempts: number): any => {
    const ctx: any = {
      tenantId, actor: { type: 'system', id: SYS }, requestId: uid(9100), tx: tx.facade, attempt, maxAttempts, jobId: '2', now: () => o.now ?? NOW, isNewer: () => true,
      events: { publish: async (...a: unknown[]) => { events.push(a); return { eventId: uid(9200 + events.length), duplicate: false }; } },
      core: {}, storage: {}, audit: {}, log: l.log,
      metrics: { inc: (name: string, labels: any = {}) => { metrics.push({ kind: 'inc', name, labels }); }, set() {}, observe() {} },
      files: { scan: async () => 'clean' },
    };
    // As the real worker (consumer.ts:58, see C3.T-22-impl.md): ctx.db.tx(fn) REUSES the job transaction, so its writes roll back with it. A task must not rely on an independent commit.
    ctx.db = { tx: async (fn: (c: any) => Promise<unknown>) => fn({ ...ctx }) };
    return ctx;
  };
  return {
    events, metrics, log: l,
    async run(payload: any, attempt = o.attempt ?? 1, maxAttempts = o.maxAttempts ?? 3) {
      const tx = db.begin(tenantId, true);
      try { await handler(payload, build(tx, attempt, maxAttempts)); tx.commit(); } catch (e) { tx.rollback(); throw e; }
    },
  };
}

/** catalog.changed.v1 publishes, whatever the publish() signature: finds the type string and the input object that follows it. */
export function eventsOf(calls: unknown[][], type = 'catalog.changed.v1'): Array<{ input: any; payload: any }> {
  const out: Array<{ input: any; payload: any }> = [];
  for (const a of calls) {
    const i = a.findIndex((x) => x === type);
    if (i < 0) continue;
    const input = a.slice(i + 1).find((x) => typeof x === 'object' && x !== null) as any;
    out.push({ input, payload: input?.payload ?? input });
  }
  return out;
}
export { sha256 };
