// analytics.report DataTemplateModule (02-TRD §10.2 step 6a; C6 02-TRD §5.3, §7.4). Internal MIS report: header block, data table, not-statutory line.
// Pure (same data -> same HTML, no clock, no random); prints only the step 6a fields; every dynamic value is escaped element content.
// REQ-SEC-086: no script, no external reference, no image, no @font-face — fonts are the bundled system fonts (C6 02-TRD §5.1).
import type { DataTemplateModule } from '../../../src/templates/contract.js';
import { fmtBp, fmtCount, fmtPaisa, fmtSeconds } from './format.js';

type Kind = 'text' | 'count' | 'paisa' | 'seconds' | 'bp';
interface Col { key: string; label: string; kind: Kind }

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[&<>"']/g, (c) => ENT[c]!);

const META = ['tenantDisplayName', 'reportTitle', 'periodLabelAd', 'periodLabelBs', 'scopeLabel', 'generatedAtLocal', 'exportId', 'exportedBy', 'freshnessNote', 'notStatutoryNote'] as const;
const KINDS: readonly string[] = ['text', 'count', 'paisa', 'seconds', 'bp'];
const NUMERIC: Record<Exclude<Kind, 'text'>, (v: unknown) => string> = { count: fmtCount, paisa: fmtPaisa, seconds: fmtSeconds, bp: fmtBp };
const bad = (): never => { throw new Error('analytics.report: data violates the render schema'); };   // message carries no data -> 422, nothing echoed

const css = (cols: number): string => {
  const pt = cols <= 8 ? 9 : cols <= 16 ? 7.5 : 6;
  return `@page{size:A4 ${cols > 8 ? 'landscape' : 'portrait'};margin:10mm}` +
    `body{font-family:"Noto Sans","Noto Sans Devanagari",Arial,Helvetica,sans-serif;font-size:${pt}pt;line-height:1.25;color:#000;margin:0}` +
    `h1{font-size:${pt + 5}pt;margin:0 0 1.5mm}.sub{margin:0 0 3mm;font-size:${pt + 1}pt}` +
    `.meta{margin:0 0 4mm}.meta div{margin:0 0 .6mm}.meta b{font-weight:600}.note{margin:0 0 3mm;font-weight:600}` +
    `table.data{width:100%;border-collapse:collapse;table-layout:fixed}` +
    `table.data th,table.data td{border:.2mm solid #888;padding:.5mm 1mm;overflow-wrap:anywhere;word-break:break-word;vertical-align:top;text-align:left}` +
    `table.data th{background:#e8e8e8;font-weight:600}table.data td.n{text-align:right;font-variant-numeric:tabular-nums}` +
    `thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}`;
};

export const analyticsReportTemplate: DataTemplateModule = {
  templateKey: 'analytics.report',
  render({ data }) {
    for (const k of META) if (typeof data[k] !== 'string') bad();
    const columns = data['columns'], rows = data['rows'];
    if (!Array.isArray(columns) || columns.length === 0 || !Array.isArray(rows)) return bad();
    const cols = columns.map((c: unknown): Col => {
      const o = c as Record<string, unknown> | null;
      if (!o || typeof o['key'] !== 'string' || typeof o['label'] !== 'string' || typeof o['kind'] !== 'string' || !KINDS.includes(o['kind'])) return bad();
      return { key: o['key'], label: o['label'], kind: o['kind'] as Kind };
    });
    const head = `<tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
    const body = rows.map((r: unknown) => {
      const row = r as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || Array.isArray(row)) return bad();
      return `<tr>${cols.map((c) => {
        const v = Object.prototype.hasOwnProperty.call(row, c.key) ? row[c.key] : undefined;
        if (c.kind === 'text') {
          if (v !== undefined && typeof v !== 'string' && typeof v !== 'number') bad();
          return `<td>${esc(v)}</td>`;
        }
        return `<td class="n">${esc(NUMERIC[c.kind](v))}</td>`;
      }).join('')}</tr>`;
    }).join('');
    const m = (k: (typeof META)[number]) => esc(data[k]);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${m('reportTitle')}</title><style>${css(cols.length)}</style></head><body>` +
      `<h1>${m('tenantDisplayName')}</h1><div class="sub">${m('reportTitle')}</div>` +
      `<div class="meta"><div><b>Period (A.D.)</b> ${m('periodLabelAd')}</div><div><b>Period (B.S.)</b> ${m('periodLabelBs')}</div>` +
      `<div><b>Scope</b> ${m('scopeLabel')}</div><div><b>Generated</b> ${m('generatedAtLocal')}</div><div><b>Export ID</b> ${m('exportId')}</div>` +
      `<div>${m('exportedBy')}</div><div>${m('freshnessNote')}</div></div>` +
      `<div class="note">${m('notStatutoryNote')}</div>` +
      `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table></body></html>`;
  },
};
