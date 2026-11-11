// C8 AN-T11 — repository/rollups.repo.ts (results, rejections, specimens, critical values, deliveries, releases, interface messages) and
// repository/sourceViews.repo.ts (agent status). 02-TRD §6.5, §6.8; 07-SECURITY P1, P4, REQ-SEC-013/017. Fake tx records (text, values).
// SEAMS (writer may dispute; shapes documented in handlers/__tests__/helpers.t11.ts): every rollup function is `fn(tx, { tenantId, from, to, scope, ... })`
// with positional params $1 tenant, $2 from, $3 to, $4 all-centres flag, $5 centre-id array (as AN-T08); extra filters after $5.
// Agent status: `listAgentStatus(tx, { tenantId, scope })` — tenant is `$1`; the scope flag and centre array are bound values.
import { describe, expect, it } from 'vitest';
import * as rollups from '../rollups.repo.js';
import * as sourceViews from '../sourceViews.repo.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222221';
const C2 = '22222222-2222-4222-8222-222222222222';
const ALL = { all: true, centreIds: [] as string[] };
const RESTRICTED = { all: false, centreIds: [C1, C2] };
const EMPTY = { all: false, centreIds: [] as string[] };
const FROM = '2026-11-05', TO = '2026-11-07';

function fakeTx(rows: any[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (values[3] === false && Array.isArray(values[4]) && values[4].length === 0) return { rows: [] }; // the database answers nothing for an empty restricted scope
      return { rows };
    },
  };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const SCOPE_RE = /\$4 or \(centre_id is not null and centre_id = any \(\$5\)\)/;

type Case = { name: string; table: string; call: (tx: any, scope: any) => Promise<any>; row: Record<string, unknown>; columns: string[]; nullCentreSafe: boolean };
const CASES: Case[] = [
  { name: 'resultsRows', table: 'analytics.daily_results', call: (tx, scope) => (rollups as any).resultsRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope, groupBy: 'department' }),
    row: { key: C1, results_resulted: '10', results_verified: '8', results_approved: '6', results_amended: '1', auto_verified: '2', critical_count: '1', abnormal_count: '3', tests_approved: '4' },
    columns: ['results_resulted', 'results_verified', 'results_approved', 'results_amended', 'auto_verified', 'critical_count', 'abnormal_count', 'tests_approved'], nullCentreSafe: true },
  { name: 'rejectionRows', table: 'analytics.daily_rejections', call: (tx, scope) => (rollups as any).rejectionRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope, groupBy: 'reason' }),
    row: { key: 'haemolysed', rejections: '5', recollections_ordered: '3' }, columns: ['rejections', 'recollections_ordered'], nullCentreSafe: true },
  { name: 'specimenRows', table: 'analytics.daily_specimens', call: (tx, scope) => (rollups as any).specimenRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope, groupBy: 'total' }),
    row: { key: null, received: '100' }, columns: ['received'], nullCentreSafe: true },
  { name: 'criticalValueRows', table: 'analytics.daily_critical_values', call: (tx, scope) => (rollups as any).criticalValueRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope }),
    row: { business_date: '2026-11-05', detected: '5', notified: '4', median_notify_seconds: '600', max_notify_seconds: '900' }, columns: ['detected', 'notified', 'max_notify_seconds'], nullCentreSafe: true },
  { name: 'deliveryRows', table: 'analytics.daily_deliveries', call: (tx, scope) => (rollups as any).deliveryRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope, groupBy: 'channel' }),
    row: { key: 'sms', queued: '1', sent: '2', delivered: '3', read: '4', failed: '5', suppressed: '6' }, columns: ['queued', 'sent', 'delivered', 'failed', 'suppressed'], nullCentreSafe: true },
  { name: 'releaseRows', table: 'analytics.daily_releases', call: (tx, scope) => (rollups as any).releaseRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope, groupBy: 'total' }),
    row: { key: null, released: '21', final: '13', partial: '2', preliminary: '1', amended: '1', overrides: '3' }, columns: ['released', 'report_kind', 'release_basis'], nullCentreSafe: true },
  { name: 'interfaceMessageRows', table: 'analytics.daily_interface_messages', call: (tx, scope) => (rollups as any).interfaceMessageRows(tx, { tenantId: TENANT, from: FROM, to: TO, scope }),
    row: { instrument_id: C1, centre_id: C1, messages: '200', patient_records: '170', qc_records: '23', unmatched: '3', quarantined: '1', duplicates: '3' },
    columns: ['messages', 'patient_records', 'qc_records', 'unmatched', 'quarantined', 'duplicates'], nullCentreSafe: true },
];

