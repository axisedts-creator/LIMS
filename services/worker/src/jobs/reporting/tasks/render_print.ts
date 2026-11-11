// Task reporting.render_print (02-TRD §9 "R10 plain variant, T5 preview"; 01-PRD AC-12.2, AC-12.3, AC-13.1; 05-SCHEMA §2.14).
// - single (R10 plain, or any draft print): the SAME frozen snapshot and the version's OWN template version config as the canonical report; variant plain omits the letterhead
//   images (signature images stay); outsourced + instrument pdfs are merged like the canonical report; a draft print (draft_watermark) gets the "NOT RELEASED" watermark
//   (renderer `watermark_override`) and the sandbox marker not_released (AC-12.3). The stored version is never touched.
// - template_preview (T5): renderer template `template-preview` with the print's template version config and NO document (the renderer owns the synthetic sample); no patient data is read.
import type { TaskHandler } from '../../../core/manifest.js';
import { printTask } from './print_common.js';
import { addCouncils, collectAssets, json, part, Permanent, sha, STAMP, type RenderPorts } from './render_report_version.js';

type Row = Record<string, any>;
const NOT_RELEASED = 'NOT RELEASED';

export function createRenderPrint(o: RenderPorts): TaskHandler {
  return printTask('render_print', ['single', 'template_preview'], async (ctx, p) => {
    const tenantId: string = ctx.tenantId; const plain = p['variant'] === 'plain';
    const rows = async (sql: string, values: unknown[]): Promise<Row[]> => (await ctx.tx.query(sql, values)).rows;
    const stamp = (notReleased: boolean) => ({ ...STAMP, markers: { plain, not_released: notReleased } });

    if (p['kind'] === 'template_preview') {
      const tv = (await rows('SELECT config FROM reporting.report_template_versions WHERE tenant_id = $1 AND id = $2', [tenantId, p['template_version_id']]))[0];
      if (!tv) throw new Permanent('reporting.template_invalid');
      const main = await o.renderer.render({ template_id: 'template-preview', variant: p['variant'], template_version_config: json(tv['config']) });
      return o.sandbox.assemble({ parts: [{ kind: 'main', pdf_base64: Buffer.from(main.pdf).toString('base64'), sha256: sha(main.pdf) }], stamp: stamp(false) });
    }

    const versionId = (p['report_version_ids'] as string[] | null)?.[0];
    const v = versionId ? (await rows(`SELECT id, report_id, version_no, content_snapshot, template_version_id FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, versionId]))[0] : undefined;
    if (!v) throw new Permanent('common.not_found');
    const tv = (await rows('SELECT config FROM reporting.report_template_versions WHERE tenant_id = $1 AND id = $2', [tenantId, v['template_version_id']]))[0];
    if (!tv) throw new Permanent('reporting.template_invalid');
    const doc: Row = structuredClone(json(v['content_snapshot']) ?? {});       // copied: the council overlay must not touch the stored snapshot
    const assets = await collectAssets(ctx, v['id'], doc, plain);
    await addCouncils(ctx, doc);
    const draft = p['draft_watermark'] === true;
    const main = await o.renderer.render({ template_id: doc['family'] === 'narrative' ? 'narrative-report' : 'lab-report', variant: p['variant'], template_version_config: json(tv['config']),
      document: doc, assets, ...(draft ? { watermark_override: NOT_RELEASED } : {}) });
    const parts: Row[] = [{ kind: 'main', pdf_base64: Buffer.from(main.pdf).toString('base64'), sha256: sha(main.pdf) }];
    for (const a of (doc['outsourcedAttachments'] ?? []) as Row[]) {
      const f = (await rows('SELECT sanitized_object_path FROM reporting.input_files WHERE tenant_id = $1 AND id = $2', [tenantId, a['inputFileId']]))[0];
      if (!f?.['sanitized_object_path']) throw new Permanent('common.internal');
      parts.push(await part(ctx, 'outsourced', f['sanitized_object_path'], a['sha256']));
    }
    for (const a of (doc['instrumentPdfAttachments'] ?? []) as Row[]) parts.push(await part(ctx, 'instrument_pdf', `${tenantId}/instrument-pdfs/${a['sanitizedSha256']}.pdf`, a['sanitizedSha256']));
    return o.sandbox.assemble({ parts, stamp: stamp(draft) });
  });
}
