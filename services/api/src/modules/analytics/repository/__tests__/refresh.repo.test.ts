// AN-T04 repository/{refresh,orderIndex}.repo.ts - SQL contract of the refresh engine (02-TRD §8.2 markDirty/order_index SQL, §9.1 families, §9.2 partition replace,
// §9.2 TAT facts, aggregations, §9.2 report backlog; PRD US-11.1-3, US-13.x, US-20.2-4; 05-SCHEMA; 08 A13 D-3/P-4, A17 P-22, D-48).
// Fake tx = statement recorder (no DB here; the live twin is refresh.live.test.ts). Every family is covered; the SQL shapes asserted are the ones the TRD prints.
// ASSUMED API (spec gives SQL, not signatures; the writer may dispute via the reviewer). All take the caller's `tx` first; the CALLER owns BEGIN/COMMIT (no tx control here).
//   replacePartition(tx, { tenantId, family, from?, to?, runId, backlogLookbackDays? }): Promise<{ rowsWritten: number }>
//        from/to = ISO dates, half-open [from,to), required for the 15 date families, ignored for 'report_backlog' (whole snapshot, lookback default 30).
//        Statement order per §9.2; binds: $1 tenant, $2 from, $3 to, runId somewhere in values. rowsWritten = sum of the INSERT row counts.
//   markDirty(tx, { tenantId, family, businessDate, reason, actorId }): Promise<void>      (report_backlog <-> '1970-01-01' only, DB CHECK dirty_partitions__snapshot__ck)
//   loadFamilyStates(tx, { tenantId }): Promise<FamilyState[]>   one entry per FAMILIES member (domain/freshness FamilyState); missing refresh_state row => lastSuccessAt null.
//   upsertOrderCreated(tx, { tenantId, orderId, centreId, branchId, referrerId, registeredAt, eventId, actorId }) / recordOrderCancelled(tx, { tenantId, orderId, cancelledAt, eventId, actorId }) -> { placeholder: boolean }
import { describe, expect, it } from 'vitest';
import { evaluateFreshness } from '../../domain/freshness.js';
import { FAMILIES, FAMILY_TABLE, SNAPSHOT_DATE, type Family } from '../../domain/families.js';
import { recordOrderCancelled, upsertOrderCreated } from '../orderIndex.repo.js';
import { loadFamilyStates, markDirty, replacePartition } from '../refresh.repo.js';

const TA = '01a1a98a-ac40-7000-8000-00000000a001', RUN = '0190c409-0000-7000-8000-000000000001', ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const FROM = '2026-10-01', TO = '2026-11-10';
interface Call { text: string; values: unknown[] }

