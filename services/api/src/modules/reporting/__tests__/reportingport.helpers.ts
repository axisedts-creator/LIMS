// C6-T21 test helpers (not a test file). Synthetic data only.
// makeReportingWorld(): a ContractHarness (packages/fakes/src/harness.ts) around the REAL `createReportingPort({ env })` from ports/ReportingPort.impl.ts.
//   - db: the C6-T20 in-memory Postgres fake (portal.helpers.ts makePortalDb) for reporting.{reports,report_versions,qr_tokens,portal_links,...},
//     wrapped per transaction with the three things the T20 fake does not model (SQL is still modelled BY CONTENT; no joins / OR / sub-selects):
//       (a) row-value keyset comparison   `(released_at, id) < ($3, $4)`   (also > <= >=)  -> applied after the statement, so ORDER BY still decides order;
//       (b) `col = ANY($n[::uuid[]])`                                                       -> applied after the statement;
//       (c) LIMIT is applied LAST (after (a)/(b)/RLS), so "ORDER BY .. LIMIT n+1" works with keyset terms.
//     RLS is modelled for PARTNER actors only (05-SCHEMA §4 `__partner`): reports.partner_id = app.current_partner_id(); report_versions.partner_id =
//     current partner AND status IN ('released','superseded'); qr_tokens only of such versions; every other reporting table -> no rows (default deny).
//     The partner id of an actor comes from fixtures.partnerOfActor (the C0 contract fixture), exactly like the C0 fake. Tenant isolation is NOT
//     modelled: a statement without `tenant_id = $n` sees every tenant (so a missing tenant predicate in the impl is caught).
//   - fixtures (ReportingFixtures): reports[] = { id(version id), tenantId, reportId, versionNo, orderId, patientId, partnerId, centreId, kind, status:
//     'valid'|'superseded', released, releasedAt, panelNames } + OWN extensions `dbStatus` (raw report_versions.status override, e.g. 'rendered') and
//     `smart` (true => smart_summary_json/_id/_version all set). released=false => DB status 'rendered' (never listed). Translated to reporting.reports
//     (released_version_no = highest released/valid version, NULL when none), report_versions (partner_id/patient_id copies, report_kind) and
//     qr_tokens.panel_names_snapshot (one per released/superseded version).
//   - ctx: { tenantId, actor, tx (db tx tagged with the actor), now, ports.IdentityPort.getTenantSettings -> { reportLinkTtlDays } }.
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness.js';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy.js';
import { TENANTS } from '../../../../../../packages/fakes/src/base.js';
import { makePortalDb, PORTAL_ORIGIN, CENTRE_A, BRANCH_A, NOW, TENANT_A, TENANT_B, idN, type Row } from './portal.helpers.js';

export { PORTAL_ORIGIN, NOW, TENANT_A, TENANT_B, idN };
export type { Row };
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

const TUPLE = /\(\s*(?:\w+\.)?(\w+)\s*,\s*(?:\w+\.)?(\w+)\s*\)\s*(<=|>=|<|>)\s*\(\s*\$(\d+)(?:::\w+)?\s*,\s*\$(\d+)(?:::\w+)?\s*\)/gi;
const ANY = /(?:\w+\.)?(\w+)\s*=\s*ANY\s*\(\s*\$(\d+)(?:::\w+(?:\[\])?)?\s*\)/gi;
const LIMIT = /\blimit\s+(?:\$(\d+)|(\d+))\b/i;
const VISIBLE = ['released', 'superseded'];

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v);
const cmp = (a: any, b: any): number => {
  a = iso(a); b = iso(b);
  const t = (s: any) => (typeof s === 'string' && /^\d{4}-\d\d-\d\dT/.test(s) ? Date.parse(s) : undefined);
  const x = t(a), y = t(b);
  if (x !== undefined && y !== undefined) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
};

export interface SqlRecord { readonly text: string; readonly values: readonly unknown[] }

