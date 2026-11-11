// C6-T16 — task reporting.build_bulk_print (02-TRD §9 "R13: sandbox assemble of stored PDFs (<= 200) -> reporting-prints", max_attempts 5; 05-SCHEMA §2.14; 01-PRD AC-12.4).
// Bulk prints merge the STORED canonical pdfs (bucket reports); nothing is re-rendered. Helpers + ASSUMED task API: print.helpers.ts.
import { describe, expect, it } from 'vitest';
import {
  FINAL_PDF, FULL_NAME, PID, PRINTS, REPORTS, TENANT_A, TENANT_B, canonicalBytes, draftVersion, idN, partBytes, printJob, printWorld, releasedVersion, settle, sha, type PrintWorld,
} from './print.helpers.js';

const vids = (ns: number[]) => ns.map((n) => releasedVersion(n)['id'] as string);
const bulkJob = (ns: number[], over: Record<string, unknown> = {}) => printJob(1, { kind: 'bulk', variant: 'letterhead', report_version_ids: vids(ns), ...over });
const mk = (ns: number[], o: Parameters<typeof printWorld>[0] = {}): PrintWorld => printWorld({ versions: ns.map((n) => releasedVersion(n)), prints: [bulkJob(ns)], ...o });

describe('merge of stored pdfs (AC-12.4)', () => {
  it('assembles the stored canonical pdfs of every id IN ORDER of report_version_ids, as main parts with matching sha256; nothing is re-rendered', async () => {
    const ns = [3, 1, 2]; const w = printWorld({ versions: [1, 2, 3].map((n) => releasedVersion(n)), prints: [bulkJob(ns)] }); await w.runBulk();
    expect(w.renderer.calls).toHaveLength(0); expect(w.assembler.calls).toHaveLength(1);
    const parts = w.assembler.calls[0].parts; expect(parts).toHaveLength(3);
    parts.forEach((p: any, k: number) => { expect(p.kind).toBe('main'); expect(Buffer.from(partBytes(p)).equals(Buffer.from(canonicalBytes(ns[k]!)))).toBe(true); expect(p.sha256).toBe(sha(canonicalBytes(ns[k]!))); });
    expect(w.store.reads().filter((r) => r.bucket === REPORTS)).toHaveLength(3);
  });
  it('stores the merged file in reporting-prints under {tenant}/prints/ and marks the print ready (sha256, page_count); not watermarked', async () => {
    const w = mk([1, 2], { assembler: { pageCount: 9 } }); await w.runBulk();
    const puts = w.store.puts(); expect(puts).toHaveLength(1); expect(puts[0]!.bucket).toBe(PRINTS); expect(puts[0]!.path.startsWith(`${TENANT_A}/prints/`)).toBe(true);
    expect(w.print()).toMatchObject({ state: 'ready', object_path: puts[0]!.path, sha256: sha(FINAL_PDF), page_count: 9 }); expect(w.print()!['error_code'] ?? null).toBeNull();
    expect(w.assembler.calls[0].stamp?.markers?.not_released ?? false).toBe(false);
    expect(w.db.writes().every((s) => /reporting\.print_jobs/.test(s.text))).toBe(true); expect(w.db.jobs).toHaveLength(0);
  });
  it('a version that is no longer released at build time is left out of the merge (an unreleased pdf is never bulk printed)', async () => {
    const w = printWorld({ versions: [releasedVersion(1), draftVersion(2), releasedVersion(3)], prints: [bulkJob([1, 2, 3])] }); await w.runBulk();
    const bytes = w.assembler.calls[0].parts.map((p: any) => Buffer.from(partBytes(p)).toString());
    expect(bytes).toEqual([Buffer.from(canonicalBytes(1)).toString(), Buffer.from(canonicalBytes(3)).toString()]);
    expect(w.store.reads().filter((r) => r.path.includes('-v2.pdf'))).toEqual([]);
  });
  it('200 ids are merged (cap of the schema)', async () => {
    const ns = Array.from({ length: 200 }, (_, k) => k + 1); const w = mk(ns); await w.runBulk(); expect(w.assembler.calls[0].parts).toHaveLength(200); expect(w.print()!['state']).toBe('ready');
  });
});

