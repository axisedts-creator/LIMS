// C9 T-12 — repository/review.repo.ts SQL pins + the T-12 extension of repository/run.repo.ts (no database; real-PG behaviour -> db/tests, NOT covered here: RLS, the triggers
// quality.enforce_observation_exclusion / quality.enforce_run_frozen, grants). The fake ReviewRepo in review.helpers.ts implements these contracts, so the predicates that decide
// needs_action, the close-out guard (D-52), the 92-day window and append-only logs are pinned HERE against the real statements.
// Column names = 05-SCHEMA qc_runs / qc_observations / qc_corrective_actions / qc_run_reviews verbatim. Fails now: "Cannot find module ../repository/review.repo.js".
import { describe, expect, it } from 'vitest';
import { createReviewRepo } from '../repository/review.repo.js';
import { createRunRepo } from '../repository/run.repo.js';
import { CA, NOW, OBS, PLN, RUN, TENANT_A, USER, at, idN } from './review.helpers.js';

const SENTINEL = "x'; DROP TABLE quality.qc_runs;--";
function tx(rows: any[] = [{ id: RUN(1), version: 2, run_at: at('06:00:00'), n: 1, exists: true, code: 'recalibration', display: 'Recalibrated', is_active: true, source: 'global' }]) {
  const q: Array<{ text: string; values: unknown[] }> = [];
  return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows }; } } as any };
}
const sql = (t: ReturnType<typeof tx>) => t.q.map((x) => x.text).join('\n;\n');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const repo = createReviewRepo();
const WIN = { from: at('00:00:00', '2026-08-14'), to: at('00:00:00', '2026-11-14') };

const calls: Array<[string, (r: typeof repo, t: any) => Promise<unknown>]> = [
  ['listObservations', (r, t) => r.listObservations(t, TENANT_A, { planId: PLN(1), statuses: ['assigned'], ...WIN, sort: '-observed_at', limit: 50 })],
  ['findObservation', (r, t) => r.findObservation(t, TENANT_A, OBS(1))],
  ['excludeObservation', (r, t) => r.excludeObservation(t, TENANT_A, OBS(1), 1, { excluded_reason_code: 'wrong_material', excluded_comment: 'c', excluded_by: USER, excluded_at: NOW, updated_by: USER })],
  ['listRuns', (r, t) => r.listRuns(t, TENANT_A, { statuses: ['evaluated'], outcomes: ['rejected'], needsAction: true, ...WIN, limit: 50 })],
  ['findRun', (r, t) => r.findRun(t, TENANT_A, RUN(1))],
  ['listRunObservations', (r, t) => r.listRunObservations(t, TENANT_A, RUN(1))],
  ['listCorrectiveActions', (r, t) => r.listCorrectiveActions(t, TENANT_A, RUN(1))],
  ['listReviews', (r, t) => r.listReviews(t, TENANT_A, RUN(1))],
  ['hasLaterAcceptedRun', (r, t) => r.hasLaterAcceptedRun(t, TENANT_A, PLN(1), at('08:30:00'))],
  ['insertCorrectiveAction', (r, t) => r.insertCorrectiveAction(t, TENANT_A, { id: CA(1), tenant_id: TENANT_A, qc_run_id: RUN(1), action_code: 'recalibration', description: 'd', performed_at: at('08:20:00'), performed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER })],
  ['insertReview', (r, t) => r.insertReview(t, TENANT_A, { id: idN(0xc901), tenant_id: TENANT_A, qc_run_id: RUN(1), kind: 'close', comment: 'c', reviewed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER })],
  ['findCode', (r, t) => r.findCode(t, TENANT_A, 'corrective_actions', 'recalibration')],
  // listUserLabels / listMembershipLabels left out (ruling C9.T-12-ruling.md #3): no spec relation for staff names until the directory CR lands
];

