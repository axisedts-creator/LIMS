// C6-T08 — task `reporting.assemble_report` (02-TRD §4.2/§4.3/§9; 01-PRD AC-02.1–02.6; 03-APP-FLOW V1; 07-SECURITY T1/T3/P-13).
// ASSUMED contract (spec gives none): ../tasks/assemble_report.ts exports createAssembleReport({ sandbox:{ sanitize(bytes) } }) -> TaskHandler
//   (same shape as createProcessInputFile; the /internal/sanitize reply is 02-TRD §5.2). payload = { tenant_id, report_id }.
//   ctx = JobContext + ports{lab,frontdesk,catalog,identity,smartreport?} (T06 AssemblyCtx) + core.centre + storage.read(bucket,path) + metrics.inc.
//   Portal origin for the QR URL comes from env LIMS_ORIGIN_PORTAL (02-TRD §10): verifyUrl = `<origin>/v/<token>`.
//   SQL must stay in the T04 fake's dialect (single-table statements, `$n` params; ORDER BY/LIMIT/FOR UPDATE allowed) — see assemble.helpers.ts.
// Real PG / RLS / triggers are not available here: the "concurrency" proof is the row-lock emulation (FOR UPDATE on reporting.reports) + unique key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../../../../../api/src/modules/reporting/domain/tokens.js';
import { handle as readyForReport } from '../consumers/lab.order.ready_for_report.v1.js';
import { readyForReport as readyEvent, TENANT_A, TENANT_B, type Row } from './consumers.helpers.js';
import {
  ATT_BUCKET, ATT_PATH, ATT_BYTES, EMAIL, FULL_NAME, HASH_2, I, ITEM, LAB, MASKED_NAME, NARR, OUT_FILE, PARTNER, PHONE, PORTAL_ORIGIN, SAN_BYTES,
  TEMPLATE_VERSION, build, expectedFingerprint, hex, idN, sandboxOk, setup, settle, sha256, snapshotOf, tokenOf, versionRow, type Setup, type WorldOpts,
} from './assemble.helpers.js';

