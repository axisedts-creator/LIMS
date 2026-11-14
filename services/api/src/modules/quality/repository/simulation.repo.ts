// C9 T-17 read repo: simulation report + decision reads (02-TRD §8.6, §5.5 #42/#43/#46/#47; 05-SCHEMA quality.autoverify_decisions (class A, append-only), quality.verification_log, quality.settings).
// SELECT only. Every statement is parameterised, schema-qualified and carries `tenant_id = $n` bound to the tenant ARGUMENT on top of RLS (REQ-SEC-022/024).
// The P3 `inputs` column is read by findDecision (#47) only: never by the report or the list. Timestamps leave as ISO-8601 UTC text (microseconds = exact keyset position).
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export interface SimTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface Minimums { sim_min_days: number; sim_min_decisions: number }
export interface ReportQuery { versionId: string; since: string; sampleLimit: number }
export interface ReportRows {
  decisions: number; would_allow: number; would_deny: number; deny_by_reason: Record<string, number>;
  allow_later_manually_verified: number; allow_not_verified_yet: number;
  live_comparison?: { both_allow: number; live_only_allow: number; shadow_only_allow: number };
  sample: Row[];
}
export interface DecisionQuery { resultId?: string; analyteId?: string; instrumentId?: string; versionId?: string; mode?: string; decision?: string; reason?: string; from: string; to: string; cursor?: string; limit: number }

export interface SimulationRepo {
  getMinimums(tx: SimTx, tenantId: string): Promise<Minimums | undefined>;
  countShadowDecisions(tx: SimTx, tenantId: string, versionId: string, since: string): Promise<number>;
  simulationReport(tx: SimTx, tenantId: string, q: ReportQuery): Promise<ReportRows>;
  listDecisions(tx: SimTx, tenantId: string, q: DecisionQuery): Promise<{ rows: Row[]; nextCursor?: string }>;
  findDecision(tx: SimTx, tenantId: string, id: string): Promise<Row | undefined>;
}