describe('every statement: tenant predicate, bind parameters, schema quality only (REQ-SEC-024, REQ-SEC-022)', () => {
  it.each(calls)('%s', async (_n, call) => {
    const t = tx(); await call(repo, t.tx);
    expect(t.q.length).toBeGreaterThan(0);
    for (const s of t.q) {
      expect(s.text, 'tenant predicate').toMatch(/tenant_id\s*=\s*\$\d+/i); expect(s.values).toContain(TENANT_A);
      expect(s.text).not.toMatch(/\blab\./i); expect(s.text).not.toContain(TENANT_A); expect(s.text).not.toMatch(/\bcore\.(memberships|users)\b/i);   // names come from the directory seam, never a cross-schema read (TRD §5.10)
    }
  });
  it('a value given as an id/filter is not interpolated: SENTINEL in planId / reason / comment is bound, never in SQL text', async () => {
    const t = tx();
    await repo.listObservations(t.tx, TENANT_A, { planId: SENTINEL, ...WIN, sort: 'observed_at', limit: 5 }); await repo.listRuns(t.tx, TENANT_A, { planId: SENTINEL, ...WIN, limit: 5 });
    await repo.excludeObservation(t.tx, TENANT_A, SENTINEL, 1, { excluded_reason_code: SENTINEL, excluded_comment: SENTINEL, excluded_by: USER, excluded_at: NOW, updated_by: USER });
    await repo.insertReview(t.tx, TENANT_A, { id: idN(0xc901), tenant_id: TENANT_A, qc_run_id: RUN(1), kind: 'acknowledge', comment: SENTINEL, reviewed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER });
    expect(sql(t)).not.toContain(SENTINEL); expect(t.q.flatMap((x) => x.values)).toContain(SENTINEL);
  });
  it('a row whose tenant_id differs from the argument is refused (no cross-tenant insert through a forged row)', async () => {
    const t = tx(); await expect(repo.insertCorrectiveAction(t.tx, TENANT_A, { id: CA(1), tenant_id: idN(0xb1), qc_run_id: RUN(1), action_code: 'a', description: 'd', performed_at: at('08:20:00'), performed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER })).rejects.toBeTruthy();
    await expect(repo.insertReview(t.tx, TENANT_A, { id: idN(0xc901), tenant_id: idN(0xb1), qc_run_id: RUN(1), kind: 'close', comment: null, reviewed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER })).rejects.toBeTruthy();
    expect(t.q).toEqual([]);
  });
});