describe('failure contract', () => {
  it('a stored pdf that cannot be read: non-final attempt THROWS (retry), print stays rendering; final attempt commits failed with a stable code', async () => {
    const w = printWorld({ versions: [releasedVersion(1), releasedVersion(2)], prints: [bulkJob([1, 2])], objects: {} }); w.store.objects.delete(`${REPORTS}::${releasedVersion(2)['pdf_object_path']}`);
    expect(await settle(w.runBulk(2))).toBeInstanceOf(Error); expect(w.print()!['state']).toBe('rendering'); expect(w.store.puts()).toHaveLength(0);
    expect(await settle(w.runBulk(5))).toBe('ok'); expect(w.print()).toMatchObject({ state: 'failed' }); expect(w.print()!['error_code']).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
  it('sandbox outage: throws early, failed on the final attempt; the error text (may carry names) is not stored', async () => {
    const err = Object.assign(new Error(`sandbox said ${FULL_NAME}`), { code: 'reporting.render_unavailable' });
    const a = mk([1], { assembler: { error: err } }); const e = await settle(a.runBulk(1)); expect(e).toBeInstanceOf(Error); expect(JSON.stringify({ m: (e as Error).message })).not.toContain(FULL_NAME);
    const b = mk([1], { assembler: { error: err } }); expect(await settle(b.runBulk(5))).toBe('ok'); expect(b.print()).toMatchObject({ state: 'failed', error_code: 'reporting.render_unavailable' }); expect(JSON.stringify(b.print())).not.toContain(FULL_NAME);
  });
  it('a pdf_object_path outside the tenant prefix is never read: permanent failure at once (common.internal), nothing stored', async () => {
    const foreign = releasedVersion(2, { pdf_object_path: `${TENANT_B}/2026/11/x-v2.pdf` });
    const w = printWorld({ versions: [releasedVersion(1), foreign], prints: [bulkJob([1, 2])], objects: { [`${REPORTS}::${foreign['pdf_object_path']}`]: canonicalBytes(99) } });
    expect(await settle(w.runBulk(1))).toBe('ok'); expect(w.print()).toMatchObject({ state: 'failed', error_code: 'common.internal' });
    expect(w.store.reads().filter((r) => r.path.startsWith(`${TENANT_B}/`))).toEqual([]); expect(w.store.puts()).toHaveLength(0);
  });
});

describe('idempotency, payload and tenancy', () => {
  it('a print that is not rendering (ready / failed / expired) is left alone', async () => {
    for (const state of ['ready', 'failed', 'expired']) {
      const w = printWorld({ versions: [releasedVersion(1)], prints: [bulkJob([1], { state })] }); await w.runBulk();
      expect(w.assembler.calls).toHaveLength(0); expect(w.db.writes()).toHaveLength(0); expect(w.store.puts()).toHaveLength(0);
    }
  });
  it.each([[{ tenant_id: TENANT_A, print_job_id: 'nope' }], [{ tenant_id: TENANT_B, print_job_id: PID(1) }], [{ tenant_id: TENANT_A, print_job_id: PID(99) }], [{}]])(
    'bad / foreign / unknown payload %j: skipped, nothing written', async (payload) => {
      const w = mk([1]); await w.runBulk(1, payload as any); expect(w.assembler.calls).toHaveLength(0); expect(w.db.writes()).toHaveLength(0);
    });
  it('another tenant\'s print and versions are invisible even with RLS off (every statement names tenant_id)', async () => {
    const w = printWorld({ rls: false, versions: [releasedVersion(1)], prints: [bulkJob([1], { tenant_id: TENANT_B })] }); await w.runBulk();
    expect(w.assembler.calls).toHaveLength(0); expect(w.db.writes()).toHaveLength(0); expect(w.db.reportingStmts().every((s) => /\btenant_id\b/i.test(s.text))).toBe(true);
    const v = printWorld({ rls: false, versions: [releasedVersion(1, { tenant_id: TENANT_B }), releasedVersion(2)], prints: [bulkJob([1, 2])] }); await settle(v.runBulk(5));
    expect(v.assembler.calls.flatMap((c: any) => c.parts).length).toBeLessThanOrEqual(1); expect(v.db.reportingStmts().every((s) => /\btenant_id\b/i.test(s.text))).toBe(true);
  });
  it('logs carry ids and counts only', async () => {
    const w = mk([1, 2]); await w.runBulk(); expect(w.logs.text()).not.toContain(FULL_NAME); expect(idN(1)).toBeTruthy();
  });
});
