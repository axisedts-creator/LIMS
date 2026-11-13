// C10 T-16 test helper — wraps reportTx (T-15: report_versions rules, immutability) with the database rules M17 / M18 depend on (05-SCHEMA §8):
//   micro.cultures UPDATE: cultures__amend__ck (status amending needs amendment_reason_code), cultures__cancel__ck ((status = cancelled) = (cancel_reason_code AND cancelled_at set)),
//     cultures__texts__ck (cancel_comment / amendment_reason_text <= 500), cultures__final__ck (final_submitted / amending need outcome_code) -> 23514; the violating UPDATE leaves the table unchanged.
//   micro.instrument_records UPDATE: instrument_records__status__ck, __ignored__ck, __expires__ck, __match_reason__ (^[a-z_]{2,40}$) -> 23514; unchanged on violation.
// Everything else is delegated (dialect limits as in cultureWrites.ts: first table only, equality predicates only; IN / <> / IS NULL predicates are IGNORED, so the service must bind
// statuses as `= ANY($n)` or filter rows in code).
// Synthetic data only.
import { reportTx } from './reportWrites.js';
import type { Row, World } from './cultureWrites.js';

const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });
const len = (v: unknown) => String(v).length;

export function reopenCancelTx(w: World) {
  const base = reportTx(w);
  const tx = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      const head = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase();
      const table = /\b(?:FROM|INTO|UPDATE)\s+(?:micro\.)?(\w+)/i.exec(sql)?.[1];
      if (head !== 'UPDATE' || (table !== 'cultures' && table !== 'instrument_records')) return base.tx.query(sql, params);
      const snap = (w[table] ??= []).map((r) => ({ ...r }));
      const out = await base.tx.query(sql, params);
      try {
        for (const r of w[table]!) {
          if (table === 'cultures') {
            if (r['status'] === 'amending' && r['amendment_reason_code'] == null) throw pgErr('23514', 'cultures__amend__ck');
            if ((r['status'] === 'cancelled') !== (r['cancel_reason_code'] != null && r['cancelled_at'] != null)) throw pgErr('23514', 'cultures__cancel__ck');
            if ((r['status'] === 'final_submitted' || r['status'] === 'amending') && r['outcome_code'] == null) throw pgErr('23514', 'cultures__final__ck');
            if ((r['cancel_comment'] != null && len(r['cancel_comment']) > 500) || (r['amendment_reason_text'] != null && len(r['amendment_reason_text']) > 500)) throw pgErr('23514', 'cultures__texts__ck');
          } else {
            if (!['pending_match', 'needs_mapping', 'conflict', 'late_after_final', 'applied', 'ignored'].includes(r['match_status'])) throw pgErr('23514', 'instrument_records__status__ck');
            if ((r['match_status'] === 'ignored') !== (r['ignore_reason_code'] != null)) throw pgErr('23514', 'instrument_records__ignored__ck');
            if ((r['match_status'] === 'applied' || r['match_status'] === 'ignored') !== (r['expires_at'] != null)) throw pgErr('23514', 'instrument_records__expires__ck');
            if (r['match_reason'] != null && !/^[a-z_]{2,40}$/.test(r['match_reason'])) throw pgErr('23514', 'instrument_records__lengths__ck');
          }
        }
      } catch (e) { w[table] = snap; throw e; }
      return out;
    },
  };
  return { tx, log: base.log, world: w };
}