describe('append-only logs and the exclusion write', () => {
  it('qc_corrective_actions / qc_run_reviews: the repo only ever INSERTs or SELECTs (no UPDATE, DELETE, TRUNCATE, no ON CONFLICT DO UPDATE)', async () => {
    const t = tx(); for (const [, c] of calls) { try { await c(repo, t.tx); } catch { /* ignore */ } }
    for (const s of t.q) if (/qc_corrective_actions|qc_run_reviews/i.test(s.text)) expect(flat(s.text), s.text).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b|ON\s+CONFLICT/i);
    expect(Object.keys(repo).filter((k) => /^(update|delete|remove)/i.test(k)), 'no mutating method other than exclude/insert exists').toEqual([]);
  });
  it('excludeObservation: UPDATE qc_observations SET only the exclusion columns (status, excluded_*, updated_*, version) WHERE tenant_id AND id AND version = $n; version = version + 1', async () => {
    const t = tx(); await repo.excludeObservation(t.tx, TENANT_A, OBS(2), 4, { excluded_reason_code: 'wrong_material', excluded_comment: null, excluded_by: USER, excluded_at: NOW, updated_by: USER });
    const s = flat(t.q[0]!.text); expect(s).toMatch(/UPDATE quality\.qc_observations/i); expect(s).toMatch(/version\s*=\s*version\s*\+\s*1/i); expect(s).toMatch(/\bversion\s*=\s*\$\d+/i); expect(t.q[0]!.values).toEqual(expect.arrayContaining([OBS(2), 4, 'wrong_material', USER, TENANT_A]));
    const set = /SET (.*?) WHERE/i.exec(s)![1]!; const cols = [...set.matchAll(/\b([a-z_]+)\s*=/gi)].map((m) => m[1]!.toLowerCase());
    for (const c of cols) expect(['status', 'excluded_reason_code', 'excluded_comment', 'excluded_by', 'excluded_at', 'updated_at', 'updated_by', 'version'], c).toContain(c);
    for (const c of ['value', 'mean', 'sd', 'z', 'qc_run_id', 'observed_at', 'plan_id', 'tenant_id']) expect(cols, c).not.toContain(c);
    expect(set).toMatch(/status\s*=\s*'excluded'|status\s*=\s*\$\d+/i);
  });
  it('excludeObservation: a version mismatch (no row returned) -> undefined, not an error; a returned row is passed back', async () => {
    expect(await repo.excludeObservation(tx([]).tx, TENANT_A, OBS(2), 9, { excluded_reason_code: 'x', excluded_comment: null, excluded_by: USER, excluded_at: NOW, updated_by: USER })).toBeUndefined();
    expect(await repo.excludeObservation(tx([{ id: OBS(2), version: 5 }]).tx, TENANT_A, OBS(2), 4, { excluded_reason_code: 'x', excluded_comment: null, excluded_by: USER, excluded_at: NOW, updated_by: USER })).toMatchObject({ id: OBS(2), version: 5 });
  });
  it('a Postgres error from the trigger passes through UNCHANGED (the service maps P0001 immutable_row)', async () => {
    const boom = Object.assign(new Error('immutable_row'), { code: 'P0001' }); const bad = { async query() { throw boom; } } as any;
    await expect(repo.excludeObservation(bad, TENANT_A, OBS(1), 1, { excluded_reason_code: 'x', excluded_comment: null, excluded_by: USER, excluded_at: NOW, updated_by: USER })).rejects.toBe(boom);
  });
  it('insertCorrectiveAction / insertReview: parameterised INSERT into the right table with the 05-SCHEMA columns; ids/time/actor come from the caller', async () => {
    const t = tx(); await repo.insertCorrectiveAction(t.tx, TENANT_A, { id: CA(1), tenant_id: TENANT_A, qc_run_id: RUN(1), action_code: 'recalibration', description: 'd', performed_at: at('08:20:00'), performed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER });
    await repo.insertReview(t.tx, TENANT_A, { id: idN(0xc901), tenant_id: TENANT_A, qc_run_id: RUN(1), kind: 'acknowledge', comment: 'c', reviewed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER });
    const [a, b] = t.q.map((x) => flat(x.text)); expect(a).toMatch(/INSERT INTO quality\.qc_corrective_actions/i); expect(b).toMatch(/INSERT INTO quality\.qc_run_reviews/i);
    for (const c of ['action_code', 'description', 'performed_at', 'performed_by_membership_id', 'created_by']) expect(a, c).toContain(c); for (const c of ['kind', 'comment', 'reviewed_by_membership_id', 'created_by']) expect(b, c).toContain(c);
  });
  it('insert refuses an unknown column (allowlist, not a pass-through of caller keys)', async () => {
    const t = tx(); await expect(repo.insertReview(t.tx, TENANT_A, { id: idN(0xc901), tenant_id: TENANT_A, qc_run_id: RUN(1), kind: 'close', comment: null, reviewed_by_membership_id: idN(0xd2), created_at: NOW, created_by: USER, 'x; DROP TABLE y': 1 })).rejects.toBeTruthy();
    expect(t.q.map((x) => x.text).join('')).not.toContain('DROP TABLE');
  });
});

