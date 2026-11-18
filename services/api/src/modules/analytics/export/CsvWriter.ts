// CSV export (RFC 4180; 02-TRD §10.2 step 6; PRD US-17.2/17.3): UTF-8 BOM, CRLF records, "#" header block, label row, rows.
// Every text cell passes the shared neutraliseFormula; numbers are written bare (never neutralised: -740 stays -740).
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import { headerLines, numericCell, oneLine, withNprColumns, type ExportTable } from './layout.js';

const field = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const text = (s: string): string => field(neutraliseFormula(s));

const head = (t: ExportTable): string[] => [
  ...headerLines(t.meta).map((l) => `# ${oneLine(l)}`), // comment block: no record can be opened from a header value
  t.columns.map((c) => text(c.label)).join(','),
];
const record = (t: ExportTable, r: ExportTable['rows'][number]): string =>
  t.columns.map((c) => (c.kind === 'text' ? text(String(r[c.key] ?? '')) : String(numericCell(r[c.key], c.key)))).join(',');
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

export function writeCsv(table: ExportTable): Uint8Array {
  const t = withNprColumns(table);
  return bytes(`﻿${[...head(t), ...t.rows.map((r) => record(t, r))].join('\r\n')}\r\n`);
}

/** T0B-MISREPORTS-1 done_when (3): the same bytes as writeCsv, produced chunk by chunk (header first, then one output chunk per source chunk; never the whole result). */
export async function* writeCsvStream(table: Omit<ExportTable, 'rows'>, chunks: AsyncIterable<ExportTable['rows']>): AsyncGenerator<Uint8Array> {
  yield bytes(`﻿${head(withNprColumns({ ...table, rows: [] })).join('\r\n')}\r\n`);
  for await (const rows of chunks) {
    if (rows.length === 0) continue;
    const t = withNprColumns({ ...table, rows });
    yield bytes(`${t.rows.map((r) => record(t, r)).join('\r\n')}\r\n`);
  }
}
