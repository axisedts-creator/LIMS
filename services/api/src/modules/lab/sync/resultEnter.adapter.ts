// T0B-SYNC-4 done_when (1) (LD-322, LD-325 b; design C:/LIMS-state/offline-design-20261117.md sections 3 and 8): offline adapter of result.enter =
// bulkEnterResults (lab.result.enter). Append only through the SAME service function the online handler calls (resultEntry.handlers.ts), with the
// entries mapped the same way, as the signed in user on the operation's SAVEPOINT. Here only the offline classification of the CURRENT result state,
// for every entry, before the service runs:
//   unknown / other tenant / out of centre scope           -> common.not_found
//   verified or approved on the server                     -> rejected sync.result_locked + an alert for the lab manager (kept: outcome rejected)
//   cancelled, or its sample rejected / recollection ordered / discarded -> CONFLICT sync.entity_changed (server state, nothing appended)
//   entry version other than the server version            -> CONFLICT sync.base_version_stale (never an overwrite)
// A refused entry of the service (outcome error) rejects the whole operation with its code: nothing is half appended.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import { SyncConflictError, payloadShape, type SyncAdapter } from '../../../core/sync/engine.js';
import { FINAL_RESULT, syncAlerts, type Alerts, type ReadResult } from '../../../core/sync/offlineSignoffs.js';
import { authed } from '../handlers/resultEntry.handlers.js';
import { bulkEnterResults, type EntryInput } from '../service/result.service.js';
import { scopeOf, visible } from '../service/specimen.service.js';

const SAMPLE_GONE = new Set(['rejected', 'recollection_ordered', 'discarded']);
const DOWNTIME_MAX_MS = 72 * 3_600_000;   // LD-25 back entry window, as the online handler (DOWNTIME_MAX_HOURS_DEFAULT)
const str = (v: unknown): v is string => typeof v === 'string';

/** Default seam: the lab.results row and its specimen under RLS, filtered by the SAME centre scope as the online service (REQ-SEC-017, T-32). */
export const readResultState: ReadResult = async (ctx, id) => {
  const row = (await (ctx as any).tx.query(`SELECT r.status, r.version, r.centre_id, r.processing_centre_id, s.status AS specimen_status
     FROM lab.results r LEFT JOIN lab.specimens s ON s.tenant_id = r.tenant_id AND s.id = r.specimen_id WHERE r.tenant_id = $1 AND r.id = $2`, [ctx.tenantId, id])).rows[0];
  if (!row || !visible(await scopeOf(ctx as never), row)) return undefined;
  return { status: row.status, version: Number(row.version), ...(row.specimen_status ? { specimenStatus: row.specimen_status } : {}) };
};

type Obj = Record<string, unknown>;
function entriesOf(b: Obj): EntryInput['entries'][number][] {
  const raw = b['entries'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200) throw new LimsError('common.validation_failed');
  return raw.map((x) => {
    const e = (x ?? {}) as Obj;
    if (!str(e['result_id']) || typeof e['version'] !== 'number') throw new LimsError('common.validation_failed');
    for (const k of ['value_numeric', 'value_text', 'ordinal_code']) if (e[k] !== undefined && !str(e[k])) throw new LimsError('common.validation_failed');
    return {
      resultId: e['result_id'], version: e['version'],
      ...(e['value_numeric'] === undefined ? {} : { valueNumeric: e['value_numeric'] as string }),
      ...(e['value_text'] === undefined ? {} : { valueText: e['value_text'] as string }),
      ...(e['ordinal_code'] === undefined ? {} : { ordinalCode: e['ordinal_code'] as string }),
      ...(e['manual_abnormal'] === undefined ? {} : { manualAbnormal: e['manual_abnormal'] as boolean }),
      ...(e['comment_codes'] === undefined ? {} : { commentCodes: e['comment_codes'] as string[] }),
      ...(e['comment_text'] === undefined ? {} : { commentText: e['comment_text'] as string }),
    };
  });
}
/** LD-25 downtime back entry as the online handler: live rejects occurred_at / downtime_ref, back entry needs both, occurred_at within the window. */
function downtimeOf(b: Obj, nowMs: number): EntryInput['downtime'] {
  const mode = b['entry_mode'], at = b['occurred_at'], ref = b['downtime_ref'];
  if (mode === undefined || mode === 'live') {
    if (at !== undefined || ref !== undefined) throw new LimsError('common.validation_failed');
    return undefined;
  }
  if (mode !== 'downtime_backentry' || !str(at) || !str(ref) || ref.length < 1 || ref.length > 32) throw new LimsError('common.validation_failed');
  const t = Date.parse(at);
  if (!Number.isFinite(t) || t > nowMs || t < nowMs - DOWNTIME_MAX_MS) throw new LimsError('common.validation_failed');
  return { occurredAt: at, downtimeRef: ref };
}

export function createResultEnterAdapter(deps: { readResult?: ReadResult; alerts?: Alerts } = {}): SyncAdapter {
  const readResult = deps.readResult ?? readResultState;
  const alerts = deps.alerts ?? syncAlerts;
  return {
    opType: 'result.enter', permission: 'lab.result.enter',
    validate: payloadShape('lab.yaml', 'BulkEnterResultsRequest'),
    async execute(ctx: HandlerContext, op) {
      const entries = entriesOf(op.payload);
      const downtime = downtimeOf(op.payload, Date.parse(String((ctx as any).now?.() ?? new Date().toISOString())));
      const states = [];
      for (const e of entries) {
        const s = await readResult(ctx, e.resultId);
        if (!s) throw new LimsError('common.not_found');
        states.push({ e, s });
      }
      const locked = states.filter(({ s }) => FINAL_RESULT.has(s.status));
      if (locked.length) {
        for (const { e } of locked) await alerts.raise(ctx, { kind: 'result_locked', opId: op.opId, resultId: e.resultId });
        return { outcome: 'rejected', errorCode: 'sync.result_locked' };
      }
      for (const { e, s } of states) {
        const server = { status: s.status, version: Number(s.version), ...(s.specimenStatus ? { specimen_status: s.specimenStatus } : {}) };
        if (s.status === 'cancelled' || (s.specimenStatus && SAMPLE_GONE.has(s.specimenStatus))) {
          throw new SyncConflictError({ entityType: 'result', entityId: e.resultId, serverPayload: server, errorCode: 'sync.entity_changed' });
        }
        if (Number(s.version) !== e.version) throw new SyncConflictError({ entityType: 'result', entityId: e.resultId, serverPayload: server, errorCode: 'sync.base_version_stale' });
      }
      const out = await bulkEnterResults(authed(ctx), { entries, ...(downtime ? { downtime } : {}) });
      const refused = out.results.find((r) => r.outcome === 'error');
      if (refused) throw new LimsError((refused.code ?? 'common.internal') as never);   // rolls the SAVEPOINT back: nothing half appended
      return {};
    },
  };
}

export const resultEnterAdapter: SyncAdapter = createResultEnterAdapter();