describe('reads: windows, filters, needs_action, joins', () => {
  it('listObservations: the window is BOUND (from / to as parameters on observed_at), sorted by observed_at in the requested direction with id as tiebreaker, LIMIT bound; status filter uses ANY / IN of bound values', async () => {
    const t = tx(); await repo.listObservations(t.tx, TENANT_A, { statuses: ['assigned', 'excluded'], ...WIN, sort: '-observed_at', limit: 25 }); const s = flat(t.q[0]!.text);
    expect(s).toMatch(/observed_at\s*>=\s*\$\d+/i); expect(s).toMatch(/observed_at\s*<=\s*\$\d+/i); expect(t.q[0]!.values).toEqual(expect.arrayContaining([WIN.from, WIN.to]));
    expect(s).toMatch(/ORDER BY\s+\S*observed_at\s+DESC\s*,\s*\S*id\s+DESC/i); expect(s).toMatch(/LIMIT\s+\$\d+/i); expect(s).toMatch(/status\s*=\s*ANY\s*\(\s*\$\d+|status\s+IN/i);
    const u = tx(); await repo.listObservations(u.tx, TENANT_A, { ...WIN, sort: 'observed_at', limit: 25 }); expect(flat(u.q[0]!.text)).toMatch(/ORDER BY\s+\S*observed_at\s+ASC/i);
  });
  it('listObservations: no statement without the window predicate (an unbounded read is impossible from this method)', async () => {
    const t = tx(); await repo.listObservations(t.tx, TENANT_A, { ...WIN, sort: '-observed_at', limit: 5 }); expect(flat(t.q[0]!.text)).toMatch(/observed_at\s*>=/i);
  });
  it('listRuns: window on run_at, ORDER BY run_at DESC, id DESC, LIMIT bound; needs_action true = outcome rejected AND status <> closed (evaluated); false is the negation', async () => {
    const t = tx(); await repo.listRuns(t.tx, TENANT_A, { needsAction: true, ...WIN, limit: 10 }); const s = flat(t.q[0]!.text);
    expect(s).toMatch(/run_at\s*>=\s*\$\d+/i); expect(s).toMatch(/run_at\s*<=\s*\$\d+/i); expect(s).toMatch(/ORDER BY\s+\S*run_at\s+DESC\s*,\s*\S*id\s+DESC/i); expect(s).toMatch(/LIMIT\s+\$\d+/i);
    expect(s).toMatch(/outcome\s*=\s*'rejected'/i); expect(s).toMatch(/status\s*(<>|!=)\s*'closed'|status\s*=\s*'evaluated'/i);
    const f = tx(); await repo.listRuns(f.tx, TENANT_A, { needsAction: false, ...WIN, limit: 10 }); expect(flat(f.q[0]!.text)).toMatch(/NOT\s*\(|<>|IS DISTINCT FROM/i);
  });
  it('listRuns / findRun return corrective_action_count (a count over qc_corrective_actions of THIS tenant) — the input of needs_action_reason', async () => {
    for (const c of [(t: any) => repo.listRuns(t, TENANT_A, { ...WIN, limit: 5 }), (t: any) => repo.findRun(t, TENANT_A, RUN(1))]) {
      const t = tx(); await c(t.tx); const s = flat(t.q[0]!.text); expect(s).toMatch(/corrective_action_count/i); expect(s).toMatch(/quality\.qc_corrective_actions/i); expect(s).toMatch(/ca\.tenant_id\s*=|\.tenant_id\s*=\s*\w+\.tenant_id/i);
    }
  });
  it('findRun joins the plan\'s CURRENT version for run_window_minutes (the close-out guard needs it)', async () => {
    const t = tx(); await repo.findRun(t.tx, TENANT_A, RUN(1)); const s = flat(t.q[0]!.text); expect(s).toMatch(/run_window_minutes/i); expect(s).toMatch(/qc_plan_versions/i); expect(s).toMatch(/current_version_no/i);
  });
  it('timestamps leave as ISO text with milliseconds (to_char ... "T" ... MS "Z") so run_at comparisons in the service are string/Date exact', async () => {
    const t = tx(); await repo.findRun(t.tx, TENANT_A, RUN(1)); expect(flat(t.q[0]!.text)).toMatch(/to_char\(.*run_at.*AT TIME ZONE 'UTC'.*MS/i);
  });
  it('hasLaterAcceptedRun: SAME plan, outcome IN (accepted, accepted_warning), run_at STRICTLY greater than the bound threshold (D-52: > not >=); returns a boolean: any row back = true, no row = false (statement shape `SELECT 1 ... LIMIT 1`)', async () => {
    const t = tx([{ exists: true, id: RUN(6) }]); const r = await repo.hasLaterAcceptedRun(t.tx, TENANT_A, PLN(1), at('08:30:00')); const s = flat(t.q[0]!.text);
    expect(s).toMatch(/plan_id\s*=\s*\$\d+/i); expect(s).toMatch(/outcome\s+IN\s*\(\s*'accepted'\s*,\s*'accepted_warning'\s*\)/i); expect(s).toMatch(/run_at\s*>\s*\$\d+/i); expect(s).not.toMatch(/run_at\s*>=\s*\$\d+/i);
    expect(t.q[0]!.values).toEqual(expect.arrayContaining([PLN(1), at('08:30:00')])); expect(typeof r).toBe('boolean'); expect(r).toBe(true);
    expect(await repo.hasLaterAcceptedRun(tx([]).tx, TENANT_A, PLN(1), at('08:30:00'))).toBe(false);
  });
  it('hasLaterAcceptedRun does not count incomplete / rejected / collecting runs: the statement names no other outcome', async () => {
    const t = tx([]); await repo.hasLaterAcceptedRun(t.tx, TENANT_A, PLN(1), at('08:30:00')); expect(flat(t.q[0]!.text)).not.toMatch(/'incomplete'|'rejected'|'collecting'/i);
  });
  it('listRunObservations / listCorrectiveActions / listReviews: scoped to the run id, deterministic order (oldest first)', async () => {
    for (const [c, re] of [[(t: any) => repo.listRunObservations(t, TENANT_A, RUN(1)), /ORDER BY\s+\S*observed_at/i], [(t: any) => repo.listCorrectiveActions(t, TENANT_A, RUN(1)), /ORDER BY\s+\S*created_at/i], [(t: any) => repo.listReviews(t, TENANT_A, RUN(1)), /ORDER BY\s+\S*created_at/i]] as const) {
      const t = tx(); await c(t.tx); const s = flat(t.q[0]!.text); expect(s).toMatch(/qc_run_id\s*=\s*\$\d+/i); expect(s).toMatch(re); expect(t.q[0]!.values).toContain(RUN(1));
    }
  });
  it('listCorrectiveActions returns action_display from the coded set (tenant override over global) without a cross-tenant join', async () => {
    const t = tx(); await repo.listCorrectiveActions(t.tx, TENANT_A, RUN(1)); const s = flat(t.q[0]!.text); expect(s).toMatch(/action_display/i); expect(s).toMatch(/cs_corrective_actions/i);
  });
  it('findCode: reads the tenant table and the global table of the SET NAME given (corrective_actions | exclusion_reasons), the code bound; an unknown set is refused, never interpolated', async () => {
    const t = tx(); await repo.findCode(t.tx, TENANT_A, 'exclusion_reasons', 'wrong_material'); const s = flat(t.q[0]!.text); expect(s).toMatch(/cs_exclusion_reasons/i); expect(s).not.toMatch(/cs_corrective_actions/i); expect(t.q[0]!.values).toContain('wrong_material');
    await expect(repo.findCode(tx().tx, TENANT_A, 'x; DROP TABLE y' as any, 'c')).rejects.toBeTruthy();
  });
  it('findObservation: returns the run status of its run via a tenant-scoped join (null when it has none)', async () => {
    const t = tx(); await repo.findObservation(t.tx, TENANT_A, OBS(1)); const s = flat(t.q[0]!.text); expect(s).toMatch(/run_status/i); expect(s).toMatch(/quality\.qc_runs/i);
  });
});

describe('run.repo.ts extension: updateRun can close a run (T-12) but still cannot touch the frozen columns', () => {
  const rr = createRunRepo();
  it('closed_at and closed_by are patchable and cast: status closed + closed_at::timestamptz + closed_by::uuid, version + 1, tenant predicate', async () => {
    const t = tx(); await rr.updateRun(t.tx, TENANT_A, RUN(1), { status: 'closed', closed_at: NOW, closed_by: USER, updated_by: USER }); const s = flat(t.q[0]!.text);
    expect(s).toMatch(/closed_at\s*=\s*\$\d+::timestamptz/i); expect(s).toMatch(/closed_by\s*=\s*\$\d+::uuid/i); expect(s).toMatch(/status\s*=\s*\$\d+::text/i); expect(s).toMatch(/version\s*=\s*version\s*\+\s*1/i); expect(s).toMatch(/tenant_id\s*=\s*\$\d+/i);
    expect(t.q[0]!.values).toEqual(expect.arrayContaining([NOW, USER, 'closed', TENANT_A, RUN(1)]));
  });
  it.each(['outcome', 'rules_violated', 'warning_rules', 'is_complete', 'hold_since', 'last_in_control_run_at', 'run_at', 'plan_id', 'rule_mode', 'tenant_id'])('a close patch that smuggles %s is refused here already (the allowlist is not widened beyond closed_at / closed_by)', async (k) => {
    const t = tx(); await expect(rr.updateRun(t.tx, TENANT_A, RUN(1), { status: 'closed', closed_at: NOW, closed_by: USER, [k]: k === 'outcome' ? 'accepted' : 'x' })).rejects.toBeTruthy(); expect(t.q).toEqual([]);
  });
});
