// Generic RFC 4180 CSV reader for module micro (02-TRD §9.1): `,` separator, LF or CRLF, quoted fields (doubled quote, embedded newline),
// blank lines and lines starting with `#` ignored. Pure and linear-time; never evaluates or interprets a cell (T-B4: formulas stay text).
// Cells are NOT trimmed. `line` = 1-based physical line where a record starts. An unterminated quote sets `unbalancedQuote` and stops parsing.
export interface CsvRecord { readonly line: number; readonly fields: string[] }
export interface CsvResult { readonly records: CsvRecord[]; readonly unbalancedQuote: boolean }

const LF = 10, CR = 13, COMMA = 44, QUOTE = 34, HASH = 35;

/** True when text[from, to) holds only whitespace (a "blank" line). */
function isBlank(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== CR) return false;
  }
  return true;
}

export function parseCsv(text: string): CsvResult {
  const records: CsvRecord[] = [];
  const n = text.length;
  let pos = 0;
  let line = 1;
  while (pos < n) {
    let eol = text.indexOf('\n', pos);
    if (eol < 0) eol = n;
    // Record start: skip blank lines and `#` comment lines (a quoted field cannot start here, so this is safe).
    if (text.charCodeAt(pos) === HASH || isBlank(text, pos, eol)) { pos = eol + 1; line++; continue; }

    const startLine = line;
    const fields: string[] = [];
    let i = pos;
    for (;;) {                                           // one field per iteration
      if (text.charCodeAt(i) === QUOTE) {
        const parts: string[] = [];
        let closed = false;
        i++;
        while (i <= n) {
          const j = text.indexOf('"', i);
          if (j < 0) break;
          const chunk = text.slice(i, j);
          parts.push(chunk);
          for (let k = chunk.indexOf('\n'); k >= 0; k = chunk.indexOf('\n', k + 1)) line++;
          if (text.charCodeAt(j + 1) === QUOTE) { parts.push('"'); i = j + 2; continue; }
          i = j + 1; closed = true; break;
        }
        if (!closed) return { records, unbalancedQuote: true };
        // Lenient: characters between the closing quote and the delimiter stay part of the cell.
        let tail = '';
        const t = i;
        while (i < n && text.charCodeAt(i) !== COMMA && text.charCodeAt(i) !== LF && !(text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF)) i++;
        if (i > t) tail = text.slice(t, i);
        fields.push(parts.join('') + tail);
      } else {
        const s = i;
        while (i < n && text.charCodeAt(i) !== COMMA && text.charCodeAt(i) !== LF) i++;
        let e = i;
        if (e > s && text.charCodeAt(e - 1) === CR && (i >= n || text.charCodeAt(i) === LF)) e--;   // CRLF (also a CR at EOF)
        fields.push(text.slice(s, e));
      }
      const c = text.charCodeAt(i);
      if (c === COMMA) { i++; continue; }
      if (c === CR && text.charCodeAt(i + 1) === LF) i++;
      if (i < n) { i++; line++; }                        // consume the LF that ends the record
      break;
    }
    records.push({ line: startLine, fields });
    pos = i;
  }
  return { records, unbalancedQuote: false };
}
