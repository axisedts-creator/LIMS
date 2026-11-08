// render(templateId, data) — the only public rendering function (02-TRD §5.1, REQ-ARCH-045). Templates register in
// later tasks (C6-T06+ report templates, RenderTemplateKey data templates); an unknown id is a bad bundle (400).
import { PDFDocument } from '@cantoo/pdf-lib';
import { RenderError, type Pool, type RenderHtmlOptions } from './pool.js';
import type { AssetRef, DataTemplateModule } from './templates/contract.js';
import { qrDataUri } from './templates/lab/qr.js';

export type Asset = { mime_type: 'image/png' | 'image/jpeg'; base64: string };
export type Assets = Record<string, Asset>;
export type Template = (data: unknown, assets: Assets) => { html: string } & RenderHtmlOptions;

export const templates = new Map<string, Template>();

/** Second request shape (review fix #13): a DataTemplateModule gets the data and a data:-URI-only asset resolver; its throw is a 422. */
async function renderData(m: DataTemplateModule, templateId: string, data: unknown, assets: Assets, pool?: Pool) {
  if (!pool) throw new RenderError(503, 'no renderer pool');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RenderError(400, 'bad bundle');
  let html: string;
  try {
    html = m.render({
      data: data as Record<string, unknown>, qr: qrDataUri,
      assets: { dataUri: (ref: AssetRef) => {
        const a = Object.hasOwn(assets, ref.sha256) ? assets[ref.sha256] : undefined;
        if (!a) throw new Error('unknown asset');
        return `data:${a.mime_type};base64,${a.base64}`;
      } },
    });
  } catch {
    throw new RenderError(422, 'template error');
  }
  const out = await pool.renderHtml(html, { templateId });
  return { pdf: await stripVolatileMetadata(out.pdf), pageCount: out.pageCount };
}

/** Chromium stamps the render time into /CreationDate, /ModDate and the trailer /ID; pin them so bytes depend only on input (02-TRD §7.4). */
async function stripVolatileMetadata(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const epoch = new Date(0);
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);
  delete doc.context.trailerInfo.ID;
  return doc.save({ updateFieldAppearances: false });
}

export async function render(templateId: string, data: unknown, assets: Assets = {}, pool?: Pool, registry?: { get(id: string): unknown }) {
  const dm = registry?.get(templateId) as DataTemplateModule | undefined;
  if (dm && typeof dm.templateKey === 'string') return renderData(dm, templateId, data, assets, pool);
  const t = templates.get(templateId);
  if (!t) throw new RenderError(400, 'unknown template_id');
  if (!pool) throw new RenderError(503, 'no renderer pool');
  let out: ReturnType<Template>;
  try {
    out = t(data, assets);
  } catch {
    throw new RenderError(422, 'template error');
  }
  const { html, ...opts } = out;
  return pool.renderHtml(html, { ...opts, templateId });
}
