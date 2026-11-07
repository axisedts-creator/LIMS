// render(templateId, data) — the only public rendering function (02-TRD §5.1, REQ-ARCH-045). Templates register in
// later tasks (C6-T06+ report templates, RenderTemplateKey data templates); an unknown id is a bad bundle (400).
import { RenderError, type Pool, type RenderHtmlOptions } from './pool.js';

export type Asset = { mime_type: 'image/png' | 'image/jpeg'; base64: string };
export type Assets = Record<string, Asset>;
export type Template = (data: unknown, assets: Assets) => { html: string } & RenderHtmlOptions;

export const templates = new Map<string, Template>();

export async function render(templateId: string, data: unknown, assets: Assets = {}, pool?: Pool) {
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
