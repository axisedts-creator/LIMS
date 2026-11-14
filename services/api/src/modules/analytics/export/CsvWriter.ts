// CSV export (RFC 4180; 02-TRD §10.2 step 6; PRD US-17.2/17.3): UTF-8 BOM, CRLF records, "#" header block, label row, rows.
// Every text cell passes the shared neutraliseFormula; numbers are written bare (never neutralised: -740 stays -740).
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { headerLines, numericCell, oneLine, withNprColumns, type ExportTable } from './layout.js';

const field = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const text = (s: string): string => field(neutraliseFormula(s));

export function writeCsv(table: ExportTable): Uint8Array {
  const t = withNprColumns(table);
  const lines = [
    ...headerLines(t.meta).map((l) => `# ${oneLine(l)}`), // comment block: no record can be opened from a header value
    t.columns.map((c) => text(c.label)).join(','),
    ...t.rows.map((r) => t.columns.map((c) => (c.kind === 'text' ? text(String(r[c.key] ?? '')) : String(numericCell(r[c.key], c.key)))).join(',')),
  ];
  return new Uint8Array(Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'));
}