beforeEach(() => { vi.stubEnv('LIMS_ORIGIN_PORTAL', PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });

const go = async (s: Setup) => { const h = await build(s); await s.run(h); return h; };
/** Loads the task first (a missing module must FAIL the test, never count as an expected rejection), then runs it and returns 'ok' or the error. */
const attempt = async (s: Setup) => { const h = await build(s); return settle(s.run(h)); };
const writes = (s: Setup) => s.db.writes();
const stable = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const readyKeys = ['urine', 'ratio', 'out'] as const;

describe('AC-02.1 — all items ready -> one frozen version (rendering) with QR token', () => {
  it('inserts exactly one version: rendering / final / complete, frozen snapshot + sha, ready item ids, template, copies of patient_id/partner_id', async () => {
    const s = setup(); await go(s);
    const vs = s.versions(); expect(vs).toHaveLength(1);
    const v = vs[0]!; const snap = snapshotOf(v);
    expect(v).toMatchObject({ tenant_id: TENANT_A, report_id: LAB, order_id: I.order, centre_id: I.centre, version_no: 1, status: 'rendering', report_kind: 'final', completeness: 'complete',
      patient_id: I.patient, partner_id: PARTNER, template_version_id: TEMPLATE_VERSION, approved_set_hash: 'a'.repeat(64) });
    expect([...v['order_item_ids']].sort()).toEqual([ITEM.urine, ITEM.ratio, ITEM.out].sort());
    expect(snap).toMatchObject({ schemaVersion: 1, family: 'laboratory', reportKind: 'final', statusLabel: 'Final' });
    expect(snap.sections.length).toBeGreaterThan(0);
    expect(v['content_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect([sha256(JSON.stringify(snap)), sha256(stable(snap))]).toContain(v['content_sha256']);   // sha of the frozen snapshot (plain or key-sorted JSON)
    expect(v['reported_at']).toBeTruthy(); expect(v['created_by']).toBe(idN(0xa009));
  });
  it('content_fingerprint = SHA-256 of the sorted ready-item lines + |demog:<counter> (TRD §4.2)', async () => {
    const s = setup(); await go(s);
    expect(s.versions()[0]!['content_fingerprint']).toBe(expectedFingerprint(readyKeys));
  });
  it('QR token: 128-bit URL-safe token only in snapshot.qr.verifyUrl; qr_tokens row stores SHA-256(token) (32 bytes) + minimal snapshots', async () => {
    const s = setup(); await go(s);
    const v = s.versions()[0]!; const snap = snapshotOf(v); const token = tokenOf(snap);
    expect(snap.qr.verifyUrl).toBe(`${PORTAL_ORIGIN}/v/${token}`); expect(token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const rows = s.qr(); expect(rows).toHaveLength(1); const q = rows[0]!;
    expect(q).toMatchObject({ tenant_id: TENANT_A, report_id: LAB, report_version_id: v['id'], centre_id: I.centre });
    expect(hex(q['token_sha256'])).toBe(hex(hashToken(token))); expect(Buffer.from(q['token_sha256']).length).toBe(32);
    expect(q['patient_display_snapshot']).toBe(MASKED_NAME); expect(String(q['patient_display_snapshot']).length).toBeLessThanOrEqual(60);   // portal_display, never the full name
    expect(q['lab_name_snapshot']).toBe('Synthetic Labs'); expect(Array.isArray(q['panel_names_snapshot'])).toBe(true); expect(q['panel_names_snapshot'].length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(q)).not.toContain(token); expect(JSON.stringify(q)).not.toContain(FULL_NAME);
    expect(s.ports.calls.demographics.map((c) => c.purpose).sort()).toEqual(['portal_display', 'report_render']);
    expect(JSON.stringify({ ...v, content_snapshot: null }).includes(token)).toBe(false);          // the raw token is nowhere else on the version row
    expect(JSON.stringify(snap).split(token).length - 1).toBe(1);                                  // exactly once in the snapshot
  });
  it('a second version gets a different token', async () => {
    const s = setup(); const h = await go(s);
    s.db.store['reporting.reports']!.find((r) => r['id'] === LAB)!['regeneration_counter'] = 1; s.db.store['reporting.reports']!.find((r) => r['id'] === LAB)!['needs_assembly'] = true;
    await s.run(h); const [a, b] = s.versions().map(snapshotOf); expect(tokenOf(a)).not.toBe(tokenOf(b));
  });
  it('report row: latest_version_no = 1, needs_assembly cleared in the same tx, report snapshots refreshed (patient_display_name, referrer_name)', async () => {
    const s = setup({ reportOver: { patient_display_name: 'Stale Name', referrer_name: 'Stale Referrer' } }); await go(s);
    expect(s.report()).toMatchObject({ latest_version_no: 1, needs_assembly: false, needs_assembly_since: null, patient_display_name: FULL_NAME, referrer_name: 'Dr. Synthetic Referrer' });
    expect(s.ports.calls.referrer[0]).toMatchObject({ referrerId: I.referrer, purpose: 'display' });
    expect(s.report().released_version_no ?? null).toBeNull();
  });
  it('enqueues exactly one render task for the new version (max_attempts 5), carrying tenant + version id', async () => {
    const s = setup(); await go(s);
    const jobs = s.renderJobs(); expect(jobs).toHaveLength(1);
    expect(jobs[0]!.maxAttempts).toBe(5); expect(JSON.stringify(jobs[0]!.payload)).toContain(s.versions()[0]!['id']); expect(jobs[0]!.payload.tenant_id).toBe(TENANT_A);
  });
  it('removed items are neither in order_item_ids nor in the fingerprint; the report is still complete', async () => {
    const s = setup({ removedItem: true }); await go(s);
    const v = s.versions()[0]!; expect(v['order_item_ids']).not.toContain(ITEM.removed); expect(v['completeness']).toBe('complete'); expect(v['content_fingerprint']).toBe(expectedFingerprint(readyKeys));
  });
  it('confirmed outsourced file goes into the snapshot (sanitised hash + page count), not the original', async () => {
    const s = setup(); await go(s);
    expect(snapshotOf(s.versions()[0]!).outsourcedAttachments).toEqual([expect.objectContaining({ inputFileId: OUT_FILE, externalLabName: 'Synthetic Reference Lab', pageCount: 3, sha256: 'd'.repeat(64) })]);
  });
  it('outsourced file uploaded but not confirmed -> item not ready -> no version (partialReleaseAllowed = false)', async () => {
    const s = setup({ outFile: 'ready', ready: { out: false }, completeness: 'complete' }); await go(s);
    expect(s.versions()).toHaveLength(0);
  });
  it('a withdrawn outsourced file never counts as ready', async () => {
    const s = setup({ outFile: 'withdrawn', ready: { out: false } }); await go(s); expect(s.versions()).toHaveLength(0);
  });
  it('smart section: SmartReportPort is not called while the tenant feature flag is off; all three smart columns stay NULL', async () => {
    const s = setup(); await go(s);
    expect(s.ports.calls.smart).toHaveLength(0);
    const v = s.versions()[0]!; expect(v['smart_summary_json'] ?? null).toBeNull(); expect(v['smart_summary_id'] ?? null).toBeNull(); expect(v['smart_summary_version'] ?? null).toBeNull();
  });
  it('smart flag on + port throws smartreport.feature_disabled -> section omitted, version still created, columns NULL (TRD §4.3)', async () => {
    const s = setup({ smartFlag: true }); await go(s);
    expect(s.versions()).toHaveLength(1); expect(s.versions()[0]!['smart_summary_json'] ?? null).toBeNull(); expect(snapshotOf(s.versions()[0]!).smart).toBeUndefined();
  });
  // TRD §4.3 (08 A19 P-44): buildSummary runs inside a SAVEPOINT so whatever the port wrote before throwing smartreport.* is rolled back before the version commits.
  const MARK = 'smart_port_write_marker';
  const portWritesThenThrows = (s: Setup, err: Error) => {
    (s.ports.ports as any).smartreport.buildSummary = async (c: any, i: unknown) => {
      s.ports.calls.smart.push(i);
      await c.tx.query('SELECT id FROM reporting.reports WHERE tenant_id = $1 AND id = $2', [TENANT_A, LAB, MARK]);
      throw err;
    };
  };
  const idx = (s: Setup, re: RegExp) => s.db.stmts.findIndex((x) => re.test(x.text));
  it('smart flag on + port writes then throws smartreport.* -> SAVEPOINT before the port call, ROLLBACK TO SAVEPOINT before the version INSERT; version created, smart columns NULL', async () => {
    const s = setup({ smartFlag: true }); portWritesThenThrows(s, Object.assign(new Error('boom'), { code: 'smartreport.template_missing' })); await go(s);
    expect(s.ports.calls.smart).toHaveLength(1);
    const sp = idx(s, /^savepoint\b/i); const port = s.db.stmts.findIndex((x) => x.values.includes(MARK));
    const rb = idx(s, /^rollback to savepoint\b/i); const ins = idx(s, /^insert into reporting\.report_versions\b/i);
    expect(sp).toBeGreaterThanOrEqual(0); expect(port).toBeGreaterThan(sp); expect(rb).toBeGreaterThan(port); expect(ins).toBeGreaterThan(rb);
    expect(s.versions()).toHaveLength(1); const v = s.versions()[0]!;
    expect(v['smart_summary_json'] ?? null).toBeNull(); expect(v['smart_summary_id'] ?? null).toBeNull(); expect(v['smart_summary_version'] ?? null).toBeNull();
    expect(snapshotOf(v).smart).toBeUndefined();
  });
  it('smart flag on + port writes then throws a NON smartreport.* error -> rolled back to the savepoint and the task rejects (no version)', async () => {
    const s = setup({ smartFlag: true }); portWritesThenThrows(s, Object.assign(new Error('db down'), { code: 'common.unavailable' }));
    expect(await attempt(s)).not.toBe('ok');
    expect(idx(s, /^rollback to savepoint\b/i)).toBeGreaterThan(s.db.stmts.findIndex((x) => x.values.includes(MARK)));
    expect(s.versions()).toHaveLength(0);
  });
});

describe('AC-02.2 — three readiness events inside 30 s -> exactly one version (debounce + fingerprint)', () => {
  it('three ready_for_report events -> ONE keyed job assemble:<report_id>, run ~30 s later; running the (deduped) queue yields ONE version', async () => {
    const s = setup({ ready: { urine: false, ratio: false }, reportOver: { needs_assembly: false, needs_assembly_since: null, lab_ready_seq: null, lab_approved_set_hash: null, lab_completeness: null } });
    const c = s.ctx();
    for (const seq of [1, 2, 3]) {
      await readyForReport(readyEvent(seq, [ITEM.urine, ITEM.ratio], { order_id: I.order }, { aggregate: { type: 'order', id: I.order, seq } }), c);
    }
    const jobs = s.assemblyJobs(); expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.jobKey))).toEqual(new Set([`assemble:${LAB}`]));                              // same key -> the queue keeps ONE (latest) job
    const last = jobs.at(-1)!; expect(Date.parse(String(last.runAt)) - Date.parse(c.now())).toBe(30_000);
    const queue = new Map(jobs.map((j) => [j.jobKey, j])); expect(queue.size).toBe(1);
    const h = await build(s); for (const j of queue.values()) await s.run(h, j.payload);
    expect(s.versions()).toHaveLength(1); expect(s.qr()).toHaveLength(1); expect(s.renderJobs()).toHaveLength(1);
  });
  it('even if the queue ran every duplicate job, the fingerprint keeps it at one version / one QR token / one render job', async () => {
    const s = setup(); const h = await build(s);
    for (let i = 0; i < 3; i++) { await s.run(h); s.db.store['reporting.reports']!.find((r) => r['id'] === LAB)!['needs_assembly'] = true; }
    expect(s.versions()).toHaveLength(1); expect(s.qr()).toHaveLength(1); expect(s.renderJobs()).toHaveLength(1); expect(s.report()['latest_version_no']).toBe(1);
  });
  it('3 tasks started in parallel for the same report -> one version, none rejects (row lock FOR UPDATE on reporting.reports)', async () => {
    const s = setup(); const h = await build(s);
    const out = await Promise.all([1, 2, 3].map(() => settle(s.run(h))));
    expect(out).toEqual(['ok', 'ok', 'ok']); expect(s.versions()).toHaveLength(1); expect(s.qr()).toHaveLength(1); expect(s.renderJobs()).toHaveLength(1);
  });
  it('the report row is locked (SELECT ... FOR UPDATE, tenant + id predicate) BEFORE the first write', async () => {
    const s = setup(); await go(s);
    const stmts = s.db.stmts; const lockAt = stmts.findIndex((x) => /from reporting\.reports\b.*\bfor update\b/i.test(x.text));
    expect(lockAt).toBeGreaterThanOrEqual(0); expect(stmts[lockAt]!.values).toEqual(expect.arrayContaining([TENANT_A, LAB]));
    expect(/tenant_id/i.test(stmts[lockAt]!.text)).toBe(true);
    const firstWrite = stmts.findIndex((x) => ['insert', 'update'].includes(x.verb)); expect(firstWrite).toBeGreaterThan(lockAt);
  });
});

describe('AC-02.3 — same fingerprint as the latest non-discarded version -> no new version', () => {
  const fpAll = expectedFingerprint(readyKeys);
  it('latest version has the same fingerprint -> nothing inserted, no render job, needs_assembly cleared', async () => {
    const s = setup({ versions: [versionRow(1, { content_fingerprint: fpAll })] }); await go(s);
    expect(s.versions()).toHaveLength(1); expect(s.qr()).toHaveLength(0); expect(s.renderJobs()).toHaveLength(0); expect(s.report()).toMatchObject({ needs_assembly: false, latest_version_no: 1 });
    expect(s.db.writes().filter((w) => /insert/i.test(w.verb))).toHaveLength(0);
  });
  it('ports are not asked to build a document when the fingerprint is unchanged (cheap no-op)', async () => {
    const s = setup({ versions: [versionRow(1, { content_fingerprint: fpAll })] }); await go(s);
    expect(s.ports.calls.lab).toHaveLength(0);
  });
  it('a DISCARDED newer version is ignored: compare with the latest non-discarded one (equal -> no v3)', async () => {
    const s = setup({ versions: [versionRow(1, { content_fingerprint: fpAll }), versionRow(2, { status: 'discarded', discard_reason: 'superseded_unreleased', content_fingerprint: sha256('other') })] }); await go(s);
    expect(s.versions().map((v) => v['version_no'])).toEqual([1, 2]);
  });
  it('a discarded version with the SAME fingerprint does not block a new version', async () => {
    const s = setup({ versions: [versionRow(1, { status: 'discarded', discard_reason: 'superseded_unreleased', content_fingerprint: fpAll })] }); await go(s);
    expect(s.versions().map((v) => v['version_no'])).toEqual([1, 2]); expect(s.versions()[1]!['status']).toBe('rendering'); expect(s.report()['latest_version_no']).toBe(2);
  });
  it('different approved_set_hash (new result approval) -> different fingerprint -> new version', async () => {
    const s = setup({ hash: HASH_2, versions: [versionRow(1, { content_fingerprint: fpAll })] }); await go(s);
    expect(s.versions()).toHaveLength(2); expect(s.versions()[1]!['content_fingerprint']).toBe(expectedFingerprint(readyKeys, 0, HASH_2));
  });
  it('regeneration_counter bump changes the fingerprint (|demog:<counter>) -> new version', async () => {
    const s = setup({ reportOver: { regeneration_counter: 1 }, versions: [versionRow(1, { content_fingerprint: fpAll })] }); await go(s);
    expect(s.versions()).toHaveLength(2); expect(s.versions()[1]!['content_fingerprint']).toBe(expectedFingerprint(readyKeys, 1));
  });
});

describe('AC-02.4 — partial readiness + partialReleaseAllowed = true -> partial version with only the ready items', () => {
  const partial: WorldOpts = { ready: { ratio: false, out: false }, outFile: 'none', completeness: 'partial' };
  it('kind partial / completeness partial, order_item_ids = ready items only, snapshot has only that department', async () => {
    const s = setup({ ...partial, partialReleaseAllowed: true }); await go(s);
    const v = s.versions()[0]!; const snap = snapshotOf(v);
    expect(v).toMatchObject({ report_kind: 'partial', completeness: 'partial', status: 'rendering' }); expect(v['order_item_ids']).toEqual([ITEM.urine]);
    expect(snap).toMatchObject({ reportKind: 'partial', statusLabel: 'Partial' });
    expect(snap.sections.map((x: any) => x.departmentName)).toEqual(['Clinical Pathology']);
    expect(JSON.stringify(snap)).not.toContain('BUN/Creatinine ratio');
    expect(v['content_fingerprint']).toBe(expectedFingerprint(['urine']));
    expect(s.ports.calls.settings.flatMap((c) => c.keys ?? [])).toContain('partialReleaseAllowed');
  });
  it('partialReleaseAllowed = false -> no version, needs_assembly cleared (a later event re-arms it)', async () => {
    const s = setup({ ...partial, partialReleaseAllowed: false }); await go(s);
    expect(s.versions()).toHaveLength(0); expect(s.qr()).toHaveLength(0); expect(s.renderJobs()).toHaveLength(0); expect(s.report()['needs_assembly']).toBe(false);
  });
  it('nothing ready at all -> no version even when partial release is allowed', async () => {
    const s = setup({ ready: { urine: false, ratio: false, out: false }, outFile: 'none', partialReleaseAllowed: true }); await go(s);
    expect(s.versions()).toHaveLength(0);
  });
  it('later the rest becomes ready -> a complete final version follows the partial one (the partial stays until discarded by rule V1)', async () => {
    const s = setup({ ...partial, partialReleaseAllowed: true }); const h = await go(s);
    const rows = s.db.store['reporting.report_order_items']!; for (const r of rows) { r['lab_ready'] = r['requires_lab'] ? true : r['lab_ready']; r['outsourced_ready'] = r['requires_outsourced'] ? true : r['outsourced_ready']; }
    s.db.store['reporting.input_files'] = [{ ...(s.db.store['reporting.input_files']?.[0] ?? {}), id: OUT_FILE, tenant_id: TENANT_A, centre_id: I.centre, order_id: I.order, order_item_id: ITEM.out, kind: 'outsourced_pdf', state: 'confirmed',
      external_lab_name: 'Synthetic Reference Lab', sanitized_sha256: 'd'.repeat(64), page_count: 3 }];
    const rep = s.db.store['reporting.reports']!.find((r) => r['id'] === LAB)!; Object.assign(rep, { needs_assembly: true, lab_completeness: 'complete' });
    await s.run(h);
    const vs = s.versions(); expect(vs).toHaveLength(2); expect(vs[1]).toMatchObject({ report_kind: 'final', completeness: 'complete', status: 'rendering' });
    expect(vs[0]).toMatchObject({ status: 'discarded', discard_reason: 'superseded_unreleased' });
  });
});

describe('AC-02.5 — combined mode, narrative unsigned, partialReleaseAllowed = false -> no laboratory version until signed', () => {
  it('lab readiness complete but narrative item unsigned -> no version, no QR token, no render job', async () => {
    const s = setup({ combined: true, ready: { nar: false } }); await go(s);
    expect(s.versions()).toHaveLength(0); expect(s.qr()).toHaveLength(0); expect(s.renderJobs()).toHaveLength(0);
  });
  it('once the narrative is signed the next assembly creates the version, including the narrative item and its version id in the fingerprint', async () => {
    const s = setup({ combined: true, ready: { nar: false } }); const h = await go(s); expect(s.versions()).toHaveLength(0);
    for (const r of s.db.store['reporting.report_order_items']!) if (r['order_item_id'] === ITEM.nar) r['narrative_ready'] = true;
    Object.assign(s.db.store['reporting.narrative_reports']![0]!, { status: 'signed', signed_version_no: 1 });
    Object.assign(s.db.store['reporting.narrative_versions']![0]!, { status: 'signed', signed_by_membership_id: I.m1, signed_at: '2026-11-07T09:30:00.000Z' });
    Object.assign(s.db.store['reporting.reports']!.find((r) => r['id'] === LAB)!, { needs_assembly: true });
    await s.run(h);
    const v = s.versions()[0]!; expect(s.versions()).toHaveLength(1);
    expect(v).toMatchObject({ report_kind: 'final', completeness: 'complete' }); expect(v['order_item_ids']).toContain(ITEM.nar);
    expect(v['content_fingerprint']).toBe(expectedFingerprint(['urine', 'ratio', 'out', 'nar']));
  });
  it('separate mode: the laboratory report ignores the (other report\'s) narrative entirely and completes', async () => {
    const s = setup({ combined: false }); await go(s); expect(s.versions()).toHaveLength(1); expect(s.versions()[0]!['order_item_ids']).not.toContain(ITEM.nar);
  });
});

describe('AC-02.6 — amendment after release -> version 2 is `amended`; supersede happens only at release', () => {
  const released = (extra: Row = {}) => versionRow(1, { status: 'released', released_at: '2026-11-07T10:30:00.000Z', release_basis: 'zero_balance', release_mode: 'auto', audiences: ['patient'], content_fingerprint: expectedFingerprint(readyKeys), ...extra });
  it('v1 released + new approved set with contains_amendment -> v2 amended, supersedes_version_no NOT set, v1 stays released, latest_version_no = 2', async () => {
    const s = setup({ amend: true, hash: HASH_2, containsAmendment: true, versions: [released()] }); await go(s);
    const [v1, v2] = s.versions(); expect(s.versions()).toHaveLength(2);
    expect(v2).toMatchObject({ version_no: 2, status: 'rendering', report_kind: 'amended' }); expect(v2!['supersedes_version_no'] ?? null).toBeNull();
    const snap = snapshotOf(v2!); expect(snap).toMatchObject({ reportKind: 'amended', statusLabel: 'Amended' }); expect(snap.amendmentNotes.length).toBeGreaterThanOrEqual(1);
    expect(v1).toMatchObject({ status: 'released', released_at: '2026-11-07T10:30:00.000Z' }); expect(v1!['superseded_at'] ?? null).toBeNull(); expect(v1!['superseded_by_version_no'] ?? null).toBeNull();
    expect(s.report()).toMatchObject({ latest_version_no: 2, released_version_no: 1, needs_assembly: false });
  });
  it('the same amendment with NO released version is just a final (rule: amended needs an earlier release)', async () => {
    const s = setup({ amend: true, hash: HASH_2, containsAmendment: true }); await go(s); expect(s.versions()[0]).toMatchObject({ report_kind: 'final' });
  });
  it('a released or superseded predecessor is never discarded', async () => {
    const s = setup({ hash: HASH_2, versions: [versionRow(1, { status: 'superseded', released_at: '2026-11-06T10:00:00.000Z', superseded_at: '2026-11-07T08:00:00.000Z', superseded_by_version_no: 2 }), released({ version_no: 2, id: idN(0xc002) })] }); await go(s);
    const st = Object.fromEntries(s.versions().map((v) => [v['version_no'], v['status']])); expect(st).toEqual({ 1: 'superseded', 2: 'released', 3: 'rendering' });
  });
});

describe('amendment/new content while an older version is still held -> older unreleased versions are discarded (V1; TRD §9)', () => {
  it.each(['rendering', 'rendered', 'render_failed'])('unreleased v1 (%s) -> discarded with reason superseded_unreleased + discarded_at', async (status) => {
    const s = setup({ hash: HASH_2, containsAmendment: true, versions: [versionRow(1, { status, held_basis: status === 'rendered' ? 'due_outstanding' : null })] }); await go(s);
    const [v1, v2] = s.versions(); expect(v1).toMatchObject({ status: 'discarded', discard_reason: 'superseded_unreleased' }); expect(v1!['discarded_at']).toBeTruthy();
    expect(v2).toMatchObject({ version_no: 2, status: 'rendering', report_kind: 'final' }); expect(s.report()['latest_version_no']).toBe(2);
  });
  it('only the same tenant + report is touched (another report\'s and another tenant\'s unreleased versions stay)', async () => {
    const other = versionRow(1, { id: idN(0xcf01), report_id: NARR }); const foreign = versionRow(1, { id: idN(0xcf02), tenant_id: TENANT_B, report_id: LAB });
    const s = setup({ hash: HASH_2, rls: false, versions: [versionRow(1), other, foreign] }); await go(s);
    const all = s.db.all('reporting.report_versions'); const by = (i: string) => all.find((v) => v['id'] === i)!;
    expect(by(idN(0xc001))['status']).toBe('discarded'); expect(by(idN(0xcf01))['status']).toBe('rendered'); expect(by(idN(0xcf02))['status']).toBe('rendered');
  });
  it('the discard and the insert are guarded by tenant_id and report_id in the statement text (no blanket UPDATE)', async () => {
    const s = setup({ hash: HASH_2, versions: [versionRow(1)] }); await go(s);
    const u = s.db.writes().find((w) => /update reporting\.report_versions/i.test(w.text) && /discarded/i.test(w.text + JSON.stringify(w.values)));
    expect(u).toBeTruthy(); expect(u!.text).toMatch(/tenant_id\s*=\s*\$\d/i); expect(u!.text).toMatch(/report_id\s*=\s*\$\d/i);
  });
});

describe('instrument PDFs go through /internal/sanitize (08 A13 P-13, review fix #38)', () => {
  const attachments = (s: Setup) => snapshotOf(s.versions()[0]!).instrumentPdfAttachments as any[];
  it('reads ONLY the (bucket, path) pair received from the port output, sanitises the original bytes once, records sha256 + sanitizedSha256', async () => {
    const s = setup({ attachment: true }); await go(s);
    expect(s.storage.reads).toEqual([[ATT_BUCKET, ATT_PATH]]); expect(s.sandbox.calls).toHaveLength(1); expect(Buffer.from(s.sandbox.calls[0]!)).toEqual(Buffer.from(ATT_BYTES));
    expect(attachments(s)).toEqual([expect.objectContaining({ analyteName: 'pH', sha256: sha256(ATT_BYTES), sanitizedSha256: sha256(SAN_BYTES) })]);
    expect(attachments(s)[0].objectRef).toMatchObject({ source: 'instrument_attachment' });
  });
  it('no write ever targets the instruments bucket (read-only), and the snapshot never carries the original/sanitised bytes', async () => {
    const s = setup({ attachment: true }); await go(s);
    expect(s.storage.puts.some((p) => p.bucket === ATT_BUCKET)).toBe(false);
    expect(JSON.stringify(snapshotOf(s.versions()[0]!))).not.toContain(Buffer.from(SAN_BYTES).toString('base64'));
  });
  it('no instrument PDF -> sandbox and storage untouched', async () => {
    const s = setup(); await go(s); expect(s.sandbox.calls).toHaveLength(0); expect(s.storage.reads).toHaveLength(0);
  });
  it('sandbox transport error -> task rejects (retry), NO version, needs_assembly stays set', async () => {
    const s = setup({ attachment: true, sandboxReply: new Error('sandbox down') }); const e = await attempt(s);
    expect(e).toBeInstanceOf(Error); expect(s.versions()).toHaveLength(0); expect(s.report()['needs_assembly']).toBe(true);
  });
  const GIF = new TextEncoder().encode('GIF89a not a pdf');
  it.each([
    ['sandbox rejects the file', { ok: false as const, reason: 'malformed' }, [sha256(ATT_BYTES)]],
    ['reply hash does not match its bytes', { ...sandboxOk(), sha256: 'f'.repeat(64) }, [sha256(ATT_BYTES), 'f'.repeat(64), sha256(SAN_BYTES)]],
    ['reply is not a PDF', sandboxOk(GIF), [sha256(ATT_BYTES), sha256(GIF)]],
  ])('%s -> the raw/unsanitised PDF is never recorded as sanitised', async (_n, reply, bad) => {
    const s = setup({ attachment: true, sandboxReply: reply }); const r = await attempt(s);
    if (r === 'ok') { for (const v of s.versions()) for (const x of (snapshotOf(v).instrumentPdfAttachments ?? []) as any[]) expect(bad).not.toContain(x.sanitizedSha256); }
    else expect(s.versions()).toHaveLength(0);
  });
});

describe('security & robustness (07-SECURITY T1/T3/T4; REQ-SEC-024)', () => {
  it('snapshot keeps PHI minimal: no phone, e-mail or consents; log lines never carry the patient name, phone or QR token', async () => {
    const s = setup(); await go(s);
    const snapStr = JSON.stringify(snapshotOf(s.versions()[0]!)); expect(snapStr).not.toContain(PHONE); expect(snapStr).not.toContain(EMAIL); expect(snapStr).not.toContain('consentTextVersion');
    const log = s.logs.text(); expect(log).not.toContain(FULL_NAME); expect(log).not.toContain(PHONE); expect(log).not.toContain(tokenOf(snapshotOf(s.versions()[0]!)));
    expect(JSON.stringify(s.metrics)).not.toContain(FULL_NAME);
  });
  it('only the two documented demographics purposes are used (report_render, portal_display); a "notification" read would be refused by the port', async () => {
    const s = setup(); await go(s); expect(new Set(s.ports.calls.demographics.map((c) => c.purpose))).toEqual(new Set(['report_render', 'portal_display']));
  });
  it('only the included (ready) items\' results are requested/stored: the order is read with scope approved; unready items never reach the snapshot', async () => {
    const s = setup({ ready: { ratio: false, out: false }, outFile: 'none', partialReleaseAllowed: true, completeness: 'partial' }); await go(s);
    expect(s.ports.calls.lab[0]).toEqual({ orderId: I.order, scope: 'approved' }); expect(JSON.stringify(snapshotOf(s.versions()[0]!))).not.toContain('BUN/Creatinine ratio');
  });
  it('every reporting.* statement names tenant_id (RLS is a second line, not the first)', async () => {
    const s = setup({ rls: false, versions: [versionRow(1, { content_fingerprint: sha256('old') })] }); await go(s);
    const bad = s.db.reportingStmts().filter((x) => !/\btenant_id\b/i.test(x.text)); expect(bad.map((b) => b.text)).toEqual([]);
  });
  it('RLS off: a TENANT_B report with the same id referenced by a TENANT_A job is never read into a version or modified', async () => {
    const s = setup({ rls: false }); const a = s.db.store['reporting.reports']!; const mine = a.find((r) => r['id'] === LAB)!; mine['tenant_id'] = TENANT_B;
    for (const t of ['reporting.report_order_items', 'reporting.input_files', 'reporting.report_template_versions', 'reporting.report_templates', 'reporting.settings']) for (const r of s.db.store[t] ?? []) r['tenant_id'] = TENANT_B;
    const before = structuredClone(mine); await go(s);
    expect(s.versions()).toHaveLength(0); expect(s.db.store['reporting.reports']!.find((r) => r['id'] === LAB)).toEqual(before);
  });
  it('payload tenant != job tenant, missing/invalid report_id, or unknown report -> no ports, no writes, resolves', async () => {
    const s = setup(); const h = await build(s);
    for (const p of [{ tenant_id: TENANT_B, report_id: LAB }, { tenant_id: TENANT_A }, { tenant_id: TENANT_A, report_id: 'not-a-uuid' }, { tenant_id: TENANT_A, report_id: idN(0xdead) }]) await s.run(h, p);
    expect(s.versions()).toHaveLength(0); expect(s.ports.calls.lab).toHaveLength(0); expect(writes(s)).toHaveLength(0);
  });
  it('cancelled report -> no version (V1 requires report open)', async () => {
    const s = setup({ reportOver: { state: 'cancelled', cancelled_at: '2026-11-07T11:00:00.000Z' } }); await go(s); expect(s.versions()).toHaveLength(0);
  });
  it('lab port down -> task rejects, nothing inserted, needs_assembly still set so the retry/sweep picks it up', async () => {
    const s = setup({ labFails: true }); const e = await attempt(s);
    expect(e).toBeInstanceOf(Error); expect(s.versions()).toHaveLength(0); expect(s.qr()).toHaveLength(0); expect(s.report()['needs_assembly']).toBe(true); expect(s.renderJobs()).toHaveLength(0);
  });
  it('stale latest_version_no (v1 already exists): never a second row with version_no 1 (unique key) — a clean v2 or a rejection', async () => {
    const s = setup({ versions: [versionRow(1, { content_fingerprint: sha256('old'), status: 'rendering' })], reportOver: { latest_version_no: 0 } });
    const e = await attempt(s);
    expect(s.versions().filter((v) => v['version_no'] === 1)).toHaveLength(1); if (e !== 'ok') expect(e).toBeInstanceOf(Error);
  });
  it('snapshot stored/hashed after the document is complete: content_sha256 changes when the content changes', async () => {
    const a = setup(); await go(a); const b = setup({ patientName: 'Another Synthetic Patient' }); await go(b);
    expect(a.versions()[0]!['content_sha256']).not.toBe(b.versions()[0]!['content_sha256']);
  });
});
