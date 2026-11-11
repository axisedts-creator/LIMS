// Export layout shared by CsvWriter / XlsxWriter / PdfRequest (02-TRD §10.2 step 6/6a; PRD US-17.2): header block, NPR companion columns.
// Pure: no clock, no I/O. Header values are neutralised once here (08 A13 P-9: the ONE shared guard, no module copy).
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';

export const NOT_STATUTORY = 'Internal MIS — not a statutory register';

export type ExportKind = 'text' | 'count' | 'paisa' | 'seconds' | 'bp';
export interface ExportColumn { key: string; label: string; kind: ExportKind }
/** text: any string; numeric kinds: an integer, or '' for "no value" (blank cell). */
export type ExportCell = string | number;
export interface ExportMeta {
  tenantDisplayName: string; reportTitle: string; periodLabelAd: string; periodLabelBs: string; scopeLabel: string; generatedAtLocal: string;
  exportId: string; exportedBy: string; freshnessNote: string; notStatutoryNote?: string | undefined;
}
export interface ExportTable { meta: ExportMeta; columns: ExportColumn[]; rows: Record<string, ExportCell>[] }

/** One line: CR/LF/NUL and other control characters become a space (a value can never open a second record or a second line). */
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();

/** The 9 header-block lines in PRD order ("<Label>: <value>"; requester line "Exported by <name>"). */
export function headerLines(meta: ExportMeta): string[] {
  const v = (s: string): string => oneLine(neutraliseFormula(s));
  return [
    `Tenant: ${v(meta.tenantDisplayName)}`,
    `Report: ${v(meta.reportTitle)}`,
    `Period: ${v(meta.periodLabelAd)} | ${v(meta.periodLabelBs)}`,
    `Scope: ${v(meta.scopeLabel)}`,
    `Generated at: ${v(meta.generatedAtLocal)}`,
    `Export ID: ${v(meta.exportId)}`,
    `Exported by ${v(meta.exportedBy)}`,
    `Data freshness: ${v(meta.freshnessNote)}`,
    `Note: ${meta.notStatutoryNote ?? NOT_STATUTORY}`,
  ];
}

/** Integer paisa -> "<rupees>.<2 digits>"; bigint maths only (no floats). */
export function formatNpr(paisa: number): string {
  if (!Number.isSafeInteger(paisa)) throw new RangeError('export: paisa is not a safe integer');
  const n = BigInt(paisa), a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** After every paisa column "<x>_paisa" a text column "<x>_npr"; the integer paisa stay. Input is not mutated. */
export function withNprColumns(table: ExportTable): ExportTable {
  const columns: ExportColumn[] = [];
  const nprOf = new Map<string, string>();
  for (const c of table.columns) {
    columns.push(c);
    if (c.kind !== 'paisa') continue;
    const key = `${c.key.replace(/_paisa$/, '')}_npr`;
    nprOf.set(c.key, key);
    columns.push({ key, label: /\(paisa\)/i.test(c.label) ? c.label.replace(/\(paisa\)/i, '(NPR)') : `${c.label} (NPR)`, kind: 'text' });
  }
  const rows = table.rows.map((r) => {
    const out: Record<string, ExportCell> = { ...r };
    for (const [paisaKey, nprKey] of nprOf) out[nprKey] = typeof r[paisaKey] === 'number' ? formatNpr(r[paisaKey] as number) : '';
    return out;
  });
  return { meta: table.meta, columns, rows };
}

/** A numeric cell must be a safe integer (or '' = blank); anything else is a bug upstream and never reaches a file. */
export function numericCell(v: ExportCell | undefined, key: string): number | '' {
  if (v === undefined || v === '') return '';
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new RangeError(`export: column ${key} is not an integer`);
  return v;
}