/** The wrapped fake database (exported for the self-check test). */
export function makeReportingDb(nowIso: () => string, partnerOfActor: () => Record<string, string>) {
  const db = makePortalDb(nowIso);
  const reads: SqlRecord[] = [];                  // ORIGINAL statement texts, in call order (the inner fake sees rewritten text)

  function visible(table: string, r: Row, actor: { type: string; id: string }): boolean {
    if (actor.type !== 'partner') return true;
    const pid = partnerOfActor()[actor.id];
    if (!pid) return false;
    if (table === 'reports') return r['partner_id'] === pid;
    if (table === 'report_versions') return r['partner_id'] === pid && VISIBLE.includes(r['status']);
    if (table === 'qr_tokens') { const v = db.store['report_versions']!.find((x) => x['id'] === r['report_version_id']); return !!v && v['partner_id'] === pid && VISIBLE.includes(v['status']); }
    return false;
  }

  function newTx(actor: { type: string; id: string }) {
    const tx: any = db.newTx();
    const inner = tx.query as (t: string, v?: unknown[]) => Promise<{ rows: Row[] }>;
    tx.__actor = actor;
    tx.query = async (text: string, values: unknown[] = []) => {
      reads.push({ text, values: [...values] });
      if (!/^\s*select/i.test(text) || /\bapp\./i.test(text)) return inner(text, values);
      const post: Array<(r: Row) => boolean> = [];
      let t = text.replace(TUPLE, (_m, c1: string, c2: string, op: string, p1: string, p2: string) => {
        const a = values[Number(p1) - 1], b = values[Number(p2) - 1];
        post.push((r) => { if (r[c1] == null || r[c2] == null) return false; /* SQL: NULL comparison is not true */ const d = cmp(r[c1], a) || cmp(r[c2], b); return op === '<' ? d < 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : d >= 0; });
        return 'true';
      });
      t = t.replace(ANY, (_m, c: string, p: string) => { const set = values[Number(p) - 1] as unknown[]; post.push((r) => Array.isArray(set) && set.includes(r[c])); return 'true'; });
      const lm = LIMIT.exec(t); const limit = lm ? Number(lm[1] ? values[Number(lm[1]) - 1] : lm[2]) : undefined;
      if (lm) t = t.replace(LIMIT, '');
      const table = /\bfrom\s+reporting\.(\w+)/i.exec(t)?.[1] ?? '';
      let rows = (await inner(t, values)).rows.filter((r) => post.every((f) => f(r)) && visible(table, r, actor));
      if (limit !== undefined) rows = rows.slice(0, limit);
      return { rows };
    };
    return tx;
  }
  return { db, newTx, reads, endTx: db.endTx };
}

const DAY = 86_400_000;

