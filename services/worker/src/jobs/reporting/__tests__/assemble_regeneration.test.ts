// C6-T41 — assembly half of R9 regenerateReport: 02-TRD §4.5 rule 0 (08 A13 D-33), §6.3 R9 ("store reason_code/reason_text for the next version"),
// 05-SCHEMA report_versions.regeneration_reason_code/_text; AC-02.6, AC-06.9 (kind), E8.
// ASSUMED contract (spec gives none; repeated in .orchestra/notes/C6-T41-tests.md): the R9 handler enqueues `reporting.assemble_report` with
//   payload { tenant_id, report_id, regeneration: { reason_code, reason_text? } }; the task reads it, passes { regeneration: { reasonCode } } +
//   earlierReleased to versionKind (domain/version.ts), appends regenerationNote(...) to snapshot.amendmentNotes, and stores the reason on the
//   version it inserts (regeneration_reason_code / _text). A payload without `regeneration` behaves exactly as before (T08).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANT_A } from './consumers.helpers.js';
import { LAB, HASH_2, ITEM, PORTAL_ORIGIN, build, expectedFingerprint, setup, snapshotOf, versionRow, type Setup } from './assemble.helpers.js';

beforeEach(() => { vi.stubEnv('LIMS_ORIGIN_PORTAL', PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });

const readyKeys = ['urine', 'ratio', 'out'] as const;
const released = () => versionRow(1, { status: 'released', released_at: '2026-11-07T10:30:00.000Z', release_basis: 'zero_balance', release_mode: 'auto', audiences: ['patient'], content_fingerprint: expectedFingerprint(readyKeys) });
const regen = (reason_code: string, reason_text?: string) => ({ tenant_id: TENANT_A, report_id: LAB, regeneration: { reason_code, ...(reason_text !== undefined ? { reason_text } : {}) } });
/** counter 1 = what R9 leaves behind (changes the fingerprint, TRD §4.2). */
const world = (o: NonNullable<Parameters<typeof setup>[0]> = {}) => setup({ reportOver: { regeneration_counter: 1 }, ...o });
const go = async (s: Setup, payload: unknown) => { const h = await build(s); await s.run(h, payload); };

describe('rule 0: Regenerate after a release -> amended with a "Report details" note (AC-02.6, E8)', () => {
  it.each(['demographic_correction', 'referrer_correction', 'template_correction', 'other'])('reason %s -> v2 amended, v1 stays released', async (code) => {
    const s = world({ versions: [released()] }); await go(s, regen(code, 'Synthetic: corrected after release'));
    const [v1, v2] = s.versions(); expect(s.versions()).toHaveLength(2);
    expect(v2).toMatchObject({ version_no: 2, status: 'rendering', report_kind: 'amended' }); expect(v1).toMatchObject({ status: 'released' });
    expect(snapshotOf(v2!)).toMatchObject({ reportKind: 'amended', statusLabel: 'Amended' });
  });
  it('the reason is stored on the new version (code + text) and nowhere on the released one', async () => {
    const s = world({ versions: [released()] }); await go(s, regen('demographic_correction', 'Synthetic: surname spelling'));
    const [v1, v2] = s.versions();
    expect(v2).toMatchObject({ regeneration_reason_code: 'demographic_correction', regeneration_reason_text: 'Synthetic: surname spelling' });
    expect(v1!['regeneration_reason_code'] ?? null).toBeNull(); expect(v1!['regeneration_reason_text'] ?? null).toBeNull();
  });
  it('amendmentNotes gets ONE entry with analyteOrSection "Report details" naming the reason code and text (so the AMENDED REPORT box shows it)', async () => {
    const s = world({ versions: [released()] }); await go(s, regen('other', 'Synthetic: footer wording'));
    const notes = snapshotOf(s.versions()[1]!).amendmentNotes as any[]; const mine = notes.filter((n) => n.analyteOrSection === 'Report details');
    expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ reasonCode: 'other', reasonText: 'Synthetic: footer wording' });
  });
  it('without reason_text the note carries the code only', async () => {
    const s = world({ versions: [released()] }); await go(s, regen('template_correction'));
    const n = (snapshotOf(s.versions()[1]!).amendmentNotes as any[]).find((x) => x.analyteOrSection === 'Report details');
    expect(n).toMatchObject({ reasonCode: 'template_correction' }); expect(n.reasonText ?? null).toBeNull();
  });
  it('the amended v2 content matches the live data: the fresh patient name is read at assembly (E8)', async () => {
    const s = setup({ versions: [released()], reportOver: { regeneration_counter: 1 }, patientName: 'Test Patient 0043' }); await go(s, regen('demographic_correction'));
    expect(s.report()['patient_display_name']).toBe('Test Patient 0043'); expect(JSON.stringify(snapshotOf(s.versions()[1]!))).toContain('Test Patient 0043');
  });
  it('fingerprint of v2 = demographics counter 1 (TRD §4.2); an identical re-run does not create a v3', async () => {
    const s = world({ versions: [released()] }); const h = await build(s); await s.run(h, regen('other', 'x'));
    expect(s.versions()[1]!['content_fingerprint']).toBe(expectedFingerprint(readyKeys, 1));
    s.db.store['reporting.reports']!.find((r) => r['id'] === LAB)!['needs_assembly'] = true; await s.run(h, regen('other', 'x'));
    expect(s.versions()).toHaveLength(2);
  });
  it('an older UNRELEASED version is discarded as superseded_unreleased, the released one is not', async () => {
    const s = world({ versions: [released(), versionRow(2, { status: 'rendered', held_basis: 'due_outstanding', content_fingerprint: 'f'.repeat(64) })] }); await go(s, regen('other', 'x'));
    const st = Object.fromEntries(s.versions().map((v) => [v['version_no'], v['status']])); expect(st).toEqual({ 1: 'released', 2: 'discarded', 3: 'rendering' });
    expect(s.versions()[2]!['report_kind']).toBe('amended');
  });
});