describe.each(CASES)('$name — SQL shape (TRD §6.5 / §6.8)', (c) => {
  it('exists, reads its analytics.daily_* table with tenant, [from, to) and the TRD scope predicate, all as bound parameters', async () => {
    expect(typeof (rollups as any)[c.name]).toBe('function');
    const tx = fakeTx([c.row]);
    await c.call(tx, RESTRICTED);
    expect(tx.calls).toHaveLength(1);
    const { text, values } = tx.calls[0]!;
    const sql = norm(text);
    expect(sql).toContain(`from ${c.table}`);
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('business_date >= $2');
    expect(sql).toContain('business_date < $3');
    expect(sql).toMatch(SCOPE_RE);
    expect(values.slice(0, 5)).toEqual([TENANT, FROM, TO, false, [C1, C2]]);
    for (const col of c.columns) expect(sql, col).toContain(col);
    expect(sql).not.toContain('select *');
  });

  it('all-centre scope binds $4 = true and an empty $5; no tenant / date / centre value is interpolated into the text', async () => {
    const tx = fakeTx();
    await c.call(tx, ALL);
    expect(tx.calls[0]!.values.slice(0, 5)).toEqual([TENANT, FROM, TO, true, []]);
    await c.call(tx, RESTRICTED);
    for (const call of tx.calls) for (const v of [TENANT, FROM, TO, C1, C2]) expect(call.text).not.toContain(v);
  });

  it('empty restricted scope → no rows (never widens to all centres)', async () => {
    expect(await c.call(fakeTx([c.row]), EMPTY)).toEqual([]);
  });

  it('missing / malformed scope throws before any query (scope is mandatory)', async () => {
    const tx = fakeTx();
    await expect(c.call(tx, undefined)).rejects.toThrow(/scope/i);
    await expect(c.call(tx, { all: 'yes', centreIds: [] })).rejects.toThrow(/scope/i);
    expect(tx.calls).toEqual([]);
  });

  it('bigint strings come back as safe integers; a value beyond 2^53 is refused, never rounded', async () => {
    const out = await c.call(fakeTx([c.row]), ALL);
    expect(out).toHaveLength(1);
    for (const k of c.columns.filter((x) => x in out[0])) expect(Number.isSafeInteger(out[0][k]), k).toBe(true);
    const bad = Object.fromEntries(Object.entries(c.row).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) && c.columns.includes(k) ? '9007199254740993' : v]));
    await expect(c.call(fakeTx([bad]), ALL)).rejects.toThrow();
  });
});

