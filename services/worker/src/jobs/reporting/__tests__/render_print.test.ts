// C6-T16 — task reporting.render_print (02-TRD §9 "R10 plain variant, T5 preview": renderer (plain) -> sandbox stamp -> store in reporting-prints (24 h), max_attempts 5;
// 05-SCHEMA §2.14; 01-PRD AC-12.2 plain variant from the same frozen snapshot + template version, AC-12.3 draft "NOT RELEASED", AC-13.1 preview with synthetic data).
// Helpers + ASSUMED task API: print.helpers.ts. Failure contract mirrors render_report_version (T09): retryable on a non-final attempt THROWS, permanent / final attempt commits `failed`.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import {
  DRAFT_CFG, FINAL_PDF, FULL_NAME, I, LAB, NEW_CFG, OLD_CFG, PID, PRINTS, TENANT_A, TENANT_B, TEMPLATE_VERSION, TEMPLATE_VERSION_DRAFT, draftVersion, printJob, printWorld, releasedVersion, settle,
  sha, snapshot, templateInvalid, unavailable, type PrintWorld,
} from './print.helpers.js';

const VID1 = releasedVersion(1)['id'] as string;
const single = (over: Record<string, unknown> = {}) => printJob(1, over);
const noPatientQuery = (w: PrintWorld) => w.db.stmts.filter((s) => /reporting\.(reports|report_versions|report_order_items|input_files)/.test(s.text)).length;

describe('manifest wiring', () => {
  it('reporting.render_print is registered (5 attempts) and the manifest still validates', () => {
    expect(typeof manifest.tasks['reporting.render_print']).toBe('function'); expect(manifest.maxAttempts?.['reporting.render_print']).toBe(5);
    expect(() => validateManifests([manifest])).not.toThrow();
  });
  it('reporting.build_bulk_print is registered (5 attempts)', () => {
    expect(typeof manifest.tasks['reporting.build_bulk_print']).toBe('function'); expect(manifest.maxAttempts?.['reporting.build_bulk_print']).toBe(5);
  });
});

describe('AC-12.2 plain variant of a released version', () => {
  it('renders the SAME frozen snapshot with the version\'s OWN template version config (not the newer published one), variant plain, no watermark override', async () => {
    const w = printWorld({ frozenTemplate: true }); const before = JSON.stringify(w.versions());
    await w.runRender();
    expect(w.renderer.calls).toHaveLength(1);
    const r = w.renderer.calls[0]; const snap = snapshot();
    expect(r).toMatchObject({ template_id: 'lab-report', variant: 'plain', template_version_config: OLD_CFG });
    expect(r.template_version_config).not.toEqual(NEW_CFG);
    expect(r.document).toMatchObject({ header: snap.header, sections: snap.sections, qr: snap.qr, reportKind: snap.reportKind, disclaimers: snap.disclaimers });
    expect(r.watermark_override).toBeUndefined();
    expect(JSON.stringify(w.versions())).toBe(before);                     // the stored version (snapshot, pdf columns) is never touched
  });
  it('never fetches or sends letterhead images (logo / header / footer); signature images are still fetched', async () => {
    const w = printWorld(); await w.runRender();
    expect(w.identity.calls.branding).toEqual([]); expect(w.identity.calls.signature).toContain(I.m1);
    const mimes = Object.values(w.renderer.calls[0].assets ?? {}) as any[]; expect(mimes.length).toBe(1);   // only the one signature image on file
  });
  it('merges the outsourced + instrument pdfs like the canonical report and stamps "Page N Of M" with markers plain=true, not_released=false', async () => {
    const w = printWorld(); await w.runRender();
    expect(w.assembler.calls).toHaveLength(1);
    const a = w.assembler.calls[0]; expect(a.parts.map((p: any) => p.kind)).toEqual(['main', 'outsourced', 'instrument_pdf']);
    expect(a.stamp).toMatchObject({ page_label_format: 'Page {n} Of {m}', markers: { plain: true, not_released: false } });
  });
  it('stores the merged pdf in reporting-prints under {tenant}/prints/ and marks the print ready with its sha256 / page count; no other row and no job is touched', async () => {
    const w = printWorld({ assembler: { pageCount: 5 } }); await w.runRender();
    const puts = w.store.puts(); expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ bucket: PRINTS, opts: expect.objectContaining({ contentType: 'application/pdf' }) }); expect(puts[0]!.path.startsWith(`${TENANT_A}/prints/`)).toBe(true);
    expect(Buffer.from(w.store.objects.get(`${PRINTS}::${puts[0]!.path}`)!).equals(Buffer.from(FINAL_PDF))).toBe(true);
    expect(w.print()).toMatchObject({ state: 'ready', object_path: puts[0]!.path, sha256: sha(FINAL_PDF), page_count: 5 }); expect(w.print()!['error_code'] ?? null).toBeNull();
    expect(w.print()!['expires_at']).toBe(printJob(1)['expires_at']);                // the 24 h expiry set at creation is not extended
    expect(w.db.jobs).toHaveLength(0);
    expect(w.db.writes().every((s) => /reporting\.print_jobs/.test(s.text))).toBe(true);
  });
});

