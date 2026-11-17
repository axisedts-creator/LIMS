// `data` of RenderPort.renderPdf({templateKey:'analytics.report', ...}) (02-TRD §10.2 step 6a; schema bounds: every string <= 200 chars,
// 1-40 columns, 0-5,000 rows, all objects closed). Strings are neutralised with the shared guard; count/paisa/seconds/bp stay integers (the template formats them).
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { LimsError } from '../../../core/errors.js';
import { NOT_STATUTORY, numericCell, type ExportCell, type ExportTable } from './layout.js';

export const PDF_MAX_ROWS = 5000;
const MAX_COLUMNS = 40;
const KEY = /^[a-z0-9_]{1,40}$/;
const s = (v: string): string => neutraliseFormula(v).slice(0, 200);

export interface PdfData {
  tenantDisplayName: string; reportTitle: string; periodLabelAd: string; periodLabelBs: string; scopeLabel: string; generatedAtLocal: string;
  exportId: string; exportedBy: string; freshnessNote: string; notStatutoryNote: string;
  columns: { key: string; label: string; kind: string }[]; rows: Record<string, ExportCell>[];
}

export function buildPdfData(table: ExportTable): PdfData {
  if (table.rows.length > PDF_MAX_ROWS) throw new LimsError('analytics.export_too_large'); // RenderPort cap, before any call
  if (table.columns.length < 1 || table.columns.length > MAX_COLUMNS || table.columns.some((c) => !KEY.test(c.key))) {
    throw new RangeError('export: PDF columns violate analytics.report schema');
  }
  const m = table.meta;
  return {
    tenantDisplayName: s(m.tenantDisplayName), reportTitle: s(m.reportTitle), periodLabelAd: s(m.periodLabelAd), periodLabelBs: s(m.periodLabelBs),
    scopeLabel: s(m.scopeLabel), generatedAtLocal: s(m.generatedAtLocal), exportId: m.exportId, exportedBy: s(m.exportedBy), freshnessNote: s(m.freshnessNote),
    notStatutoryNote: s(m.notStatutoryNote ?? NOT_STATUTORY),
    columns: table.columns.map((c) => ({ key: c.key, label: s(c.label), kind: c.kind })),
    rows: table.rows.map((r) => Object.fromEntries(table.columns.map((c) => [c.key, c.kind === 'text' ? s(String(r[c.key] ?? '')) : numericCell(r[c.key], c.key)]))),
  };
}
