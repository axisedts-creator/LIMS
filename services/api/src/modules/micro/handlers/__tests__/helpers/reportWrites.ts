// C10 T-15 test helper — wraps the in-memory fake tx of isolateWrites.ts (-> cultureWrites.ts dialect) with the database rules M14 depends on (05-SCHEMA §8 report_versions, §5 immutability, §10 grants):
//   micro.report_versions INSERT: report_versions__culture_version__uq (23505), __version__ck, __phase__ck, __kind__ck, __submission__ck, __flag__ck, __lab_status__ck, __final_outcome__ck,
//     __amend__ck (version_kind = amendment needs amendment_reason_code), __json__ck (isolates array <= 20, ast array <= 600), __texts__ck (summary 1..4000, comments <= 4000, early_final_reason <= 500,
//     amendment_reason_text <= 500) -> 23514; a NOT NULL column that is missing -> 23502; a violating INSERT leaves the table unchanged.
//   micro.report_versions UPDATE / DELETE -> 42501 insufficient_privilege (no UPDATE/DELETE grant for lims_app: AC-09.5).
//   micro.ast_results / culture_observations / isolates / culture_plates writes on a final_submitted culture: delegated (isolates__final_lock, tg_child_final_lock).
// Everything else is delegated to isolateTx (dialect: first table only, no JOIN, equality predicates only; `<> / IS NULL / >=` predicates and `= true` literals are IGNORED, so the service must not rely on them
// alone for what goes into a snapshot - bind the value as $n or filter the rows in code).
// Synthetic data only.
import { isolateTx } from './isolateWrites.js';
import type { Row, World } from './cultureWrites.js';

export { NOW, HOUR, iso, writesOf, type Logged, type Row, type World } from './isolateWrites.js';

const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });
const same = (a: unknown, b: unknown) => String(a) === String(b);
/** jsonb columns arrive either as objects (driver serialises) or as JSON text: both read as the parsed value. */
export const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

const REQUIRED = ['id', 'tenant_id', 'centre_id', 'culture_id', 'order_item_id', 'version_no', 'report_phase', 'version_kind', 'submission_kind', 'culture_summary_text', 'isolates', 'ast', 'is_critical', 'flag',
  'signed_by_membership_id', 'signed_at', 'lab_result_id', 'lab_result_version_no', 'lab_status_at_submit', 'lab_replayed', 'created_by'];

export function reportTx(w: World) {
  const base = isolateTx(w);
  const tbl = (t: string): Row[] => (w[t] ??= []);

  function check(r: Row): void {
    for (const c of REQUIRED) if (r[c] === undefined || r[c] === null) throw pgErr('23502', `report_versions.${c} not null`);
    const iso_ = asJson(r['isolates']); const ast = asJson(r['ast']);
    if (!(r['version_no'] >= 1)) throw pgErr('23514', 'report_versions__version__ck');
    if (!['preliminary', 'final'].includes(r['report_phase'])) throw pgErr('23514', 'report_versions__phase__ck');
    if (!['initial', 'update', 'amendment'].includes(r['version_kind'])) throw pgErr('23514', 'report_versions__kind__ck');
    if (!['structured', 'organism', 'ast_panel'].includes(r['submission_kind'])) throw pgErr('23514', 'report_versions__submission__ck');
    if (!['N', 'A'].includes(r['flag'])) throw pgErr('23514', 'report_versions__flag__ck');
    if (!['pending', 'resulted', 'verified', 'approved', 'cancelled'].includes(r['lab_status_at_submit'])) throw pgErr('23514', 'report_versions__lab_status__ck');
    if (r['report_phase'] === 'final' && r['outcome_code'] == null) throw pgErr('23514', 'report_versions__final_outcome__ck');
    if (r['version_kind'] === 'amendment' && r['amendment_reason_code'] == null) throw pgErr('23514', 'report_versions__amend__ck');
    if (!(Array.isArray(iso_) && iso_.length <= 20 && Array.isArray(ast) && ast.length <= 600)) throw pgErr('23514', 'report_versions__json__ck');
    const len = (v: unknown) => String(v).length;
    if (!(len(r['culture_summary_text']) >= 1 && len(r['culture_summary_text']) <= 4000) || (r['comments_text'] != null && len(r['comments_text']) > 4000)
      || (r['early_final_reason'] != null && len(r['early_final_reason']) > 500) || (r['amendment_reason_text'] != null && len(r['amendment_reason_text']) > 500)) throw pgErr('23514', 'report_versions__texts__ck');
    if (tbl('report_versions').some((x) => same(x['tenant_id'], r['tenant_id']) && same(x['culture_id'], r['culture_id']) && x['version_no'] === r['version_no'])) throw pgErr('23505', 'report_versions__culture_version__uq');
  }

  const tx = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      const head = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase();
      const table = /\b(?:FROM|INTO|UPDATE)\s+(?:micro\.)?(\w+)/i.exec(sql)?.[1];
      if (table === 'report_versions' && (head === 'UPDATE' || head === 'DELETE')) {
        base.log.push({ sql, params, op: head === 'UPDATE' ? 'UPDATE' : 'OTHER', table });
        throw pgErr('42501', 'permission denied for table report_versions');
      }
      if (table === 'report_versions' && head === 'INSERT') {
        const snap = tbl('report_versions').map((r) => ({ ...r })); const ids = new Set(snap.map((r) => r['id']));
        const out = await base.tx.query(sql, params);
        try { for (const r of tbl('report_versions')) if (!ids.has(r['id'])) { const rest = tbl('report_versions'); w['report_versions'] = rest.filter((x) => x !== r); check(r); w['report_versions'] = rest; } }
        catch (e) { w['report_versions'] = snap; throw e; }
        return out;
      }
      return base.tx.query(sql, params);
    },
  };
  return { tx, log: base.log, world: w };
}