describe('AC-12.3 draft print is watermarked "NOT RELEASED"', () => {
  it.each(['letterhead', 'plain'])('draft + variant %s: renderer gets watermark_override NOT RELEASED, sandbox stamps not_released=true', async (variant) => {
    const w = printWorld({ versions: [draftVersion(1)], prints: [single({ variant, draft_watermark: true })] }); await w.runRender();
    expect(w.renderer.calls[0]).toMatchObject({ template_id: 'lab-report', variant, watermark_override: 'NOT RELEASED' });
    expect(w.assembler.calls[0].stamp.markers).toEqual({ plain: variant === 'plain', not_released: true });
    expect(w.print()).toMatchObject({ state: 'ready', draft_watermark: true });
  });
  it('a letterhead draft still uses the letterhead images (only plain omits them)', async () => {
    const w = printWorld({ versions: [draftVersion(1)], prints: [single({ variant: 'letterhead', draft_watermark: true })] }); await w.runRender();
    expect(w.identity.calls.branding.length).toBeGreaterThan(0);
  });
  it('a released print row WITHOUT draft_watermark is never watermarked, whatever the version status says now', async () => {
    const w = printWorld(); await w.runRender(); expect(w.renderer.calls[0].watermark_override).toBeUndefined(); expect(w.assembler.calls[0].stamp.markers.not_released).toBe(false);
  });
});

describe('AC-13.1 template preview with synthetic data', () => {
  const prev = (over: Record<string, unknown> = {}) => printJob(1, { kind: 'template_preview', report_version_ids: [], template_version_id: TEMPLATE_VERSION_DRAFT, variant: 'letterhead', ...over });
  it.each(['letterhead', 'plain'])('variant %s: renderer asked for template-preview with the DRAFT config and NO document; one main part; ready', async (variant) => {
    const w = printWorld({ prints: [prev({ variant })] }); await w.runRender();
    expect(w.renderer.calls).toHaveLength(1); const r = w.renderer.calls[0];
    expect(r).toMatchObject({ template_id: 'template-preview', variant, template_version_config: DRAFT_CFG }); expect(r.document).toBeUndefined();
    expect(w.assembler.calls[0].parts.map((p: any) => p.kind)).toEqual(['main']); expect(w.assembler.calls[0].stamp.markers).toMatchObject({ plain: variant === 'plain', not_released: false });
    expect(w.print()).toMatchObject({ state: 'ready', sha256: sha(FINAL_PDF) }); expect(w.store.puts()[0]!.path.startsWith(`${TENANT_A}/prints/`)).toBe(true);
  });
  it('touches no patient data: no report / version / input file read, no patient name anywhere in the renderer request, no identity signatory lookup', async () => {
    const w = printWorld({ prints: [prev()] }); await w.runRender();
    expect(noPatientQuery(w)).toBe(0); expect(JSON.stringify(w.renderer.calls)).not.toContain(FULL_NAME); expect(w.identity.calls.signatories).toEqual([]);
  });
  it('a template version that no longer exists -> failed with reporting.template_invalid, nothing stored', async () => {
    const w = printWorld({ prints: [prev({ template_version_id: '0190a000-0000-7000-8000-00000000dead' })] }); await w.runRender();
    expect(w.print()).toMatchObject({ state: 'failed', error_code: 'reporting.template_invalid' }); expect(w.store.puts()).toHaveLength(0); expect(w.renderer.calls).toHaveLength(0);
  });
});

