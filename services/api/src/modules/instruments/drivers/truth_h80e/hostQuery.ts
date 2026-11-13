// truth_h80e host query — extract QRD-8.1, build QCK / DSR (08-ADDENDUM-TRUTH-H80E §5, §6, §8; LD-139, 2026-11-13).
// LD-139: the manual's DSR carries demographics + a detection mode and NO test list, so none is invented. Positions marked U stay options.
// Pure and deterministic: same query + same answers + same ctx => byte-identical bytes (the server rebuilds the reply on a duplicate query).
// HostQueryAnswer holds only sex/ageDays, so DSP-1..4, 6, 13 are empty (DSP-4 is never derived from an age; DSP-6 is always empty: PHI minimisation).
// Interim until CR-C7-018 (.orchestra/cr/H80-T03.nonblocking.md) adds optional demographic fields to HostQueryAnswer.
// §6: MSH-3/MSH-4 of LIS replies use the ack_sending_app/facility defaults LIS / LIMS (protocol_options is not reachable via DriverContext).
import { LimsError } from '../../../../core/errors.js';
import { MAX } from '../delimited.js';
import type { DriverContext, HostQueryAnswer, ParseOk } from '../types.js';

/** QRD-8.1 barcode of the (single) host_query record parse() produced. Anything else is instruments.message_malformed. */
export function extractHostQueryBarcodes(parsed: ParseOk): readonly string[] {
  const codes = parsed.messageKind !== 'host_query' ? [] : parsed.records.filter((r) => r.recordClass === 'host_query').map((r) => r.sampleBarcode);
  const ok = codes.length > 0 && codes.every((c) => c !== undefined && c.length >= 1 && c.length <= MAX.barcode);
  if (!ok) throw new LimsError('instruments.message_malformed');
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

const GENDER = { male: '1', female: '2' } as const;

export function buildHostQueryReply(input: { query: ParseOk; answers: readonly HostQueryAnswer[]; ctx: DriverContext }): readonly Uint8Array[] {
  const { query, ctx } = input;
  const a = input.answers[0];
  const ok = a !== undefined && a.status === 'found' && a.tests.length > 0; // OK only with >= 1 pending test mapped to this instrument (§5)
  const t = stamp(ctx.receivedAt, ctx.instrumentTimezone);
  const id = esc(query.messageControlId ?? '');
  const seg = (...f: string[]) => f.join('|') + '\r';
  const head = (type: string, n: string, tail: string) => seg(`MSH`, '^~\\&', 'LIS', 'LIMS', '', '', t, '', type, `${id}${n}`, 'P', '2.3' + tail);
  const body = (qak: string, status: string) => seg('MSA', 'AA', id, 'Message accepted', '', '', '0') + seg('ERR', '0') + seg('QAK', qak, status, '', '', '', '', '');
  const enc = (s: string) => new TextEncoder().encode(s);

  const qck = enc(head('QCK^Q02', '01', '|||||UTF-8||||') + body('SR', ok ? 'OK' : 'NF'));
  if (!ok || a === undefined) return [qck];

  const raw = ctx.options['host_query_detection_mode'];
  const mode = raw === 1 || raw === 2 ? String(raw) : '0'; // U: 1 whole blood, 2 haemolysis, 0 per instrument program
  const dsp = new Map<number, string>([[5, GENDER[a.sex as keyof typeof GENDER] ?? '0'], [21, esc(a.barcode)], [22, mode]]);
  let dsr = head('DSR^Q03', '02', '||||||UTF-8||||') + body('1', 'OK') + seg('QRD', t, 'R', 'D', '65', '', '', 'RD', '', 'OTH', '', '', 'T', '');
  for (let n = 1; n <= 22; n++) dsr += `DSP|${n}||${dsp.get(n) ?? ''}|||\r`;
  return [qck, enc(dsr + 'DSC|0|\r')];
}