describe('smart_summary_added keeps the kind of rules 1-4 (D-33)', () => {
  it('complete report -> final (not amended), reason still stored, no AMENDED label', async () => {
    const s = world({ versions: [released()] }); await go(s, regen('smart_summary_added'));
    const v2 = s.versions()[1]!; expect(v2).toMatchObject({ report_kind: 'final', regeneration_reason_code: 'smart_summary_added' });
    expect(snapshotOf(v2)).toMatchObject({ reportKind: 'final', statusLabel: 'Final' });
  });
  it('partial report -> partial', async () => {
    const s = world({ versions: [released()], completeness: 'partial', partialReleaseAllowed: true, ready: { out: false } });
    s.db.store['reporting.report_versions']![0]!['content_fingerprint'] = expectedFingerprint(['urine', 'ratio']);
    await go(s, regen('smart_summary_added')); expect(s.versions()[1]).toMatchObject({ report_kind: 'partial', completeness: 'partial' });
  });
  it('an amendment that rules 1-4 would call amended stays amended', async () => {
    const s = world({ versions: [released()], amend: true, hash: HASH_2, containsAmendment: true }); await go(s, regen('smart_summary_added'));
    expect(s.versions()[1]).toMatchObject({ report_kind: 'amended' });
  });
});

describe('no earlier release / no regeneration -> unchanged T08 behaviour', () => {
  it('regeneration before any release is not an amendment: final (the reason is still recorded)', async () => {
    const s = world(); await go(s, regen('demographic_correction', 'Synthetic: early fix'));
    expect(s.versions()).toHaveLength(1); expect(s.versions()[0]).toMatchObject({ report_kind: 'final', regeneration_reason_code: 'demographic_correction' });
    expect(snapshotOf(s.versions()[0]!)).toMatchObject({ reportKind: 'final', statusLabel: 'Final' });
  });
  it('a plain re-assembly after a release (new approved set, no regeneration in the payload) is NOT forced to amended and stores no reason', async () => {
    const s = setup({ hash: HASH_2, versions: [released()] }); await go(s, { tenant_id: TENANT_A, report_id: LAB });
    const v2 = s.versions()[1]!; expect(v2['report_kind']).toBe('final'); expect(v2['regeneration_reason_code'] ?? null).toBeNull(); expect(v2['regeneration_reason_text'] ?? null).toBeNull();
    expect((snapshotOf(v2).amendmentNotes as any[] | undefined ?? []).filter((n) => n.analyteOrSection === 'Report details')).toHaveLength(0);
  });
  it('first assembly (no versions yet, payload without regeneration) stores no reason', async () => {
    const s = setup(); await go(s, { tenant_id: TENANT_A, report_id: LAB }); expect(s.versions()[0]!['regeneration_reason_code'] ?? null).toBeNull();
  });
});

describe('KNOWN GAP (review C6-T41 #1, CR pending): keyed job `assemble:<report_id>` is replaced by a later producer', () => {
  // add_job job_key_mode=replace: a consumers/narrative-sign/sweep enqueue that lands before the worker runs overwrites the R9 payload.
  // This pins TODAY's behaviour (reason lost, counter already bumped). Flip the expectations when the CR ruling (durable pending reason or merge) lands.
  it('replaced payload (no `regeneration`) after a release: v2 is NOT amended, no "Report details" note, no stored reason', async () => {
    const s = world({ versions: [released()] }); await go(s, { tenant_id: TENANT_A, report_id: LAB });
    const v2 = s.versions()[1]!;
    expect(v2['report_kind']).not.toBe('amended'); expect(v2['regeneration_reason_code'] ?? null).toBeNull();
    expect((snapshotOf(v2).amendmentNotes as any[] | undefined ?? []).filter((n) => n.analyteOrSection === 'Report details')).toHaveLength(0);
  });
});

describe('hostile payloads', () => {
  it.each([
    ['reason_code not a string', { reason_code: 7 }], ['reason_code too long', { reason_code: 'a'.repeat(65) }], ['reason_text too long', { reason_code: 'other', reason_text: 'x'.repeat(501) }],
    ['regeneration is a string', 'other'],
  ])('%s -> no version carries a bogus reason (rejected or ignored), never a crash that leaves needs_assembly stuck unexplained', async (_n, regeneration) => {
    const s = world({ versions: [released()] }); const h = await build(s);
    await s.run(h, { tenant_id: TENANT_A, report_id: LAB, regeneration }).catch(() => undefined);
    for (const v of s.versions()) { expect(String(v['regeneration_reason_code'] ?? '').length).toBeLessThanOrEqual(64); expect(String(v['regeneration_reason_text'] ?? '').length).toBeLessThanOrEqual(500); }
    expect(s.versions().filter((v) => v['regeneration_reason_code'] === 'a'.repeat(65))).toHaveLength(0);
  });
  it('a payload naming another tenant is skipped as before (no version, no write)', async () => {
    const s = world({ versions: [released()] }); const h = await build(s); await s.run(h, { ...regen('other', 'x'), tenant_id: '0190a000-0000-7000-8000-00000000bbbb' });
    expect(s.versions()).toHaveLength(1); expect(s.db.writes()).toHaveLength(0);
  });
  it('item ids of the new version are unchanged by a regeneration (same ready set)', async () => {
    const s = world({ versions: [released()] }); await go(s, regen('other', 'x'));
    expect([...s.versions()[1]!['order_item_ids']].sort()).toEqual([ITEM.urine, ITEM.ratio, ITEM.out].sort());
  });
});