export async function makeReportingWorld(opts: { env?: Record<string, string | undefined> } = {}) {
  const clock = { t: Date.parse(NOW) };
  const now = () => new Date(clock.t).toISOString();
  let partnerOfActor: Record<string, string> = {};
  let linkTtlDays: Record<string, number> = {};
  const w = makeReportingDb(now, () => partnerOfActor);
  const { db } = w;

  const spec = '../ports/ReportingPort.impl.js';                    // variable specifier: a missing impl fails the test, not the module graph
  const mod: any = await import(/* @vite-ignore */ spec);
  if (typeof mod.createReportingPort !== 'function') throw new Error('ports/ReportingPort.impl.ts must export createReportingPort({ env })');
  const env = { ...process.env, LIMS_ORIGIN_PORTAL: PORTAL_ORIGIN, ...opts.env };
  const impl = mod.createReportingPort({ env });

  const identity = { async getTenantSettings(ctx: any, _input: unknown) { return { reportLinkTtlDays: linkTtlDays[ctx.tenantId] ?? 45 }; } };
  const signed: Array<{ bucket: string; path: string; ttl: number }> = [];
  const storage = { async signedUrl(bucket: string, path: string, ttl: number) { signed.push({ bucket, path, ttl }); return `https://storage.invalid/${bucket}/${path}?ttl=${ttl}`; } };   // core/storage StorageAdapter.signedUrl
  const events = createEventSpy();
  const baseCtx = makeCtxFor();

  async function seed(fixtures: any) {
    if (fixtures.linkTtlDays) linkTtlDays = { ...linkTtlDays, ...fixtures.linkTtlDays };
    if (fixtures.partnerOfActor) partnerOfActor = { ...partnerOfActor, ...fixtures.partnerOfActor };
    const rows: Row[] = fixtures.reports ?? [];
    const byReport = new Map<string, Row[]>();
    for (const r of rows) { const k = `${r['tenantId']}/${r['reportId']}`; (byReport.get(k) ?? byReport.set(k, []).get(k)!).push(r); }
    for (const [, vs] of byReport) {
      const first = vs[0]!;
      const releasedNos = vs.filter((v) => v['released'] && v['status'] === 'valid' && !v['dbStatus']).map((v) => v['versionNo'] as number);
      if (!db.store['reports']!.some((x) => x['id'] === first['reportId'])) {
        db.insert('reports', { id: first['reportId'], tenant_id: first['tenantId'], centre_id: first['centreId'] ?? CENTRE_A, branch_id: BRANCH_A, order_id: first['orderId'],
          patient_id: first['patientId'], partner_id: first['partnerId'] ?? null, latest_version_no: Math.max(...vs.map((v) => v['versionNo'])),
          released_version_no: releasedNos.length ? Math.max(...releasedNos) : null, patient_display_name: 'T*** P*** 0001', registration_no: '0001SY000001' });
      }
      for (const v of vs) {
        const dbStatus = v['dbStatus'] ?? (!v['released'] ? 'rendered' : v['status'] === 'superseded' ? 'superseded' : 'released');
        const smart = v['smart'] ? { smart_summary_json: { sections: ['synthetic'] }, smart_summary_id: idN(0xa00 + (v['versionNo'] as number)), smart_summary_version: 'v1' } : {};
        db.insert('report_versions', { id: v['id'], tenant_id: v['tenantId'], centre_id: v['centreId'] ?? CENTRE_A, report_id: v['reportId'], order_id: v['orderId'], patient_id: v['patientId'],
          partner_id: v['partnerId'] ?? null, version_no: v['versionNo'], status: dbStatus, report_kind: v['kind'], released_at: v['releasedAt'] ?? null, reported_at: v['releasedAt'] ?? now(),
          pdf_object_path: `${v['tenantId']}/reports/${v['reportId']}/v${v['versionNo']}.pdf`, pdf_sha256: 'a'.repeat(64), pdf_bytes: 10, ...smart });
        if (VISIBLE.includes(dbStatus)) db.insert('qr_tokens', { tenant_id: v['tenantId'], report_id: v['reportId'], report_version_id: v['id'], lab_name_snapshot: 'Test Lab 0001',
          patient_display_snapshot: 'T*** P*** 0001', issued_at: v['releasedAt'] ?? now(), panel_names_snapshot: v['panelNames'] ?? [] });
      }
    }
  }

  const harness: ContractHarness & { db: typeof db; reads: SqlRecord[]; advance(ms: number): void } = {
    impl, events, db, reads: w.reads,
    advance: (ms) => { clock.t += ms; },
    seed,
    ctxFor(actorKey, over) {
      const ctx: any = baseCtx(actorKey, over);
      ctx.tx = over?.tx ?? w.newTx(ctx.actor);
      ctx.ports = { IdentityPort: identity, ...(over?.ports as object | undefined) };
      ctx.storage = over?.storage ?? storage;
      if (!over?.now) ctx.now = now;
      return ctx;
    },
    rollback(tx) { w.endTx(tx, true); events.rollback(tx); },
  };
  return { harness, db, reads: w.reads, signed, now, advance: harness.advance, TENANTS };
}

// ------------------------------------------------------------------------------------------------ fixture builders for the own tests
export const id = (n: number) => `0190d600-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const PAT = id(1), PAT2 = id(2), P1 = id(5), P2 = id(6), CENTRE_X = id(7);
export const isoDay = (d: number, h = 4) => new Date(Date.UTC(2026, 9, d, h, 15)).toISOString();
export const ver = (tenantId: string, o: Row): Row => ({ tenantId, versionNo: 1, patientId: PAT, partnerId: null, centreId: null, kind: 'final', status: 'valid', released: true,
  panelNames: ['Synthetic Panel'], ...o });
export { DAY };
