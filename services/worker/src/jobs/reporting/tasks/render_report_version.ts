// Task reporting.render_report_version (02-TRD §5.1, §5.2, §9; 03-APP-FLOW §3.8 "Render", E9/E10/E11; 01-PRD AC-03.9, AC-03.10).
// Lock the `rendering` version -> assets (IdentityPort) -> renderer -> sandbox assemble (main + sanitised outside files, "Page n Of m" stamp) -> write-once put
// at the D15 path -> `rendered` + enqueue release_if_eligible. The stored snapshot is never rewritten; the signatory council overlay lives on the request copy only.
// Failure contract: a retryable failure on a non-final attempt THROWS a sanitised error (queue retry, tx rolled back, version stays `rendering`); on the final
// attempt, and at once for permanent failures (422 template_invalid, write-once / integrity violations), the task COMMITS `render_failed` and RESOLVES.
// The error code recorded is a stable code, never an error message (messages can carry HTML / names).
// LD-27 (2026-11-07, A33-4 signatory council): getSignatories profiles carry `council` ('NMC' | 'NHPC'); it is copied onto the renderer document's signatories
// (absent or unknown -> omitted, so the footer prints name + title only). registration_no stays as recorded in the snapshot.
import { createHash } from 'node:crypto';
import type { TaskHandler } from '../../../core/manifest.js';
import { ENQUEUE_SQL } from '../../../core/fanout.js';