describe('failure contract (like T09)', () => {
  it('renderer unavailable on a non-final attempt: THROWS a sanitised error (queue retry), print stays rendering, nothing stored', async () => {
    const w = printWorld({ rendererReply: unavailable() }); const e = await settle(w.runRender(2));
    expect(e).toBeInstanceOf(Error); expect(JSON.stringify({ m: (e as Error).message, c: (e as any).code })).not.toContain(FULL_NAME);
    expect(w.print()).toMatchObject({ state: 'rendering' }); expect(w.store.puts()).toHaveLength(0);
  });
  it('renderer unavailable on the FINAL attempt: commits failed (reporting.render_unavailable) and resolves; the error text is not stored', async () => {
    const w = printWorld({ rendererReply: unavailable() }); expect(await settle(w.runRender(5))).toBe('ok');
    expect(w.print()).toMatchObject({ state: 'failed', error_code: 'reporting.render_unavailable', object_path: null }); expect(JSON.stringify(w.print())).not.toContain('saturated');
  });
  it('template_invalid (page limit) is permanent: failed at once on attempt 1, resolves', async () => {
    const w = printWorld({ rendererReply: templateInvalid() }); expect(await settle(w.runRender(1))).toBe('ok'); expect(w.print()).toMatchObject({ state: 'failed', error_code: 'reporting.template_invalid' });
  });
  it('sandbox failure and storage failure behave like renderer outages (throw early, failed on the last attempt)', async () => {
    const a = printWorld({ assembler: { error: unavailable() } }); expect(await settle(a.runRender(1))).toBeInstanceOf(Error); expect(a.print()!['state']).toBe('rendering');
    const b = printWorld({ storeOpts: { putFails: true } }); expect(await settle(b.runRender(2))).toBeInstanceOf(Error); expect(b.print()!['state']).toBe('rendering');
    const c = printWorld({ storeOpts: { putFails: true } }); expect(await settle(c.runRender(5))).toBe('ok'); expect(c.print()).toMatchObject({ state: 'failed' }); expect(c.print()!['error_code']).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
  it('a failed print is served as print_not_ready by R12 (state failed has no object_path)', async () => {
    const w = printWorld({ rendererReply: templateInvalid() }); await w.runRender(); expect(w.print()!['object_path'] ?? null).toBeNull();
  });
});

describe('idempotency, payload and tenancy', () => {
  it('a duplicate job on a print that is no longer rendering exits without rendering, storing or writing', async () => {
    for (const state of ['ready', 'failed', 'expired']) {
      const w = printWorld({ prints: [single({ state })] }); const before = JSON.stringify(w.prints()); await w.runRender();
      expect(w.renderer.calls).toHaveLength(0); expect(w.store.puts()).toHaveLength(0); expect(w.db.writes()).toHaveLength(0); expect(JSON.stringify(w.prints())).toBe(before);
    }
  });
  it('running twice stores one file (second run sees ready)', async () => {
    const w = printWorld(); await w.runRender(); await w.runRender(); expect(w.store.puts()).toHaveLength(1); expect(w.renderer.calls).toHaveLength(1);
  });
  it.each([[{ tenant_id: TENANT_A, print_job_id: 'nope' }], [{ tenant_id: TENANT_B, print_job_id: PID(1) }], [{ tenant_id: TENANT_A }], [{ tenant_id: TENANT_A, print_job_id: PID(99) }], [{}]])(
    'bad / foreign / unknown payload %j: logged and skipped, nothing rendered or written', async (payload) => {
      const w = printWorld(); await w.runRender(1, payload as any); expect(w.renderer.calls).toHaveLength(0); expect(w.db.writes()).toHaveLength(0); expect(w.print()!['state']).toBe('rendering');
    });
  it('another tenant\'s print job is invisible even with RLS off: every statement names tenant_id, nothing rendered', async () => {
    const w = printWorld({ rls: false, prints: [single({ tenant_id: TENANT_B })] }); await w.runRender();
    expect(w.renderer.calls).toHaveLength(0); expect(w.db.writes()).toHaveLength(0); expect(w.db.reportingStmts().length).toBeGreaterThan(0); expect(w.db.reportingStmts().every((s) => /\btenant_id\b/i.test(s.text))).toBe(true);
  });
  it('a print whose version belongs to another report tenant is not rendered (version lookup names tenant_id)', async () => {
    const w = printWorld({ rls: false, versions: [releasedVersion(1, { tenant_id: TENANT_B })] }); await w.runRender(5); expect(w.renderer.calls).toHaveLength(0);
    expect(w.print()!['state']).not.toBe('ready'); expect(w.db.reportingStmts().every((s) => /\btenant_id\b/i.test(s.text))).toBe(true);
  });
  it('logs carry ids and counts only: no patient name, registration number or snapshot content', async () => {
    const w = printWorld(); await w.runRender(); const text = w.logs.text(); expect(text).not.toContain(FULL_NAME); expect(text).not.toContain('Synthetic Referrer');
  });
  it('uses the frozen snapshot only: no read of reports / report_order_items (live data) to render a plain print', async () => {
    const w = printWorld(); await w.runRender(); expect(w.db.stmts.filter((s) => /reporting\.(reports|report_order_items)\b/.test(s.text))).toHaveLength(0);
    expect(w.print()!['report_version_ids']).toEqual([VID1]); expect(LAB).toBeTruthy(); expect(TEMPLATE_VERSION).toBeTruthy();
  });
});