describe('group keys come only from a closed allow-list (07 injection, abuse case 1)', () => {
  const base = { tenantId: TENANT, from: FROM, to: TO, scope: ALL };
  const BAD = ["day'; DROP TABLE analytics.daily_results; --", '', 'centre_id, tenant_id', undefined, 7];

  it.each([
    ['resultsRows', ['department', 'test', 'processing_branch', 'day', 'ad_month'], /group by[^;]*(department_id|test_id|processing_branch_id|business_date)/],
    ['rejectionRows', ['reason', 'centre', 'specimen_type', 'day', 'ad_month'], /group by[^;]*(reason_code|centre_id|specimen_type_code|business_date)/],
    ['deliveryRows', ['channel', 'day', 'ad_month'], /group by[^;]*(channel|business_date)/],
  ] as const)('%s: each allowed groupBy produces a GROUP BY on a column; anything else throws before querying', async (fn, allowed, groupRe) => {
    for (const groupBy of allowed) {
      const tx = fakeTx();
      await (rollups as any)[fn](tx, { ...base, groupBy });
      expect(norm(tx.calls[0]!.text), groupBy).toMatch(groupRe);
      expect(norm(tx.calls[0]!.text), groupBy).toMatch(/order by/);
    }
    for (const groupBy of BAD) {
      const tx = fakeTx();
      await expect((rollups as any)[fn](tx, { ...base, groupBy }), String(groupBy)).rejects.toThrow();
      expect(tx.calls).toEqual([]);
    }
  });

  it('resultsRows filters: department_id / processing_branch_id are bound arrays after $5, never interpolated', async () => {
    const tx = fakeTx();
    await (rollups as any).resultsRows(tx, { ...base, groupBy: 'department', departmentIds: [C1], processingBranchIds: [C2] });
    const { text, values } = tx.calls[0]!;
    expect(norm(text)).toMatch(/department_id = any \(\$\d+\)/);
    expect(norm(text)).toMatch(/processing_branch_id = any \(\$\d+\)/);
    expect(values.slice(5)).toEqual(expect.arrayContaining([[C1], [C2]]));
    expect(text).not.toContain(C1);
    expect(text).not.toContain(C2);
  });

  it('deliveryRows sums the reserved word "read" as a quoted identifier', async () => {
    const tx = fakeTx();
    await (rollups as any).deliveryRows(tx, { ...base, groupBy: 'channel' });
    expect(norm(tx.calls[0]!.text)).toContain('sum("read")');
  });
});

describe('sourceViews.listAgentStatus — live agents (TRD §6.8)', () => {
  const ROW = { agent_id: C1, centre_id: C1, state: 'online', last_heartbeat_at: '2026-11-06T05:59:00.000Z', agent_version: '1.4.2', queue_depth: '0' };
  const asTx = (rows: any[]) => { const calls: { text: string; values: unknown[] }[] = []; return { calls, async query(text: string, values: unknown[] = []) { calls.push({ text, values }); return { rows }; } }; };

  it('selects the six view columns from instruments.v_pub_agent_status with tenant $1 and the scope as bound values', async () => {
    const tx = asTx([ROW]);
    await (sourceViews as any).listAgentStatus(tx, { tenantId: TENANT, scope: RESTRICTED });
    const { text, values } = tx.calls[0]!;
    const sql = norm(text);
    expect(sql).toContain('from instruments.v_pub_agent_status');
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toMatch(/centre_id is not null and centre_id = any/);
    for (const c of ['agent_id', 'centre_id', 'state', 'last_heartbeat_at', 'agent_version', 'queue_depth']) expect(sql, c).toContain(c);
    expect(sql).not.toContain('select *');
    expect(values[0]).toBe(TENANT);
    expect(values).toEqual(expect.arrayContaining([false, [C1, C2]]));
    for (const v of [TENANT, C1, C2]) expect(text).not.toContain(v);
  });

  it('empty restricted scope → [] without widening; queue_depth string → integer; scope mandatory', async () => {
    expect(await (sourceViews as any).listAgentStatus(asTx([ROW]), { tenantId: TENANT, scope: EMPTY })).toEqual([]);
    const out = await (sourceViews as any).listAgentStatus(asTx([ROW]), { tenantId: TENANT, scope: ALL });
    expect(out[0]).toEqual({ ...ROW, queue_depth: 0 });
    await expect((sourceViews as any).listAgentStatus(asTx([ROW]), { tenantId: TENANT })).rejects.toThrow(/scope/i);
  });
});