type Row = Record<string, any>;
export interface RenderPorts {
  renderer: { render(req: Row): Promise<{ pdf: Uint8Array; pageCount: number }> };
  sandbox: { assemble(req: Row): Promise<{ pdf: Uint8Array; pageCount: number }> };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_BUCKET = 'reporting-inputs';
const REPORT_BUCKET = 'reports';
const RELEASE_TASK = 'reporting.release_if_eligible';
const RELEASE_MAX_ATTEMPTS = 10;                                        // 02-TRD §9
const FAILURES = 'lims_reporting_render_failures_total';
const COUNCILS = ['NMC', 'NHPC'];
const IMAGE_MIMES = ['image/png', 'image/jpeg'];
export const STAMP = { page_label_format: 'Page {n} Of {m}', position: 'footer_right', font_size_pt: 8, markers: { plain: false, not_released: false } };
export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
export const codeOf =(e: unknown) => String((e as Row)?.code ?? '');

/** A failure that no retry can fix: the version goes straight to render_failed with `code`. */
export class Permanent extends Error { constructor(readonly code: string) { super(code); } }

/** D15: {tenant}/{yyyy}/{mm}/{report_id}-v{n}.pdf, yyyy/mm = version created_at in UTC (not the run date). */
function objectPath(tenantId: string, v: Row): string {
  const d = new Date(v['created_at']);
  return `${tenantId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${v['report_id']}-v${v['version_no']}.pdf`;
}

export function createRenderReportVersion(o: RenderPorts): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const versionId = payload?.['report_version_id'];
    if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof versionId !== 'string' || !UUID.test(versionId)) {
      ctx.log?.warn?.({ event: 'render_report_version_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx; const actor: string = ctx.actor.id;
    const rows = async (sql: string, values: unknown[]): Promise<Row[]> => (await tx.query(sql, values)).rows;

    // 1. lock the version (a duplicate job waits here, then sees `rendered` and exits: the PDF is never written twice). tenant_id named in every statement.
    const v = (await rows(`SELECT id, report_id, version_no, status, created_at, content_snapshot, template_version_id FROM reporting.report_versions
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, versionId]))[0];
    if (!v || (typeof payload['report_id'] === 'string' && payload['report_id'] !== v['report_id'])) { ctx.log?.warn?.({ event: 'render_report_version_skipped', reason: 'unknown_version' }); return; }
    if (v['status'] !== 'rendering') { ctx.log?.info?.({ event: 'render_report_version_noop', report_version_id: versionId, status: v['status'] }); return; }

    const fail = async (errorCode: string) => {
      await tx.query(`UPDATE reporting.report_versions SET status = 'render_failed', last_render_error_code = $3, render_attempts = $4, version = version + 1,
        updated_by = $5, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'rendering'`, [tenantId, versionId, errorCode, ctx.attempt, actor]);
      ctx.metrics?.inc?.(FAILURES, { error_code: errorCode });
      ctx.log?.error?.({ event: 'render_failed', report_version_id: versionId, error_code: errorCode, attempt: ctx.attempt });   // critical alert (E11)
    };

    // Review C6-T09 #2: a failing SQL statement aborts the tx; rolling back to this savepoint lets render_failed still commit (AC-03.9, E11).
    await tx.query('SAVEPOINT render_attempt', []);
    try {
      // 2. inputs: template config of THIS version's template_version_id, the frozen snapshot (copied: the overlay below must not touch the stored one)
      const tv = (await rows(`SELECT config FROM reporting.report_template_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, v['template_version_id']]))[0];
      if (!tv) throw new Permanent('reporting.template_invalid');
      const doc: Row = structuredClone(json(v['content_snapshot']) ?? {});
      const assets = await collectAssets(ctx, versionId, doc);
      await addCouncils(ctx, doc);

      // 3. the renderer service renders the main pages; 4. the sandbox merges the sanitised outside files and stamps the page labels
      const main = await o.renderer.render({ template_id: doc['family'] === 'narrative' ? 'narrative-report' : 'lab-report', variant: 'letterhead',
        template_version_config: json(tv['config']), document: doc, assets });
      const parts: Row[] = [{ kind: 'main', pdf_base64: Buffer.from(main.pdf).toString('base64'), sha256: sha(main.pdf) }];
      for (const a of (doc['outsourcedAttachments'] ?? []) as Row[]) {
        const f = (await rows(`SELECT sanitized_object_path FROM reporting.input_files WHERE tenant_id = $1 AND id = $2`, [tenantId, a['inputFileId']]))[0];
        if (!f?.['sanitized_object_path']) throw new Permanent('common.internal');
        parts.push(await part(ctx, 'outsourced', f['sanitized_object_path'], a['sha256']));
      }
      for (const a of (doc['instrumentPdfAttachments'] ?? []) as Row[]) parts.push(await part(ctx, 'instrument_pdf', `${tenantId}/instrument-pdfs/${a['sanitizedSha256']}.pdf`, a['sanitizedSha256']));
      const merged = await o.sandbox.assemble({ parts, stamp: STAMP });
      const hash = sha(merged.pdf); const path = objectPath(tenantId, v);

      // 5. write-once store. An object already there: same bytes = an earlier attempt crashed before the row update (fine); different bytes = E11.
      try { await ctx.storage.put(REPORT_BUCKET, path, merged.pdf, { contentType: 'application/pdf', ifAbsent: true }); }
      catch (e) {
        const have: Uint8Array | undefined = await ctx.storage.read(REPORT_BUCKET, path).catch(() => undefined);
        if (!have) throw e;                                                // not a write-once clash: storage trouble, retry
        if (sha(have) !== hash) throw new Permanent('common.internal');    // E11: never overwrite, never release
      }

      const done = await rows(`UPDATE reporting.report_versions SET status = 'rendered', pdf_object_path = $3, pdf_sha256 = $4, pdf_bytes = $5, page_count = $6, render_attempts = $7,
        last_render_error_code = NULL, rendered_at = now(), version = version + 1, updated_by = $8, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'rendering' RETURNING id`, [tenantId, versionId, path, hash, merged.pdf.length, merged.pageCount, ctx.attempt, actor]);
      if (done.length === 0) return;
      await tx.query(ENQUEUE_SQL, [RELEASE_TASK, JSON.stringify({ tenant_id: tenantId, report_id: v['report_id'], report_version_id: versionId }), `release:${versionId}`, null, RELEASE_MAX_ATTEMPTS]);
      ctx.log?.info?.({ event: 'report_version_rendered', report_version_id: versionId, page_count: merged.pageCount, pdf_bytes: merged.pdf.length });
    } catch (e) {
      const code = e instanceof Permanent ? e.code : codeOf(e) === 'reporting.template_invalid' ? 'reporting.template_invalid' : undefined;
      const final = ctx.attempt >= ctx.maxAttempts;
      if (code === undefined && !final) throw Object.assign(new Error('render attempt failed'), { code: 'reporting.render_unavailable' });   // queue retry; original message may carry PHI
      await tx.query('ROLLBACK TO SAVEPOINT render_attempt', []);
      await fail(code ?? 'reporting.render_unavailable');                  // permanent, or the final attempt: commit render_failed and resolve
    }
  };
}

