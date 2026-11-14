// XLSX export (02-TRD §10.2 step 6; PRD US-17.1/17.2/17.3): sheet "Report" (labels row + rows) and sheet "About" (the header block).
// write-excel-file 4.1.1 (node entry). Every text cell passes the shared neutraliseFormula; counts/paisa/seconds/bp are real numbers.
import writeXlsxFile from 'write-excel-file/node';
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { headerLines, numericCell, withNprColumns, type ExportTable } from './layout.js';

const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g; // not allowed in XML 1.0: would corrupt the workbook
const MAX_CELL = 32_767; // Excel's cell text limit
const text = (s: string): string => neutraliseFormula(s.replace(XML_BAD, '')).slice(0, MAX_CELL);

export async function writeXlsx(table: ExportTable): Promise<Uint8Array> {
  const t = withNprColumns(table);
  const report = [
    t.columns.map((c) => ({ value: text(c.label), fontWeight: 'bold' as const })),
    ...t.rows.map((r) => t.columns.map((c) => {
      if (c.kind === 'text') return { value: text(String(r[c.key] ?? '')) };
      const n = numericCell(r[c.key], c.key);
      return n === '' ? null : { value: n };
    })),
  ];
  const about = headerLines(t.meta).map((l) => [{ value: text(l) }]);
  const buf = await writeXlsxFile([
    { data: report as never, sheet: 'Report', stickyRowsCount: 1 },
    { data: about as never, sheet: 'About', columns: [{ width: 90 }] },
  ]).toBuffer();
  return new Uint8Array(buf);
}