const ISO = (expr: string, as: string) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${as}`;
const DEC_COLS = `id, ${ISO('decided_at', 'decided_at')}, mode, version_id, result_id, analyte_id, instrument_id, decision, reasons, matched_rule_key, qc_status, qc_run_id`;

// ---------------------------------------------------------------------------------------------------- keyset cursor (decided_at, id)
const KEY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeKey = (at: string, id: string): string => Buffer.from(JSON.stringify(['k', at, id]), 'utf8').toString('base64url');
function decodeKey(raw: string): { at: string; id: string } {
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== 'k' || typeof v[1] !== 'string' || !KEY.test(v[1]) || typeof v[2] !== 'string' || !UUID.test(v[2])) throw bad();
  return { at: v[1], id: v[2] };
}

// ---------------------------------------------------------------------------------------------------- simulation report (02-TRD §8.6)
// s = the shadow decisions of version $2 since $3, each with the first verification fact of its result and the live decision of the same canAutoVerify call
// (same result_id, mode live; the live row nearest in time - ponytail: both rows share one request clock, nearest-in-time is the loosest match that still pairs them).
const BASE = `WITH s AS (
  SELECT d.id, d.result_id, d.analyte_id, d.decided_at, d.decision, d.reasons, l.decision AS live_decision, v.order_id, v.verified_at,
         CASE WHEN v.mode = 'manual' THEN v.verified_at END AS manually_verified_at
    FROM quality.autoverify_decisions d
    LEFT JOIN LATERAL (SELECT x.order_id, x.verified_at, x.mode FROM quality.verification_log x
                        WHERE x.tenant_id = d.tenant_id AND x.result_id = d.result_id ORDER BY x.verified_at ASC LIMIT 1) v ON true
    LEFT JOIN LATERAL (SELECT y.decision FROM quality.autoverify_decisions y
                        WHERE y.tenant_id = d.tenant_id AND y.result_id = d.result_id AND y.mode = 'live'
                        ORDER BY abs(extract(epoch FROM (y.decided_at - d.decided_at))) ASC LIMIT 1) l ON true
   WHERE d.tenant_id = $1 AND d.version_id = $2 AND d.mode = 'shadow' AND d.decided_at >= $3::timestamptz
)`;
const AGG = `${BASE}
SELECT count(*)::int AS decisions,
       count(*) FILTER (WHERE decision = 'allow')::int AS would_allow,
       count(*) FILTER (WHERE decision = 'deny')::int AS would_deny,
       count(*) FILTER (WHERE decision = 'allow' AND manually_verified_at IS NOT NULL)::int AS allow_later_manually_verified,
       count(*) FILTER (WHERE decision = 'allow' AND verified_at IS NULL)::int AS allow_not_verified_yet,
       count(live_decision)::int AS live_rows,
       count(*) FILTER (WHERE decision = 'allow' AND live_decision = 'allow')::int AS both_allow,
       count(*) FILTER (WHERE decision = 'deny' AND live_decision = 'allow')::int AS live_only_allow,
       count(*) FILTER (WHERE decision = 'allow' AND live_decision IS DISTINCT FROM 'allow')::int AS shadow_only_allow
  FROM s`;
const REASONS = `${BASE}
SELECT r AS reason, count(*)::int AS n FROM s, unnest(s.reasons) AS r WHERE s.decision = 'deny' GROUP BY r`;
const SAMPLE = `${BASE}
SELECT s.id AS decision_id, s.result_id, s.order_id, s.analyte_id, ${ISO('s.decided_at', 'decided_at')}, s.decision AS shadow_decision, s.reasons AS shadow_reasons,
       s.live_decision, ${ISO('s.manually_verified_at', 'manually_verified_at')}
  FROM s WHERE s.decision = 'allow' ORDER BY s.decided_at DESC, s.id DESC LIMIT $4`;

const n = (v: unknown): number => Number(v ?? 0);

export function createSimulationRepo(): SimulationRepo {
  return {
    async getMinimums(tx, tenantId) {
      const r = (await tx.query('SELECT sim_min_days, sim_min_decisions FROM quality.settings WHERE tenant_id = $1', [tenantId])).rows[0];
      return r ? { sim_min_days: Number(r['sim_min_days']), sim_min_decisions: Number(r['sim_min_decisions']) } : undefined;
    },

    async countShadowDecisions(tx, tenantId, versionId, since) {
      const r = (await tx.query(
        `SELECT count(*)::int AS n FROM quality.autoverify_decisions WHERE tenant_id = $1 AND version_id = $2 AND mode = 'shadow' AND decided_at >= $3::timestamptz`,
        [tenantId, versionId, since])).rows[0];
      return n(r?.['n'] ?? r?.['count']);
    },

    async simulationReport(tx, tenantId, q) {
      const base = [tenantId, q.versionId, q.since];
      const a = (await tx.query(AGG, base)).rows[0] ?? {};
      const reasons = (await tx.query(REASONS, base)).rows;
      const sample = (await tx.query(SAMPLE, [...base, q.sampleLimit])).rows;
      return {
        decisions: n(a['decisions']), would_allow: n(a['would_allow']), would_deny: n(a['would_deny']),
        deny_by_reason: Object.fromEntries(reasons.map((r) => [r['reason'], n(r['n'])])),
        allow_later_manually_verified: n(a['allow_later_manually_verified']), allow_not_verified_yet: n(a['allow_not_verified_yet']),
        ...(n(a['live_rows']) > 0 ? { live_comparison: { both_allow: n(a['both_allow']), live_only_allow: n(a['live_only_allow']), shadow_only_allow: n(a['shadow_only_allow']) } } : {}),
        sample,
      };
    },

    async listDecisions(tx, tenantId, q) {
      const values: unknown[] = [tenantId], where = ['tenant_id = $1'];
      const bind = (v: unknown, cast = '') => { values.push(v); return `$${values.length}${cast}`; };
      where.push(`decided_at >= ${bind(q.from, '::timestamptz')}`, `decided_at <= ${bind(q.to, '::timestamptz')}`);
      if (q.resultId !== undefined) where.push(`result_id = ${bind(q.resultId, '::uuid')}`);
      if (q.analyteId !== undefined) where.push(`analyte_id = ${bind(q.analyteId, '::uuid')}`);
      if (q.instrumentId !== undefined) where.push(`instrument_id = ${bind(q.instrumentId, '::uuid')}`);
      if (q.versionId !== undefined) where.push(`version_id = ${bind(q.versionId, '::uuid')}`);
      if (q.mode !== undefined) where.push(`mode = ${bind(q.mode)}`);
      if (q.decision !== undefined) where.push(`decision = ${bind(q.decision)}`);
      if (q.reason !== undefined) where.push(`reasons @> ARRAY[${bind(q.reason, '::text')}]`);
      if (q.cursor !== undefined) { const k = decodeKey(q.cursor); where.push(`(decided_at, id) < (${bind(k.at, '::timestamptz')}, ${bind(k.id, '::uuid')})`); }
      // ORDER BY names the output column `decided_at` (fixed-width UTC text, microseconds = same order as the timestamptz); WHERE above sees the real column.
      const { rows } = await tx.query(
        `SELECT ${DEC_COLS} FROM quality.autoverify_decisions WHERE ${where.join(' AND ')} ORDER BY decided_at DESC, id DESC LIMIT ${bind(q.limit + 1)}`, values);
      if (rows.length <= q.limit) return { rows };
      const kept = rows.slice(0, q.limit), last = kept[kept.length - 1]!;
      return { rows: kept, nextCursor: encodeKey(last['decided_at'], last['id']) };
    },

    async findDecision(tx, tenantId, id) {
      return (await tx.query(`SELECT ${DEC_COLS}, inputs FROM quality.autoverify_decisions WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
    },
  };
}