function recorder(over: { rowsFor?: (text: string) => { rows?: unknown[]; rowCount: number } } = {}) {
  const calls: Call[] = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    calls.push({ text, values });
    if (over.rowsFor) return { rows: [], ...over.rowsFor(text) };
    return { rows: [], rowCount: /^\s*INSERT/i.test(text) ? 4 : /^\s*DELETE/i.test(text) ? 9 : 0 };
  } };
  return { tx: tx as never, calls };
}
const norm = (s: string) => s.replace(/\s+/g, ' ');
const rels = (text: string) => [...text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+\.[a-z_0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
const SPEC_VIEW = 'lab.v_pub_specimen_timeline', RPT_TAT = 'reporting.v_pub_order_report_tat';
/** §9.1 source relations per family. */
const SOURCES: Record<Family, readonly string[]> = {
  orders: ['frontdesk.v_pub_order_daily'], centre_volume: ['frontdesk.v_pub_centre_volume'], referrer_volume: ['frontdesk.v_pub_referrer_volume'],
  income: ['billing.v_pub_invoice_daily'], department_income: ['billing.v_pub_department_income'], collections: ['billing.v_pub_payment_collection'],
  referrer_billing: ['billing.v_pub_referrer_billing'], results: ['lab.v_pub_result_daily'], specimens: [SPEC_VIEW],
  rejections: ['lab.v_pub_rejection_daily'], critical_values: ['lab.v_pub_critical_value_daily'], tat: [SPEC_VIEW, RPT_TAT],
  releases: ['reporting.v_pub_report_release'], deliveries: ['reporting.v_pub_delivery_daily'], interface_messages: ['instruments.v_pub_message_daily'],
  report_backlog: ['analytics.order_index', RPT_TAT, SPEC_VIEW],
};
const DATE_FAMILIES = FAMILIES.filter((f) => f !== 'report_backlog');

async function replaceCalls(family: Family, extra: Record<string, unknown> = {}) {
  const r = recorder();
  const out = await replacePartition(r.tx, { tenantId: TA, family, from: FROM, to: TO, runId: RUN, ...extra } as never);
  return { ...r, out };
}

describe.each(FAMILIES.map((f) => [f] as const))('replacePartition(%s): §9.2 contract', (family) => {
  const table = `analytics.${FAMILY_TABLE[family]}`;

  it(`DELETE FROM ${table} WHERE tenant_id = $1 first, then INSERT INTO ${table} … SELECT from the §9.1 source(s)`, async () => {
    const { calls } = await replaceCalls(family);
    const first = norm(calls[0]!.text);
    expect(first).toMatch(new RegExp(`^DELETE FROM ${table.replace('.', '\\.')}\\b`, 'i'));
    expect(first).toMatch(/\btenant_id\s*=\s*\$1\b/i);
    const ins = calls.filter((c) => /^\s*INSERT/i.test(c.text));
    expect(ins.length).toBeGreaterThanOrEqual(1);
    for (const c of ins) expect(norm(c.text)).toMatch(new RegExp(`^INSERT INTO ${table.replace('.', '\\.')}\\b`, 'i'));
    expect(calls.findIndex((c) => /^\s*INSERT/i.test(c.text))).toBeGreaterThan(0);
    const insertRels = new Set(ins.flatMap((c) => rels(c.text)));
    for (const src of SOURCES[family]) expect(insertRels, `${family} must read ${src}`).toContain(src);
  });

  it('reads only analytics.* and published v_pub_* views (no base tables); only the listed sources; nothing but DELETE/INSERT', async () => {
    const { calls } = await replaceCalls(family);
    for (const c of calls) {
      expect(c.text).toMatch(/^\s*(DELETE|INSERT)\b/i);
      for (const r of rels(c.text)) expect(r).toMatch(/^analytics\.|^\w+\.v_pub_\w+$/);
      expect(c.text).not.toMatch(/\b(TRUNCATE|DROP|ALTER)\b|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b/i);
    }
    const allowed = new Set([`analytics.${FAMILY_TABLE[family]}`, ...SOURCES[family]]);
    for (const c of calls) for (const r of rels(c.text)) expect(allowed, `${family}: unexpected relation ${r}`).toContain(r);
  });

  it('tenant, range and run id are bound, never interpolated; every INSERT stamps refresh_run_id and refreshed_at = now()', async () => {
    const { calls } = await replaceCalls(family);
    for (const c of calls) {
      expect(c.values[0]).toBe(TA);
      expect(c.text).not.toContain(TA);
      expect(c.text).not.toContain(RUN);
      expect(c.text).not.toContain(FROM);
      expect(c.text).not.toContain(TO);
    }
    const ins = calls.filter((c) => /^\s*INSERT/i.test(c.text));
    for (const c of ins) {
      expect(c.values).toContain(RUN);
      expect(c.text).toMatch(/refresh_run_id/i);
      expect(c.text).toMatch(/refreshed_at/i);
      expect(c.text).toMatch(/\bnow\(\)/i);
      expect(c.text).toMatch(/\btenant_id\s*=\s*\$1\b/i);          // the source read is tenant-filtered too (RLS is tenant-wide for the system actor)
    }
  });
});

describe.each(DATE_FAMILIES.map((f) => [f] as const))('replacePartition(%s): half-open date range', (family) => {
  it('DELETE and the source read use business_date >= $2 AND < $3 (or the family\'s stop-timestamp bounds) with values [tenant, from, to]', async () => {
    const { calls } = await replaceCalls(family);
    const del = norm(calls[0]!.text);
    expect(del).toMatch(/business_date\s*>=\s*\$2\b/i);
    expect(del).toMatch(/business_date\s*<\s*\$3\b/i);
    expect(calls[0]!.values).toEqual([TA, FROM, TO]);
    const ins = calls.filter((c) => /^\s*INSERT/i.test(c.text));
    for (const c of ins) {
      expect(c.values.slice(0, 3)).toEqual([TA, FROM, TO]);
      expect(c.text).not.toMatch(/business_date\s*<=\s*\$3|business_date\s*BETWEEN/i);   // [from,to) not [from,to]
      expect(c.text).toMatch(/\$2\b/);
      expect(c.text).toMatch(/\$3\b/);
    }
  });

  it('rowsWritten = what the INSERT reported (not the DELETE count); no BEGIN/COMMIT: the caller owns the transaction', async () => {
    const { out } = await replaceCalls(family);
    expect(out).toMatchObject({ rowsWritten: 4 });
  });

  it('rejects a bad range before any statement: from >= to, non-ISO, injection', async () => {
    for (const bad of [{ from: TO, to: FROM }, { from: FROM, to: FROM }, { from: '2026-13-01', to: TO }, { from: "2026-10-01'; DROP TABLE x;--", to: TO }, { from: undefined, to: TO }, { from: FROM, to: undefined }]) {
      const r = recorder();
      await expect(replacePartition(r.tx, { tenantId: TA, family, runId: RUN, ...bad } as never)).rejects.toBeTruthy();
      expect(r.calls).toEqual([]);
    }
  });
});

describe('replacePartition: input hygiene', () => {
  it('unknown family / table-name injection is rejected before any statement (the table name is interpolated, so it must come from the closed set)', async () => {
    for (const family of ['nope', 'daily_income', 'income; DROP TABLE analytics.daily_income', '__proto__', 'constructor', '', undefined]) {
      const r = recorder();
      await expect(replacePartition(r.tx, { tenantId: TA, family, from: FROM, to: TO, runId: RUN } as never)).rejects.toBeTruthy();
      expect(r.calls).toEqual([]);
    }
  });
  it('non-uuid tenant / run id rejected before any statement', async () => {
    for (const bad of [{ tenantId: 'x' }, { runId: 'y' }, { tenantId: "' OR 1=1 --" }]) {
      const r = recorder();
      await expect(replacePartition(r.tx, { tenantId: TA, family: 'income', from: FROM, to: TO, runId: RUN, ...bad } as never)).rejects.toBeTruthy();
      expect(r.calls).toEqual([]);
    }
  });
});

describe('replacePartition(tat): facts move with their subject (review #4) - three statements, one tx', () => {
  it('exactly: (1) DELETE by business_date range, (2) DELETE by (segment, subject_id) IN <new rows>, (3) INSERT <new rows> - in this order', async () => {
    const { calls } = await replaceCalls('tat');
    expect(calls).toHaveLength(3);
    const [a, b, c] = calls.map((x) => norm(x.text)) as [string, string, string];
    expect(a).toMatch(/^DELETE FROM analytics\.tat_facts\b/i);
    expect(a).toMatch(/business_date\s*>=\s*\$2/i);
    expect(a).toMatch(/business_date\s*<\s*\$3/i);
    expect(b).toMatch(/^DELETE FROM analytics\.tat_facts\b/i);
    expect(b).toMatch(/\bsegment\b[\s\S]*\bsubject_id\b[\s\S]*\bIN\s*\(/i);
    expect(b).not.toMatch(/business_date\s*>=\s*\$2\b(?![\s\S]*SELECT)/i);          // statement 2 is by subject, not by day
    expect(c).toMatch(/^INSERT INTO analytics\.tat_facts\b/i);
  });

  it('statements 2 and 3 evaluate the SAME new-rows SELECT (same segments, same filters, same bounds)', async () => {
    const { calls } = await replaceCalls('tat');
    const sel = (t: string) => norm(t.slice(t.search(/SELECT\s+tenant_id\s*,\s*'pre_analytical'/i)));
    const [, b, c] = calls as [Call, Call, Call];
    expect(sel(b.text).length).toBeGreaterThan(200);
    for (const seg of ['pre_analytical', 'transport', 'within_lab', 'total_first_release', 'total_final_release']) {
      expect(b.text.split(`'${seg}'`).length - 1, `${seg} in stmt 2`).toBe(c.text.split(`'${seg}'`).length - 1);
      expect(c.text).toContain(`'${seg}'`);
    }
    expect(b.text.split('total_tat_seconds IS NOT NULL').length).toBe(c.text.split('total_tat_seconds IS NOT NULL').length);
    expect(b.values.slice(0, 3)).toEqual([TA, FROM, TO]);
    expect(c.values.slice(0, 3)).toEqual([TA, FROM, TO]);
    expect(b.values).toContain(RUN);
  });

  it('five segments from lab.v_pub_specimen_timeline (3) and reporting.v_pub_order_report_tat (2); is_anomaly, duration_seconds, business_date in Asia/Kathmandu of the STOP timestamp', async () => {
    const ins = norm((await replaceCalls('tat')).calls[2]!.text);
    const branches = ins.split(/\bUNION\s+ALL\b/i);
    expect(branches).toHaveLength(5);
    const by = (seg: string) => branches.find((b) => b.includes(`'${seg}'`))!;
    for (const seg of ['pre_analytical', 'transport', 'within_lab']) expect(by(seg)).toMatch(/lab\.v_pub_specimen_timeline/i);
    for (const seg of ['total_first_release', 'total_final_release']) expect(by(seg)).toMatch(/reporting\.v_pub_order_report_tat/i);
    for (const b of branches) {
      expect(b).toMatch(/AT TIME ZONE 'Asia\/Kathmandu'\s*\)\s*::date/i);
      expect(b).toMatch(/floor\s*\(\s*extract\s*\(\s*epoch\s+FROM/i);
      expect(b).toMatch(/\bis_anomaly\b|<\s*(collected_at|in_transit_at|received_at|registered_at)/i);
      expect(b).not.toMatch(/AT TIME ZONE '(?!Asia\/Kathmandu)/i);
    }
    expect(ins).toMatch(/\bis_anomaly\b/i);
    expect(ins).toMatch(/\bduration_seconds\b/i);
  });

  it('window by the stop timestamp (day the sample completes, US-11.1.4): received_at / first_verified_at / first_released_at / final_released_at in [from_ts, to_ts)', async () => {
    const ins = norm((await replaceCalls('tat')).calls[2]!.text);
    const br = ins.split(/\bUNION\s+ALL\b/i);
    const by = (seg: string) => br.find((b) => b.includes(`'${seg}'`))!;
    expect(by('pre_analytical')).toMatch(/received_at\s*>=\s*\S+[\s\S]*received_at\s*<\s*\S+/i);
    expect(by('transport')).toMatch(/received_at\s*>=\s*\S+[\s\S]*received_at\s*<\s*\S+/i);
    expect(by('within_lab')).toMatch(/first_verified_at\s*>=\s*\S+[\s\S]*first_verified_at\s*<\s*\S+/i);
    expect(by('total_first_release')).toMatch(/first_released_at\s*>=\s*\S+[\s\S]*first_released_at\s*<\s*\S+/i);
    expect(by('total_final_release')).toMatch(/final_released_at\s*>=\s*\S+[\s\S]*final_released_at\s*<\s*\S+/i);
    expect(ins).toMatch(/\$2(::\w+)?\s+AT TIME ZONE 'Asia\/Kathmandu'/i);       // bounds are local midnights as instants (same as specimens)
    expect(ins).toMatch(/\$3(::\w+)?\s+AT TIME ZONE 'Asia\/Kathmandu'/i);
  });

  it('missing endpoint -> no fact; rejected specimens and aliquots excluded from the three specimen segments (US-11.2/3, CR-C8-004)', async () => {
    const br = norm((await replaceCalls('tat')).calls[2]!.text).split(/\bUNION\s+ALL\b/i);
    const by = (seg: string) => br.find((b) => b.includes(`'${seg}'`))!;
    expect(by('pre_analytical')).toMatch(/collected_at\s+IS\s+NOT\s+NULL/i);
    expect(by('transport')).toMatch(/in_transit_at\s+IS\s+NOT\s+NULL/i);
    expect(by('within_lab')).toMatch(/received_at\s+IS\s+NOT\s+NULL/i);
    for (const seg of ['pre_analytical', 'transport', 'within_lab']) {
      expect(by(seg), seg).toMatch(/rejected_at\s+IS\s+NULL/i);
      expect(by(seg), seg).toMatch(/parent_specimen_id\s+IS\s+NULL/i);
    }
    for (const seg of ['total_first_release', 'total_final_release']) expect(by(seg), seg).toMatch(/registered_at\s+IS\s+NOT\s+NULL/i);
  });

  it('M64 (total_final_release) only when total_tat_seconds is present (every report family final); M63 (first release) does not require it', async () => {
    const br = norm((await replaceCalls('tat')).calls[2]!.text).split(/\bUNION\s+ALL\b/i);
    expect(br.find((b) => b.includes("'total_final_release'"))).toMatch(/total_tat_seconds\s+IS\s+NOT\s+NULL/i);
    expect(br.find((b) => b.includes("'total_first_release'"))).not.toMatch(/total_tat_seconds/i);
  });

  it('order-level segments carry NULL priority / specimen type (not in the view)', async () => {
    const br = norm((await replaceCalls('tat')).calls[2]!.text).split(/\bUNION\s+ALL\b/i);
    for (const seg of ['total_first_release', 'total_final_release']) {
      expect(br.find((b) => b.includes(`'${seg}'`))).toMatch(/NULL\s*,\s*NULL\s*,\s*NULL/i);
    }
  });
});

describe('replacePartition: family-specific rules', () => {
  const insertOf = async (family: Family) => norm((await replaceCalls(family)).calls.find((c) => /^\s*INSERT/i.test(c.text))!.text);

  it('specimens: aggregated from lab.v_pub_specimen_timeline by collected/received/rejected local day; primary specimens only (aliquots excluded, M73)', async () => {
    const t = await insertOf('specimens');
    expect(t).toMatch(/collected_at/i); expect(t).toMatch(/received_at/i); expect(t).toMatch(/rejected_at/i);
    expect(t.match(/parent_specimen_id\s+IS\s+NULL/gi)!.length).toBeGreaterThanOrEqual(3);          // one per UNION ALL leg
    expect(t).toMatch(/\bUNION\s+ALL\b/i);
    expect(t).toMatch(/count\s*\(\s*\*\s*\)\s+FILTER\s*\(\s*WHERE\s+k\s*=\s*'c'/i);
    expect(t).toMatch(/GROUP BY/i);
    expect(t).toMatch(/AT TIME ZONE 'Asia\/Kathmandu'/i);
    expect(t).not.toMatch(/AT TIME ZONE '(?!Asia\/Kathmandu)/i);
    expect(t).toMatch(/processing_branch_id/i); expect(t).toMatch(/specimen_type_code/i); expect(t).toMatch(/priority/i);
  });
  it('specimens: range bounds are local midnights as instants: ($n::timestamp AT TIME ZONE \'Asia/Kathmandu\')', async () => {
    const t = await insertOf('specimens');
    expect(t).toMatch(/\$2(::\w+)?\s+AT TIME ZONE 'Asia\/Kathmandu'/i);
    expect(t).toMatch(/\$3(::\w+)?\s+AT TIME ZONE 'Asia\/Kathmandu'/i);
  });

  it('results: straight copy incl. centre_id and tests_approved (CR-C8-004)', async () => {
    const t = await insertOf('results');
    expect(t).toMatch(/\bcentre_id\b/i); expect(t).toMatch(/\btests_approved\b/i);
    expect(t).not.toMatch(/\bGROUP BY\b/i);
  });
  it('critical_values: straight copy incl. centre_id (CR-C8-004)', async () => {
    const t = await insertOf('critical_values');
    expect(t).toMatch(/\bcentre_id\b/i);
    expect(t).not.toMatch(/\bGROUP BY\b/i);
  });

  it('deliveries: copy incl. centre_id; recipient_kind outside the known set is stored as \'other\' and the mapped key is summed (D-3, P-4, D-48)', async () => {
    const t = await insertOf('deliveries');
    expect(t).toMatch(/\bcentre_id\b/i);
    expect(t).toMatch(/CASE\s+WHEN\s+(\w+\.)?recipient_kind\s+IN\s*\(\s*'patient'\s*,\s*'referrer'\s*,\s*'centre'\s*,\s*'partner'\s*,\s*'staff'\s*,\s*'phone_otp'\s*\)\s+THEN\s+(\w+\.)?recipient_kind\s+ELSE\s+'other'\s+END/i);
    expect(t).toMatch(/\bGROUP BY\b/i);
    expect(t).toMatch(/sum\s*\(/i);
    for (const col of ['queued', 'sent', 'delivered', 'failed', 'suppressed']) expect(t).toMatch(new RegExp(`\\b${col}\\b`, 'i'));
    expect(t).toMatch(/"read"|\bread\b/i);
    expect(t).not.toMatch(/\bcommission\b/i);
  });

  it('releases: aggregated per local release day, centre, report_kind, release_basis; addendum kept, unknown future kind stored as amended', async () => {
    const t = await insertOf('releases');
    expect(t).toMatch(/released_at/i);
    expect(t).toMatch(/AT TIME ZONE 'Asia\/Kathmandu'/i);
    expect(t).toMatch(/count\s*\(\s*\*\s*\)/i);
    expect(t).toMatch(/\bGROUP BY\b/i);
    expect(t).toMatch(/'addendum'/i);
    expect(t).toMatch(/CASE[\s\S]*ELSE\s+'amended'/i);
    for (const k of ['final', 'partial', 'preliminary', 'amended']) expect(t).toContain(`'${k}'`);
  });
  it('releases: the range is on the local release day (released_at bounds), not the v_pub row count', async () => {
    const t = await insertOf('releases');
    expect(t).toMatch(/released_at\s*>=\s*\S+[\s\S]*released_at\s*<\s*\S+/i);
    expect(t).toMatch(/\$2(::\w+)?\s+AT TIME ZONE 'Asia\/Kathmandu'/i);
    expect(t).toMatch(/\$3(::\w+)?\s+AT TIME ZONE 'Asia\/Kathmandu'/i);
  });

  it('income / department_income / collections / referrer_billing / orders / centre_volume / referrer_volume / rejections / interface_messages: copy of the view for the date range (no re-derived business date)', async () => {
    for (const f of ['income', 'department_income', 'collections', 'referrer_billing', 'orders', 'centre_volume', 'referrer_volume', 'rejections', 'interface_messages'] as Family[]) {
      const t = await insertOf(f);
      expect(t, f).toMatch(/\bv\.business_date\b|\bbusiness_date\b/i);
      expect(t, f).not.toMatch(/AT TIME ZONE/i);
      expect(t, f).not.toMatch(/\bGROUP BY\b/i);
    }
  });

  it('income carries every IC §6.2 money column (paisa) incl. credit_notes_paisa', async () => {
    const t = await insertOf('income');
    for (const c of ['gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'net_paisa', 'credit_notes_paisa', 'invoices_issued', 'invoices_cancelled', 'branch_id', 'centre_id'])
      expect(t, c).toContain(c);
  });
});

describe('replacePartition(report_backlog): whole-snapshot (§9.2)', () => {
  it('DELETE … WHERE tenant_id = $1 (no date predicate), then INSERT from order_index + order_report_tat + specimen_timeline; no range required', async () => {
    const r = recorder();
    const out = await replacePartition(r.tx, { tenantId: TA, family: 'report_backlog', runId: RUN } as never);
    expect(out).toMatchObject({ rowsWritten: 4 });
    const [del, ...rest] = r.calls.map((c) => norm(c.text));
    expect(del).toMatch(/^DELETE FROM analytics\.report_backlog WHERE tenant_id = \$1\s*$/i);
    expect(r.calls[0]!.values).toEqual([TA]);
    expect(rest).toHaveLength(1);
    const t = rest[0]!;
    expect(t).toMatch(/^INSERT INTO analytics\.report_backlog\b/i);
    for (const rel of SOURCES.report_backlog) expect(rels(t)).toContain(rel);
  });
  it('rules: open orders only (cancelled_at IS NULL), registered within the lookback (default 30 d, bound), already-released excluded, rejected/recollection/discarded specimens ignored', async () => {
    const r = recorder();
    await replacePartition(r.tx, { tenantId: TA, family: 'report_backlog', runId: RUN } as never);
    const c = r.calls[1]!; const t = norm(c.text);
    expect(t).toMatch(/cancelled_at\s+IS\s+NULL/i);
    expect(t).toMatch(/make_interval\s*\(\s*days\s*=>\s*\$\d+\s*\)/i);
    expect(c.values).toContain(30);
    expect(c.values).toContain(RUN);
    expect(t).toMatch(/first_released_at\s+IS\s+NOT\s+NULL/i);
    expect(t).toMatch(/NOT\s+IN\s*\(\s*'rejected'\s*,\s*'recollection_ordered'\s*,\s*'discarded'\s*\)/i);
    expect(t).toMatch(/bool_and\s*\(\s*\w+\.all_approved_at\s+IS\s+NOT\s+NULL/i);
    for (const s of ['awaiting_results', 'ready_unreleased', 'lt_4h', 'h4_24', 'd1_3', 'gt_3d']) expect(t).toContain(`'${s}'`);
    expect(t).toMatch(/min\s*\(\s*o\.registered_at\s*\)/i);
    expect(t).not.toMatch(/AT TIME ZONE '(?!Asia\/Kathmandu)/i);
  });
  it('backlogLookbackDays is honoured and bound (not interpolated)', async () => {
    const r = recorder();
    await replacePartition(r.tx, { tenantId: TA, family: 'report_backlog', runId: RUN, backlogLookbackDays: 45 } as never);
    expect(r.calls[1]!.values).toContain(45);
    expect(r.calls[1]!.text).not.toMatch(/\b45\b/);
  });
  it('a lookback that is not a positive integer is rejected before any statement', async () => {
    for (const d of [0, -1, 1.5, NaN, '30; DROP TABLE x']) {
      const r = recorder();
      await expect(replacePartition(r.tx, { tenantId: TA, family: 'report_backlog', runId: RUN, backlogLookbackDays: d } as never)).rejects.toBeTruthy();
      expect(r.calls).toEqual([]);
    }
  });
});

describe('markDirty (§8.2)', () => {
  it('INSERT … VALUES (tenant, family, date, now(), now(), reason, actor) ON CONFLICT (tenant_id, family, business_date) DO UPDATE SET last_marked_at = now() - first_marked_at is kept', async () => {
    const r = recorder();
    await markDirty(r.tx, { tenantId: TA, family: 'income', businessDate: '2026-11-01', reason: 'event', actorId: ACTOR } as never);
    expect(r.calls).toHaveLength(1);
    const { text, values } = r.calls[0]!; const t = norm(text);
    expect(t).toMatch(/^INSERT INTO analytics\.dirty_partitions\b/i);
    expect(t).toMatch(/ON CONFLICT \(tenant_id, family, business_date\) DO UPDATE SET last_marked_at = now\(\)/i);
    expect(t).not.toMatch(/DO UPDATE SET[^;]*first_marked_at/i);
    expect(t).not.toMatch(/\bFOR\s+UPDATE\b|\bLOCK\b/i);
    expect(values).toEqual(expect.arrayContaining([TA, 'income', '2026-11-01', 'event', ACTOR]));
    expect(text).not.toContain(TA);
  });
  it('report_backlog <-> the snapshot sentinel only (the DB CHECK would otherwise fail at run time)', async () => {
    const ok = recorder();
    await markDirty(ok.tx, { tenantId: TA, family: 'report_backlog', businessDate: SNAPSHOT_DATE, reason: 'sweep_recent', actorId: ACTOR } as never);
    expect(ok.calls).toHaveLength(1);
    for (const bad of [{ family: 'report_backlog', businessDate: '2026-11-01' }, { family: 'income', businessDate: SNAPSHOT_DATE }]) {
      const r = recorder();
      await expect(markDirty(r.tx, { tenantId: TA, reason: 'event', actorId: ACTOR, ...bad } as never)).rejects.toBeTruthy();
      expect(r.calls).toEqual([]);
    }
  });
  it('reason must be one of the dirty_partitions__reason__ck values; family one of the 16; date an ISO date', async () => {
    for (const r of ['event', 'sweep_recent', 'sweep_nightly', 'manual', 'self_check', 'backfill']) {
      const rec = recorder();
      await markDirty(rec.tx, { tenantId: TA, family: 'results', businessDate: '2026-11-01', reason: r, actorId: ACTOR } as never);
      expect(rec.calls).toHaveLength(1);
    }
    for (const bad of [{ reason: 'cron' }, { reason: '' }, { family: 'nope' }, { family: '_manual' }, { businessDate: '2026-02-30' }, { businessDate: 'today' }, { tenantId: 'x' }]) {
      const rec = recorder();
      await expect(markDirty(rec.tx, { tenantId: TA, family: 'results', businessDate: '2026-11-01', reason: 'event', actorId: ACTOR, ...bad } as never)).rejects.toBeTruthy();
      expect(rec.calls).toEqual([]);
    }
  });
});

describe('loadFamilyStates: never_refreshed (PRD §8.5, §9.2, P-22)', () => {
  const dbTx = (state: Record<string, unknown>[], dirty: Record<string, unknown>[]) => {
    const calls: Call[] = [];
    return { calls, tx: { async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (/analytics\.refresh_state/i.test(text)) return { rows: state.filter((r) => r['tenant_id'] === values[0] || r['tenant_id'] === undefined), rowCount: state.length };
      if (/analytics\.dirty_partitions/i.test(text)) return { rows: dirty, rowCount: dirty.length };
      return { rows: [], rowCount: 0 };
    } } as never };
  };
  const NOW = '2026-11-08T06:00:00.000Z';
  const cfg = { staleDirtyMinutes: 20, staleSuccessMinutes: 30 };

  it('a tenant with NO refresh_state rows -> 16 entries, each evaluates to never_refreshed; no write was issued', async () => {
    const { tx, calls } = dbTx([], []);
    const states = await loadFamilyStates(tx, { tenantId: TA } as never);
    expect(states.map((s) => s.family).sort()).toEqual([...FAMILIES].sort());
    for (const s of states) expect(evaluateFreshness(s, NOW as never, cfg)).toMatchObject({ family: s.family, is_stale: true, stale_reason: 'never_refreshed', live: false });
    expect(calls.every((c) => /^\s*SELECT\b/i.test(c.text))).toBe(true);
    expect(calls.every((c) => c.values.includes(TA))).toBe(true);
  });

  it('dirty marks without a refresh_state row stay never_refreshed (lastSuccessAt null) and report the oldest mark', async () => {
    const { tx } = dbTx([], [{ family: 'income', oldest: '2026-11-08T05:00:00.000Z', first_marked_at: '2026-11-08T05:00:00.000Z', min: '2026-11-08T05:00:00.000Z' }]);
    const s = (await loadFamilyStates(tx, { tenantId: TA } as never)).find((x) => x.family === 'income')!;
    expect(s.lastSuccessAt).toBeNull();
    expect(evaluateFreshness(s, NOW as never, cfg).stale_reason).toBe('never_refreshed');
  });

  it('rows map: success -> fresh; last_error_code set -> lastAttemptFailed (refresh_failed); the \'_manual\' throttle row is not a family', async () => {
    const { tx } = dbTx([
      { tenant_id: TA, family: 'income', last_success_at: '2026-11-08T05:55:00.000Z', last_attempt_at: '2026-11-08T05:55:00.000Z', last_error_code: null, consecutive_failures: 0 },
      { tenant_id: TA, family: 'results', last_success_at: '2026-11-08T05:50:00.000Z', last_attempt_at: '2026-11-08T05:58:00.000Z', last_error_code: '57014', consecutive_failures: 2 },
      { tenant_id: TA, family: '_manual', last_success_at: null, last_attempt_at: null, last_error_code: null, consecutive_failures: 0, last_manual_at: '2026-11-08T05:59:00.000Z' },
    ], []);
    const states = await loadFamilyStates(tx, { tenantId: TA } as never);
    expect(states).toHaveLength(16);
    expect(states.some((s) => s.family === '_manual')).toBe(false);
    const by = (f: string) => evaluateFreshness(states.find((s) => s.family === f)!, NOW as never, cfg);
    expect(by('income')).toMatchObject({ is_stale: false });
    expect(by('results')).toMatchObject({ is_stale: true, stale_reason: 'refresh_failed' });
    expect(by('orders')).toMatchObject({ is_stale: true, stale_reason: 'never_refreshed' });
  });
});

describe('orderIndex.repo (§8.2 order_index SQL)', () => {
  const created = { tenantId: TA, orderId: '0190c409-0000-7000-8000-0000000000a1', centreId: '0190c409-0000-7000-8000-0000000000c1', branchId: '0190c409-0000-7000-8000-0000000000b1', referrerId: '0190c409-0000-7000-8000-0000000000d1', registeredAt: '2026-11-07T20:00:00.000Z', eventId: '0190c409-0000-7000-8000-0000000000e1', actorId: ACTOR };

  it('upsertOrderCreated: INSERT … ON CONFLICT (tenant_id, order_id) DO UPDATE … WHERE order_index.registered_on IS NULL (completes a placeholder, never overwrites a complete row)', async () => {
    const r = recorder();
    await upsertOrderCreated(r.tx, created as never);
    expect(r.calls).toHaveLength(1);
    const t = norm(r.calls[0]!.text);
    expect(t).toMatch(/^INSERT INTO analytics\.order_index\b/i);
    expect(t).toMatch(/ON CONFLICT \(tenant_id, order_id\) DO UPDATE/i);
    expect(t).toMatch(/WHERE analytics\.order_index\.registered_on IS NULL\s*;?\s*$/i);
    expect(t).toMatch(/registered_on[\s\S]*AT TIME ZONE 'Asia\/Kathmandu'\s*\)\s*::date/i);       // business date computed in SQL, same expression as the views
    expect(t).toMatch(/interval '400 days'/i);
    expect(t).toMatch(/created_by/i);
    expect(r.calls[0]!.values).toEqual(expect.arrayContaining([TA, created.orderId, created.centreId, created.branchId, created.referrerId, created.registeredAt, created.eventId, ACTOR]));
    expect(r.calls[0]!.text).not.toContain(created.orderId);
    expect(t).not.toMatch(/DO UPDATE SET[^;]*(cancelled_at|created_by|source_event_id)/i);       // a late created event does not touch these
  });

  it('recordOrderCancelled: UPDATE … SET cancelled_at WHERE tenant_id, order_id AND cancelled_at IS NULL; a row matched -> no placeholder', async () => {
    const r = recorder({ rowsFor: () => ({ rowCount: 1 }) });
    const out = await recordOrderCancelled(r.tx, { tenantId: TA, orderId: created.orderId, cancelledAt: '2026-11-08T01:00:00.000Z', eventId: created.eventId, actorId: ACTOR } as never);
    expect(r.calls).toHaveLength(1);
    expect(norm(r.calls[0]!.text)).toMatch(/^UPDATE analytics\.order_index SET cancelled_at = \$\d+ WHERE tenant_id = \$\d+ AND order_id = \$\d+ AND cancelled_at IS NULL/i);
    expect(out).toMatchObject({ placeholder: false });
  });

  it('recordOrderCancelled: no row (cancel-before-create) -> placeholder INSERT with NULL registered_at/registered_on, 400 d expiry, ON CONFLICT (tenant_id, order_id) DO NOTHING', async () => {
    const r = recorder({ rowsFor: (t) => ({ rowCount: /^\s*UPDATE/i.test(t) ? 0 : 1 }) });
    const out = await recordOrderCancelled(r.tx, { tenantId: TA, orderId: created.orderId, cancelledAt: '2026-11-08T01:00:00.000Z', eventId: created.eventId, actorId: ACTOR } as never);
    expect(r.calls).toHaveLength(2);
    const t = norm(r.calls[1]!.text);
    expect(t).toMatch(/^INSERT INTO analytics\.order_index\b/i);
    expect(t).toMatch(/ON CONFLICT \(tenant_id, order_id\) DO NOTHING/i);
    expect(t).toMatch(/interval '400 days'/i);
    expect(t).not.toMatch(/registered_at\s*,|registered_on\s*,/i);                                // left NULL
    expect(r.calls[1]!.values).toEqual(expect.arrayContaining([TA, created.orderId, created.eventId, ACTOR]));
    expect(out).toMatchObject({ placeholder: true });
  });

  it('ids and timestamps are validated before any statement', async () => {
    for (const bad of [{ tenantId: 'x' }, { orderId: "'; DROP TABLE x;--" }, { registeredAt: 'yesterday' }]) {
      const r = recorder();
      await expect(upsertOrderCreated(r.tx, { ...created, ...bad } as never)).rejects.toBeTruthy();
      expect(r.calls).toEqual([]);
    }
  });
});