/** A sanitised outside file read from storage; bytes whose sha256 differs from the snapshot's recorded one never reach the sandbox merge. */
export async function part(ctx: any, kind: 'outsourced' | 'instrument_pdf', path: string, expected: string): Promise<Row> {
  const bytes: Uint8Array = await ctx.storage.read(INPUT_BUCKET, path);   // storage failure = retryable
  if (sha(bytes) !== String(expected).toLowerCase()) throw new Permanent('common.internal');
  return { kind, pdf_base64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) };
}

/** E9: logo / letterhead images and signature images, keyed by sha256. A missing, altered or non-image asset is logged `asset_missing` and left out; it never blocks. */
export async function collectAssets(ctx: any, versionId: string, doc: Row, skipBranding = false): Promise<Record<string, { mime_type: string; base64: string }>> {   // C6-T16: skipBranding = plain print (no letterhead images)
  const identity = ctx.ports.identity; const out: Record<string, { mime_type: string; base64: string }> = {};
  const refs: Array<{ kind: 'branding' | 'signature'; ref: Row; membershipId?: string }> = [];
  if (!skipBranding) for (const k of ['logoAssetRef', 'headerAssetRef', 'footerAssetRef']) if (doc['lab']?.[k]) refs.push({ kind: 'branding', ref: doc['lab'][k] });
  for (const s of (doc['signatories'] ?? []) as Row[]) if (s['signatureAssetRef']) refs.push({ kind: 'signature', ref: s['signatureAssetRef'], membershipId: s['membershipId'] });
  for (const { kind, ref, membershipId } of refs) {
    if (out[ref['sha256']]) continue;
    let mime: string; let base64: string; let reported: string;
    try {
      if (kind === 'branding') { const a = await identity.readBrandingAsset(ctx, { assetId: ref['id'] }); mime = a.mimeType; base64 = a.base64; reported = a.sha256; }
      else { const a = await identity.readSignatureImage(ctx, { membershipId }); mime = a.mimeType; base64 = a.contentBase64; reported = a.sha256; }
    } catch (e) {
      if (!['common.not_found', 'common.upload_quarantined'].includes(codeOf(e))) throw e;     // identity outage = retry
      ctx.log?.warn?.({ event: 'asset_missing', report_version_id: versionId, asset_kind: kind, reason: 'not_found' });
      continue;
    }
    const actual = sha(Buffer.from(base64, 'base64'));
    if (actual !== ref['sha256'] || actual !== reported || !IMAGE_MIMES.includes(mime)) {         // the snapshot froze this hash: a replaced asset is not the one the report recorded
      ctx.log?.warn?.({ event: 'asset_missing', report_version_id: versionId, asset_kind: kind, reason: 'mismatch' });
      continue;
    }
    out[actual] = { mime_type: mime, base64 };
  }
  return out;
}

/** LD-27: copy the registering council of each signatory profile onto the request document (never the stored snapshot). */
export async function addCouncils(ctx: any, doc: Row): Promise<void> {
  const signatories = (doc['signatories'] ?? []) as Row[];
  if (signatories.length === 0) return;
  const profiles: Row[] = await ctx.ports.identity.getSignatories(ctx, { membershipIds: signatories.map((s) => s['membershipId']) });   // outage = retry
  for (const s of signatories) {
    const council = profiles.find((p) => p['membershipId'] === s['membershipId'])?.['council'];
    if (COUNCILS.includes(council)) s['council'] = council; else delete s['council'];
  }
}
