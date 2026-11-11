// 02-TRD §8.3 steps 2-4: ZIP inspection -> read-excel-file 9.3.14 under a 60 s timeout -> 20,000-row cap ->
// restoreNeutralised on every text cell (§8.2). The only module that imports read-excel-file (§3.1 confinement).
import { restoreNeutralised } from '@lims/shared-ts/spreadsheet';
import { inspectZip } from './ZipInspector.js';

export type Cell = string | number | boolean | Date | null;
export type Sheet = { name: string; rows: unknown[][] };
export type Parse = (bytes: Uint8Array, signal: AbortSignal) => Promise<Sheet[]>;

export type XlsxReadCode =
  | 'file.not_xlsx' | 'file.zip_unsafe' | 'file.macro_present' | 'file.external_links' | 'file.parse_timeout' | 'file.too_many_rows';

/** Carries a `catalog_import_issue_codes` value (02-TRD §8.6); the import job turns it into an issue. */
export class XlsxReadError extends Error {
  constructor(readonly code: XlsxReadCode) { super(code); this.name = 'XlsxReadError'; }
}

export const PARSE_TIMEOUT_MS = 60_000; // [CONV] 02-TRD §8.3 step 3
export const MAX_ROWS = 20_000;         // [CONV] per sheet

// ponytail: read-excel-file takes no AbortSignal, so a timed-out parse keeps running in the background until it
// ends; the job still fails fast. Move parsing to a worker thread if CPU from abandoned parses ever matters.
const libraryParse: Parse = async (bytes) => {
  const { default: readXlsxFile } = await import('read-excel-file/node');
  const sheets = await readXlsxFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { trim: false });
  return sheets.map((s) => ({ name: s.sheet, rows: s.data as unknown[][] }));
};

export function createXlsxReader(o: { parse?: Parse; timeoutMs?: number; maxRows?: number } = {}) {
  const parse = o.parse ?? libraryParse;
  const timeoutMs = o.timeoutMs ?? PARSE_TIMEOUT_MS;
  const maxRows = o.maxRows ?? MAX_ROWS;

  return {
    async read(bytes: Uint8Array): Promise<Sheet[]> {
      const verdict = inspectZip(bytes);
      if (!verdict.ok) throw new XlsxReadError(verdict.code);

      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(new XlsxReadError('file.parse_timeout')); }, timeoutMs);
      });
      let sheets: Sheet[];
      try {
        sheets = await Promise.race([parse(bytes, ac.signal), timeout]);
      } finally {
        clearTimeout(timer);
      }

      if (sheets.some((s) => s.rows.length > maxRows)) throw new XlsxReadError('file.too_many_rows');
      return sheets.map((s) => ({
        name: s.name,
        rows: s.rows.map((r) => r.map((c) => (typeof c === 'string' ? restoreNeutralised(c) : c))),
      }));
    },
  };
}

export const readXlsx = (bytes: Uint8Array): Promise<Sheet[]> => createXlsxReader().read(bytes);
