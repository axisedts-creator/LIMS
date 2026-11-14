// getein_metis host query — parse QRY^Q02, extract QRD-8.1, build QCK / DSR (09-ADDENDUM-GETEIN-METIS §5, §6, §8; LD-163, 2026-11-14; D-MET-1).
// D-MET-1: only the single-barcode query (mode a) is answered; sample-number-range and time-range queries (modes b, c) are answered NF (reason unsupported_query_mode).
// Pure and deterministic: same query + same answers + same ctx => byte-identical bytes (the server rebuilds the reply on a duplicate query).
// HostQueryAnswer holds only barcode/status/priority/sex/ageDays/tests, so DSP-1, 3, 4, 12, 23 stay empty and DSP-26 is `others` until CR-C7-018 adds optional fields
// (name_script, specimen_type_map: no per-sample input yet). DSP-4 is never derived from an age. DSP-2, 6-10 are always empty (PHI minimisation).
// QCK/DSR MSH-3..6 are blank as in the §5 examples (the LIS/LIMS defaults of §6 are for the ACK^R01 only).
import { LimsError } from '../../../../core/errors.js';
import { MAX, malformed } from '../delimited.js';
import type { DriverContext, HostQueryAnswer, ParseOk, ParseResult } from '../types.js';

// ParseOk has no room for what the reply must echo, so parse() keeps it here, keyed by the object it returned (replay re-parses the stored bytes).
const QUERIES = new WeakMap<object, { readonly qrd: string; readonly qrf: string; readonly range: boolean }>();

const CTRL = /[\x00-\x1f\x7f]/g; // an echoed segment must never carry MLLP framing bytes (0x0B, 0x1C) or line breaks

/** §5: mode (a) QRD-8 = barcode; (b)/(c) QRD-8 empty and QRF-2..5 filled. `lines` = the non-empty segments, lines[0] is MSH. */
export function parseQuery(lines: readonly string[], base: Omit<ParseOk, 'records' | 'warnings'>): ParseResult {
  if (!lines[0]!.startsWith('MSH|^~\\&|')) return malformed('unsupported delimiters'); // the echo below is only valid with the standard delimiters
  const find = (name: string) => lines.slice(1).find((l) => l.startsWith(name + '|'));
  const qrd = find('QRD'), qrf = find('QRF');
  const f = (s: string | undefined, n: number) => s?.split('|')[n]?.trim() ?? '';
  if (qrd === undefined) return malformed('host query without QRD');
  const range = f(qrd, 8) === '' && [2, 3, 4, 5].some((n) => f(qrf, n) !== '');
  const barcode = f(qrd, 8).split('~')[0]!.split('^')[0]!.trim();
  if (!range && barcode === '') return malformed('host query barcode missing');
  if (barcode.length > MAX.barcode) return malformed('host query barcode too long'); // never truncated
  const out: ParseOk = {
    ...base, messageKind: 'host_query', warnings: [],
    records: range ? [] : [{ recordSeq: 1, recordClass: 'host_query', sampleBarcode: barcode, instrumentFlags: [], warnings: [] }],
  };
  QUERIES.set(out, { qrd: qrd.replace(CTRL, ''), qrf: (qrf ?? 'QRF|').replace(CTRL, ''), range });
  return out;
}

/** Mode (a): [QRD-8.1]. Modes (b)/(c): [] (the reply is NF). Anything else is instruments.message_malformed. */
export function extractHostQueryBarcodes(parsed: ParseOk): readonly string[] {
  const q = QUERIES.get(parsed);
  if (parsed.messageKind !== 'host_query' || q === undefined) throw new LimsError('instruments.message_malformed');
  if (q.range) return [];
  const codes = parsed.records.filter((r) => r.recordClass === 'host_query').map((r) => r.sampleBarcode);
  if (codes.length !== 1 || codes[0] === undefined || codes[0].length < 1 || codes[0].length > MAX.barcode) throw new LimsError('instruments.message_malformed');
  return codes as string[];
}

// §5: | ^ ~ \ & -> \F\ \S\ \R\ \E\ \T\ in one pass (no double escaping); line breaks removed.
const ESC: Readonly<Record<string, string>> = { '\\': '\\E\\', '|': '\\F\\', '^': '\\S\\', '~': '\\R\\', '&': '\\T\\' };
const esc = (v: string) => v.replace(/[\r\n]/g, '').replace(/[\\|^~&]/g, (c) => ESC[c]!);

/** ctx.receivedAt (UTC ISO) as YYYYMMDDHHMMSS in the instrument timezone (§5 determinism: never the query's own time). */
function stamp(iso: string, tz: string): string {
  const d = new Date(iso);
  const fmt = (zone: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
  };
  try { return fmt(tz); } catch { return fmt('UTC'); } // ponytail: unknown zone falls back to UTC; options are validated upstream
}

const SEX = { male: 'M', female: 'F' } as const;

export function buildHostQueryReply(input: { query: ParseOk; answers: readonly HostQueryAnswer[]; ctx: DriverContext }): readonly Uint8Array[] {
  const { query, ctx } = input;
  const q = QUERIES.get(query);
  if (q === undefined) throw new LimsError('instruments.message_malformed'); // not a query this driver parsed
  const a = input.answers[0]; // one sample per reply (release 1)
  const ok = !q.range && a !== undefined && a.status === 'found' && a.tests.length > 0; // OK only with >= 1 pending test mapped to this instrument
  const t = stamp(ctx.receivedAt, ctx.instrumentTimezone);
  const id = esc(query.messageControlId ?? '');
  const seg = (...f: string[]) => f.join('|') + '|\r'; // trailing pipe on every segment, as in the manual's examples
  const head = (type: string) => `MSH|^~\\&|||||${t}||${type}|${id}|P|2.3.1||||||UTF8|||\r`;
  const body = (status: string) => seg('MSA', 'AA', id, 'Message accepted', '', '', '0') + seg('ERR', '0') + seg('QAK', 'SR', status);
  const enc = (s: string) => new TextEncoder().encode(s);

  const qck = enc(head('QCK^Q02') + body(ok ? 'OK' : 'NF'));
  if (!ok || a === undefined) return [qck];

  // dsr_item_details: id_only = `100^^^`; `full` has the same four components, but HostQueryAnswer has no name/unit/range yet (CR-C7-018), so both give `id^^^` today.
  const detail = '^^^';
  const dsp = new Map<number, string>([
    [5, SEX[a.sex as keyof typeof SEX] ?? 'O'],
    [21, esc(a.barcode)],
    [24, a.priority === 'urgent' ? 'Y' : 'N'],
    [26, 'others'],
  ]);
  let dsr = head('DSR^Q03') + body('OK') + q.qrd + '\r' + q.qrf + '\r';
  for (let n = 1; n <= 28; n++) dsr += seg('DSP', String(n), '', dsp.get(n) ?? '', '', '');
  a.tests.forEach((x, i) => { dsr += seg('DSP', String(29 + i), '', esc(x.instrumentCode) + detail, '', ''); });
  return [qck, enc(dsr + seg('DSC', ''))];
}
