// C7 MET-T03 — Getein Metis host query: extract barcode, build QCK / DSR with a test list, OK-NF rules, deterministic replay
// (09-ADDENDUM-GETEIN-METIS §5, §6, §8; LD-163, 2026-11-14; D-MET-1: only the single-barcode query is answered, modes (b)/(c) are NF).
// Tests first; synthetic data only. Golden files live in drivers/getein_metis/testdata/*.hl7 (LF in the files, converted to HL7 CR here).
// SEAMS (spec gaps chosen here, flagged in .orchestra/notes/MET-T03-tests.md):
//   * parse() of QRY^Q02 returns ok:true, messageKind 'host_query'. Mode (a): ONE record { recordClass:'host_query', sampleBarcode: QRD-8.1 }.
//     Modes (b)/(c): extractHostQueryBarcodes returns []. An empty / >40 barcode in a barcode query fails either in parse() (ok:false) or in
//     extractHostQueryBarcodes (LimsError instruments.message_malformed). ParseOk is all buildHostQueryReply gets, so the driver must carry
//     what it needs to echo QRD/QRF and tell mode (a) from (b)/(c) through the object parse() returned (a rebuilt query on replay re-parses the stored bytes).
//   * replies are HL7 text, CR after every segment incl. the last (no MLLP framing: the agent's job), a trailing pipe on every segment, QCK/DSR MSH-3..6 blank
//     exactly as the §5 examples (the LIS/LIMS defaults of §6 are for the ACK^R01 only), MSH-18 = UTF8.
//   * HostQueryAnswer (drivers/types.ts) holds only barcode, status, priority, sex, ageDays, tests: so DSP-1..4, 12, 23 stay empty (as in the H80E interim, CR-C7-018),
//     DSP-24 = Y for priority 'urgent' else N, DSP-26 = 'others' (no specimen type reaches the driver: "anything else -> others"), DSP-5 = M / F / O.
//     name_script and specimen_type_map therefore have no per-sample input yet: they are proven as options (schema accepts / rejects, no effect on the bytes today) and the
//     data-dependent effect is an it.todo until the answer carries the fields (CR-C7-018 and a specimen-type field; no name is invented here).
//   * a 'found' answer with an empty tests[] is NF; QRD/QRF in the DSR are the query's own segments, byte for byte (the manual's DSR example differs in QRD-4/QRD-8: U14).
import { AjvCompiler } from '@fastify/ajv-compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AJV_OPTIONS } from '../../../core/openapi.js';
import { rejection } from './agents.helpers.js';
import { AN, BARCODE, TEST, defaultInstruments, hqBody, hqSetup } from './hostQuery.helpers.js';
import { getDriver } from '../drivers/registry.js';
import { geteinMetis } from '../drivers/getein_metis/index.js';
import type { HostQueryAnswer } from '../drivers/types.js';
import { createHostQueryService } from '../service/hostQuery.service.js';

const FIX = fileURLToPath(new URL('../drivers/getein_metis/testdata/', import.meta.url));
const fixture = (n: string) => readFileSync(join(FIX, `${n}.hl7`), 'utf8').replace(/\r?\n/g, '\r'); // HL7 segment end = CR, final CR kept
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
const drv = () => getDriver('getein_metis')!;
const ctx = (o: { options?: Record<string, unknown>; receivedAt?: string; capturedAt?: string; tz?: string } = {}) => ({
  receivedAt: o.receivedAt ?? '2026-11-14T05:02:01.000Z', // = 2026-11-14 10:47:01 in Asia/Kathmandu (+05:45) = the §5 example's QCK/DSR MSH-7
  capturedAt: o.capturedAt ?? '2026-11-14T05:02:00.000Z', instrumentTimezone: o.tz ?? 'Asia/Kathmandu', qcSampleIdPatterns: [], options: o.options ?? {},
}) as never;
const parseOk = (bytes: Uint8Array | string, c = ctx()): any => {
  const r: any = drv().parse(typeof bytes === 'string' ? enc(bytes) : bytes, c);
  if (!r.ok) throw new Error(`expected ok parse, got ${JSON.stringify(r)}`);
  return r;
};
const extract = (bytes: Uint8Array | string): { code?: string; barcodes?: string[] } => {
  const r: any = drv().parse(typeof bytes === 'string' ? enc(bytes) : bytes, ctx());
  if (!r.ok) return { code: r.errorCode };
  try { return { barcodes: [...drv().extractHostQueryBarcodes!(r)] }; } catch (e) { return { code: (e as { code?: string }).code ?? `non-LimsError:${String(e)}` }; }
};
const build = (query: string, answers: readonly HostQueryAnswer[], c = ctx()): string[] =>
  drv().buildHostQueryReply!({ query: parseOk(query, c), answers, ctx: c }).map(dec);

const NEW = 'MT2600000042';
const TESTS = [{ testId: TEST.glu, analyteId: AN.glu, instrumentCode: '100' }, { testId: TEST.elec, analyteId: AN.na, instrumentCode: '101' }];
const found = (o: Partial<HostQueryAnswer> = {}): HostQueryAnswer => ({ barcode: NEW, status: 'found', sex: 'female', ageDays: 9000, priority: 'routine', tests: TESTS, ...o });
const notFound = (status: HostQueryAnswer['status'] = 'not_found', barcode = NEW): HostQueryAnswer => ({ barcode, status, tests: [] });
const QRY = (barcode: string, over: { id?: string; time?: string; qrd4?: string } = {}) =>
  `MSH|^~\\&|||||${over.time ?? '20261114104700'}||QRY^Q02|${over.id ?? '61'}|P|2.3.1||||||UTF8|||\rQRD|20261114104700|R|D|${over.qrd4 ?? '9'}|||RD|${barcode}|OTH|||T|\rQRF||||||RCT|COR|ALL||\r`;
const seg = (m: string) => m.split('\r').filter((s) => s.length > 0);
const field = (m: string, segName: string, n: number) => seg(m).find((s) => s.startsWith(segName + '|'))!.split('|')[segName === 'MSH' ? n - 1 : n];
const dsp = (m: string, n: number) => seg(m).find((s) => s.startsWith(`DSP|${n}|`))!.split('|')[3];
const dspRow = (m: string, n: number) => seg(m).find((s) => s.startsWith(`DSP|${n}|`))!;

// ================================================================================================================================
describe('extractHostQueryBarcodes — QRD-8 component 1, mode (a) only (addendum §5, §8; D-MET-1)', () => {
  it('registered getein_metis driver exposes both host-query functions; status stays generic (§0, LD-163)', () => {
    expect(typeof drv().extractHostQueryBarcodes).toBe('function');
    expect(typeof drv().buildHostQueryReply).toBe('function');
    expect(drv().status).toBe('generic');
  });
  it('golden qry-found: parse is a host_query with one record carrying the barcode; extract returns exactly [MT2600000042]', () => {
    const p = parseOk(fixture('qry-found'));
    expect(p).toMatchObject({ ok: true, messageKind: 'host_query', messageControlId: '61' });
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ recordClass: 'host_query', sampleBarcode: NEW });
    expect(extract(fixture('qry-found'))).toEqual({ barcodes: [NEW] });
  });
  it('golden qry-not-found and qry-no-mapped-test parse like any barcode query (the answer, not the query, decides NF)', () => {
    expect(extract(fixture('qry-not-found'))).toEqual({ barcodes: ['MT2600000099'] });
    expect(extract(fixture('qry-no-mapped-test'))).toEqual({ barcodes: ['MT2600000043'] });
  });
  it('golden qry-sample-range and qry-time-range: parse ok as host_query, extract returns an EMPTY list (answered NF, reason unsupported_query_mode)', () => {
    for (const n of ['qry-sample-range', 'qry-time-range']) {
      expect(parseOk(fixture(n)), n).toMatchObject({ ok: true, messageKind: 'host_query' });
      expect(extract(fixture(n)), n).toEqual({ barcodes: [] });
    }
  });
  it('a range query never leaks a number or a time as a barcode (QRF-2..5 are not barcodes)', () => {
    for (const n of ['qry-sample-range', 'qry-time-range']) {
      const p = parseOk(fixture(n));
      expect(p.records.filter((r: any) => r.recordClass === 'host_query' && r.sampleBarcode !== undefined), n).toEqual([]);
    }
  });
  it('only component 1 of QRD-8 is used (MT26...^x -> MT26...)', () => {
    expect(extract(QRY(`${NEW}^extra^more`))).toEqual({ barcodes: [NEW] });
  });
  it('length bound: exactly 40 characters is accepted, 41 is instruments.message_malformed (never truncated)', () => {
    expect(extract(QRY('M'.repeat(40)))).toEqual({ barcodes: ['M'.repeat(40)] });
    expect(extract(QRY('M'.repeat(41)))).toEqual({ code: 'instruments.message_malformed' });
  });
  it('barcode query with empty QRD-8, empty component 1, QRD too short, or no QRD => instruments.message_malformed', () => {
    expect(extract(QRY(''))).toEqual({ code: 'instruments.message_malformed' });
    expect(extract(QRY('^only-second-component'))).toEqual({ code: 'instruments.message_malformed' });
    expect(extract('MSH|^~\\&|||||20261114104700||QRY^Q02|61|P|2.3.1||||||UTF8|||\rQRD|20261114104700|R|D|9\rQRF||||||RCT|COR|ALL||\r')).toEqual({ code: 'instruments.message_malformed' });
    expect(extract('MSH|^~\\&|||||20261114104700||QRY^Q02|61|P|2.3.1||||||UTF8|||\rQRF||||||RCT|COR|ALL||\r')).toEqual({ code: 'instruments.message_malformed' });
  });
  it('a query with no MSH is malformed; the reason string carries no barcode (no PHI)', () => {
    const r: any = drv().parse(enc('QRD|20261114104700|R|D|9|||RD|MT2600000042|OTH|||T|\r'), ctx());
    expect(r).toMatchObject({ ok: false, errorCode: 'instruments.message_malformed' });
    expect(String(r.reason)).not.toContain(NEW);
  });
  it('hostile: CR/LF smuggling inside the barcode field cannot create a second barcode or segment', () => {
    const out = extract(`MSH|^~\\&|||||20261114104700||QRY^Q02|61|P|2.3.1||||||UTF8|||\rQRD|20261114104700|R|D|9|||RD|${NEW}\rQRD|x|x|x|x|||RD|MT2600000777|OTH|||T|\r`);
    expect(out.barcodes === undefined || out.barcodes.length === 1).toBe(true);
    if (out.barcodes) expect(out.barcodes[0]).toBe(NEW);
  });
  it('fuzz: 200 deterministic truncations/corruptions of a valid query never throw anything but instruments.message_malformed', () => {
    let seed = 0x1badf00d;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const valid = enc(fixture('qry-found'));
    for (let i = 0; i < 200; i++) {
      const b = i % 2 === 0 ? valid.slice(0, Math.floor(rnd() * valid.length)) : Uint8Array.from(valid, (x) => (rnd() < 0.05 ? Math.floor(rnd() * 256) : x));
      const o = extract(b);
      if (o.code !== undefined) expect(o.code).toBe('instruments.message_malformed');
      else { expect(Array.isArray(o.barcodes)).toBe(true); for (const bc of o.barcodes!) expect(bc.length >= 1 && bc.length <= 40).toBe(true); }
    }
  });
  it('golden ack-q03-mismatched-id: MSA-2 (99) differs from the DSR id: accepted, not matched — ok, kind other, no records, no warnings (§6)', () => {
    for (const msa2 of ['99', '61', '62', '12345']) {
      const p = parseOk(fixture('ack-q03-mismatched-id').replace('MSA|AA|99|', `MSA|AA|${msa2}|`));
      expect(p).toMatchObject({ ok: true, messageKind: 'other', messageControlId: '62' });
      expect(p.records).toEqual([]);
      expect(p.warnings).toEqual([]);
    }
  });
});

// ================================================================================================================================
describe('buildHostQueryReply — [QCK] for NF, [QCK, DSR] for OK, byte-exact goldens (§5)', () => {
  it('golden qry-found: OK => exactly two messages, QCK then DSR, byte-identical to the fixtures (trailing pipe on every segment)', () => {
    const r = build(fixture('qry-found'), [found()]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBe(fixture('qry-found.qck'));
    expect(r[1]).toBe(fixture('qry-found.dsr'));
    for (const s of seg(r.join(''))) expect(s.endsWith('|'), s).toBe(true);
  });
  it('golden qry-not-found: unknown barcode => exactly one message (QCK NF), no DSR', () => {
    expect(build(fixture('qry-not-found'), [notFound('not_found', 'MT2600000099')])).toEqual([fixture('qry-not-found.qck')]);
  });
  it('golden qry-no-mapped-test: no mapped pending test (no_mapped_tests) => one message (QCK NF), no DSR', () => {
    expect(build(fixture('qry-no-mapped-test'), [notFound('no_mapped_tests', 'MT2600000043')])).toEqual([fixture('qry-no-mapped-test.qck')]);
  });
  it('golden qry-sample-range and qry-time-range: no barcode, no answers => one message, QCK NF, byte-identical to the fixtures', () => {
    expect(build(fixture('qry-sample-range'), [])).toEqual([fixture('qry-sample-range.qck')]);
    expect(build(fixture('qry-time-range'), [])).toEqual([fixture('qry-time-range.qck')]);
  });
  it('modes (b)/(c) are NF even if an answer (found, with tests) is handed in by mistake: never a DSR for a range query', () => {
    for (const n of ['qry-sample-range', 'qry-time-range']) {
      const r = build(fixture(n), [found()]);
      expect(r, n).toHaveLength(1);
      expect(field(r[0]!, 'QAK', 2), n).toBe('NF');
    }
  });
  it('every non-found status is NF with exactly one message; the QCK never echoes the barcode (PHI minimisation)', () => {
    for (const s of ['not_found', 'not_receivable', 'no_mapped_tests'] as const) {
      const r = build(fixture('qry-found'), [notFound(s)]);
      expect(r, s).toHaveLength(1);
      expect(field(r[0]!, 'QAK', 2), s).toBe('NF');
      expect(r[0], s).not.toContain(NEW);
    }
  });
  it('rule: OK only with at least one pending mapped test — status found with tests [] is NF; no answer at all is NF', () => {
    for (const a of [[found({ tests: [] })], []]) {
      const r = build(fixture('qry-found'), a);
      expect(r).toHaveLength(1);
      expect(field(r[0]!, 'QAK', 2)).toBe('NF');
    }
  });
  it('QCK and DSR carry the QUERY MSH-10 as their own MSH-10 and as MSA-2 (no suffix, unlike H80E); types QCK^Q02 / DSR^Q03; MSA text "Message accepted", code 0', () => {
    const r = build(QRY(NEW, { id: '7788' }), [found()]);
    expect(field(r[0]!, 'MSH', 9)).toBe('QCK^Q02'); expect(field(r[0]!, 'MSH', 10)).toBe('7788'); expect(field(r[0]!, 'MSA', 2)).toBe('7788');
    expect(field(r[1]!, 'MSH', 9)).toBe('DSR^Q03'); expect(field(r[1]!, 'MSH', 10)).toBe('7788'); expect(field(r[1]!, 'MSA', 2)).toBe('7788');
    for (const m of r) { expect(seg(m).find((s) => s.startsWith('MSA|'))).toBe('MSA|AA|7788|Message accepted|||0|'); expect(seg(m).find((s) => s.startsWith('ERR|'))).toBe('ERR|0|'); }
  });
  it('segment order: QCK = MSH MSA ERR QAK; DSR = MSH MSA ERR QAK QRD QRF DSP x (28 + tests) DSC; no OBR/OBX/ORC (the test list is DSP items, not orders)', () => {
    const r = build(fixture('qry-found'), [found()]);
    expect(seg(r[0]!).map((s) => s.slice(0, 3))).toEqual(['MSH', 'MSA', 'ERR', 'QAK']);
    expect(seg(r[1]!).map((s) => s.slice(0, 3))).toEqual(['MSH', 'MSA', 'ERR', 'QAK', 'QRD', 'QRF', ...Array<string>(30).fill('DSP'), 'DSC']);
    expect(r.join('')).not.toMatch(/OBX|OBR|ORC|TQ1/);
  });
  it('output is Uint8Array UTF-8 text with every segment ended by CR (no MLLP framing bytes, no LF)', () => {
    const raw = drv().buildHostQueryReply!({ query: parseOk(fixture('qry-found')), answers: [found()], ctx: ctx() });
    expect(raw).toHaveLength(2);
    for (const b of raw) {
      expect(b).toBeInstanceOf(Uint8Array);
      expect(b.includes(0x0b) || b.includes(0x1c) || b.includes(0x0a)).toBe(false);
      expect(dec(b).endsWith('\r')).toBe(true);
    }
  });
  it('MSH-3..6 blank, MSH-12 2.3.1, MSH-16 blank, MSH-18 UTF8 on QCK and DSR (§5 examples; MSH-16 blank per §2)', () => {
    for (const m of build(fixture('qry-found'), [found()])) {
      const f = seg(m)[0]!.split('|');
      expect([f[2], f[3], f[4], f[5]]).toEqual(['', '', '', '']);
      expect(f[11]).toBe('2.3.1'); expect(f[15]).toBe(''); expect(f[17]).toBe('UTF8'); expect(f[10]).toBe('P');
    }
  });
});

describe('QRD / QRF are echoed from the query (§5 determinism)', () => {
  it('the DSR echoes the query\'s own QRD and QRF bytes, not constants (other QRD-1 / QRD-4 / QRD-8 come back unchanged)', () => {
    const q = QRY('MT2600000555', { qrd4: '12', time: '20260101010101' }).replace('QRD|20261114104700', 'QRD|20260101010101');
    const d = build(q, [found({ barcode: 'MT2600000555' })])[1]!;
    expect(seg(d).find((s) => s.startsWith('QRD|'))).toBe('QRD|20260101010101|R|D|12|||RD|MT2600000555|OTH|||T|');
    expect(seg(d).find((s) => s.startsWith('QRF|'))).toBe('QRF||||||RCT|COR|ALL||');
  });
  it('a query carrying a second QRD/QRF pair does not double the echo: the DSR has exactly one QRD and one QRF', () => {
    const q = QRY(NEW) + 'QRD|x|x|x|x|||RD|MT2600000777|OTH|||T|\rQRF||||||RCT|COR|ALL||\r';
    const d = build(q, [found()])[1]!;
    expect(seg(d).filter((s) => s.startsWith('QRD|'))).toHaveLength(1);
    expect(seg(d).filter((s) => s.startsWith('QRF|'))).toHaveLength(1);
    expect(d).not.toContain('MT2600000777');
  });
});

describe('MSH-7 = ctx.receivedAt rendered in the instrument timezone (§5 determinism)', () => {
  it('Asia/Kathmandu (+05:45): 05:02:01Z => 20261114104701 on QCK and DSR', () => {
    const r = build(fixture('qry-found'), [found()]);
    expect(field(r[0]!, 'MSH', 7)).toBe('20261114104701'); expect(field(r[1]!, 'MSH', 7)).toBe('20261114104701');
  });
  it('the query\'s own MSH-7 / capturedAt are NOT used', () => {
    const r = build(QRY(NEW, { time: '20200101000000' }), [found()], ctx({ capturedAt: '2030-01-01T00:00:00.000Z' }));
    expect(field(r[0]!, 'MSH', 7)).toBe('20261114104701');
  });
  it('UTC zone and a day rollover (20:30Z => 02:15:00 next day in Kathmandu)', () => {
    expect(field(build(fixture('qry-found'), [found()], ctx({ tz: 'UTC' }))[0]!, 'MSH', 7)).toBe('20261114050201');
    expect(field(build(fixture('qry-found'), [found()], ctx({ receivedAt: '2026-11-14T20:30:00.000Z' }))[0]!, 'MSH', 7)).toBe('20261115021500');
  });
});

// ================================================================================================================================
describe('DSR content: DSP items 1 to 28 per the table, DSP-29+ one per mapped test (§5)', () => {
  it('DSP-5 sex: male M, female F, other / unknown / absent O', () => {
    const g = (sex?: HostQueryAnswer['sex']) => {
      const { sex: _drop, ...rest } = found();
      return dsp(build(fixture('qry-found'), [sex ? { ...rest, sex } : rest])[1]!, 5);
    };
    expect([g('male'), g('female'), g('other'), g('unknown'), g(undefined)]).toEqual(['M', 'F', 'O', 'O', 'O']);
  });
  it('DSP-4 date of birth stays empty when only an age is known — never invented from ageDays; DSP-2 bed and DSP-6..10 are always empty', () => {
    const d = build(fixture('qry-found'), [found({ ageDays: 12345 })])[1]!;
    for (const n of [2, 4, 6, 7, 8, 9, 10]) expect(dsp(d, n), `DSP-${n}`).toBe('');
    expect(seg(d).filter((s) => s.startsWith('DSP|')).map((s) => s.split('|')[3]).filter((v) => /^(19|20)\d{6}/.test(v!))).toEqual([]);
  });
  it('items 11, 13-20, 22, 25, 27, 28 are empty and present (every DSP 1..28 exists once, in order, even when empty)', () => {
    const d = build(fixture('qry-found'), [found()])[1]!;
    for (const n of [11, 13, 14, 15, 16, 17, 18, 19, 20, 22, 25, 27, 28]) expect(dsp(d, n), `DSP-${n}`).toBe('');
    expect(seg(d).filter((s) => s.startsWith('DSP|')).slice(0, 28).map((s) => s.split('|')[1])).toEqual(Array.from({ length: 28 }, (_, i) => String(i + 1)));
  });
  it('DSP-21 echoes the queried barcode (the answer\'s barcode)', () => {
    expect(dsp(build(fixture('qry-found'), [found()])[1]!, 21)).toBe(NEW);
  });
  it('DSP-24 emergency is ALWAYS filled: Y for priority urgent, N for routine and for no priority', () => {
    const e = (priority?: HostQueryAnswer['priority']) => {
      const { priority: _drop, ...rest } = found();
      return dsp(build(fixture('qry-found'), [priority ? { ...rest, priority } : rest])[1]!, 24);
    };
    expect([e('urgent'), e('routine'), e(undefined)]).toEqual(['Y', 'N', 'N']);
  });
  it('DSP-26 sample type is ALWAYS filled (never empty); with no specimen type known to the driver it is "others"', () => {
    const v = dsp(build(fixture('qry-found'), [found()])[1]!, 26);
    expect(v).not.toBe(''); expect(v).toBe('others');
  });
  it('DSP-29 and up: one DSP per mapped test, item id = the instrument code, in answer order, empty name/unit/range (id_only is the default)', () => {
    const d = build(fixture('qry-found'), [found()])[1]!;
    expect(dspRow(d, 29)).toBe('DSP|29||100^^^|||');
    expect(dspRow(d, 30)).toBe('DSP|30||101^^^|||');
    expect(seg(d).filter((s) => s.startsWith('DSP|'))).toHaveLength(30);
    const one = build(fixture('qry-found'), [found({ tests: [TESTS[1]!] })])[1]!;
    expect(dspRow(one, 29)).toBe('DSP|29||101^^^|||');
    expect(seg(one).filter((s) => s.startsWith('DSP|'))).toHaveLength(29);
  });
  it('the number of DSP-29+ rows follows the test list exactly (0 tests = NF, 1, 5 and 40 tests)', () => {
    for (const n of [1, 5, 40]) {
      const tests = Array.from({ length: n }, (_, i) => ({ testId: TEST.glu, analyteId: AN.glu, instrumentCode: String(200 + i) }));
      const d = build(fixture('qry-found'), [found({ tests })])[1]!;
      expect(seg(d).filter((s) => s.startsWith('DSP|')), `${n} tests`).toHaveLength(28 + n);
      expect(dspRow(d, 28 + n)).toBe(`DSP|${28 + n}||${200 + n - 1}^^^|||`);
    }
  });
  it('DSC is the last segment, with an empty continuation field (one sample per reply)', () => {
    const s = seg(build(fixture('qry-found'), [found()])[1]!);
    expect(s[s.length - 1]).toBe('DSC||');
    expect(s.filter((x) => x.startsWith('DSC'))).toHaveLength(1);
  });
  it('multiple answers in one call: only the first sample is answered, one DSR (release 1 sends one DSR per query)', () => {
    const r = build(fixture('qry-found'), [found(), found({ barcode: 'MT2600000044' })]);
    expect(r).toHaveLength(2);
    expect(seg(r[1]!).filter((s) => s.startsWith('DSC'))).toHaveLength(1);
    expect(r.join('')).not.toContain('MT2600000044');
  });
});

describe('HL7 escaping and injection (§5: | ^ ~ \\ & become \\F\\ \\S\\ \\R\\ \\E\\ \\T\\, line breaks removed)', () => {
  it('| ^ ~ \\ & in the barcode and in a test item id are escaped in one pass (never double-escaped)', () => {
    const d = build(fixture('qry-found'), [found({ barcode: 'M26&1\\2|3^4~5', tests: [{ testId: TEST.glu, analyteId: AN.glu, instrumentCode: 'A&B|C^D' }] })])[1]!;
    expect(dspRow(d, 21)).toBe('DSP|21||M26\\T\\1\\E\\2\\F\\3\\S\\4\\R\\5|||');
    expect(dspRow(d, 29)).toBe('DSP|29||A\\T\\B\\F\\C\\S\\D^^^|||');
  });
  it('line breaks are removed and cannot start a new segment (MSH only first)', () => {
    const d = build(fixture('qry-found'), [found({ barcode: 'M26\r\nMSH|x\nPID|1' })])[1]!;
    expect(seg(d)).toHaveLength(37); // MSH MSA ERR QAK QRD QRF + 30 DSP + DSC
    expect(seg(d).filter((s) => s.startsWith('MSH|'))).toHaveLength(1);
    expect(dspRow(d, 21)).toBe('DSP|21||M26MSH\\F\\xPID\\F\\1|||');
  });
  it('a hostile query control id (MSH-10 containing &) is escaped in MSH-10 and MSA-2, never raw', () => {
    const r = build(QRY(NEW, { id: '1&2' }), [found()]);
    for (const m of r) { expect(field(m, 'MSA', 2)).toBe('1\\T\\2'); expect(field(m, 'MSH', 10)).toBe('1\\T\\2'); }
  });
});

describe('option tests: name_script, specimen_type_map, dsr_item_details (§5 DSP table, §8 optionsSchema)', () => {
  const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => (v: unknown) => boolean;
  // AJV_OPTIONS = the project validator (removeAdditional:false, REQ-SEC-080); see .orchestra/notes/H80-T02-ruling.md
  const valid = (v: unknown) => factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, strict: false, allErrors: true } })({ schema: drv().optionsSchema })(v);

  it('optionsSchema accepts the three options with legal values and rejects illegal ones (name_script enum, dsr_item_details enum, map value types, unknown keys)', () => {
    expect(valid({})).toBe(true);
    expect(valid({ name_script: 'as_registered' })).toBe(true);
    expect(valid({ name_script: 'latin_if_available' })).toBe(true);
    expect(valid({ name_script: 'devanagari' })).toBe(false);
    expect(valid({ dsr_item_details: 'id_only' })).toBe(true);
    expect(valid({ dsr_item_details: 'full' })).toBe(true);
    expect(valid({ dsr_item_details: 'everything' })).toBe(false);
    expect(valid({ specimen_type_map: { serum: 'serum', 'whole blood': 'blood' } })).toBe(true);
    expect(valid({ specimen_type_map: { serum: 7 } })).toBe(false);
    expect(valid({ specimen_type_map: { serum: '' } })).toBe(false);
    expect(valid({ host_query_detection_mode: 1 })).toBe(false); // an H80E option, not Metis
  });
  it('default dsr_item_details is id_only: no option, "id_only" and a junk-free default give the same DSR bytes', () => {
    const base = build(fixture('qry-found'), [found()]);
    expect(build(fixture('qry-found'), [found()], ctx({ options: { dsr_item_details: 'id_only' } }))).toEqual(base);
    expect(dspRow(base[1]!, 29)).toBe('DSP|29||100^^^|||');
  });
  it('dsr_item_details = full: same item ids and count, still four ^-components per test item (id^name^unit^range); the QCK is untouched', () => {
    const base = build(fixture('qry-found'), [found()]);
    const full = build(fixture('qry-found'), [found()], ctx({ options: { dsr_item_details: 'full' } }));
    expect(full[0]).toBe(base[0]);
    expect(seg(full[1]!).filter((s) => s.startsWith('DSP|'))).toHaveLength(30);
    for (const [n, id] of [[29, '100'], [30, '101']] as const) {
      const v = dsp(full[1]!, n)!;
      expect(v.split('^')[0]).toBe(id);
      expect(v.split('^')).toHaveLength(4);
    }
    // everything outside DSP-29+ is identical
    expect(seg(full[1]!).slice(0, 34)).toEqual(seg(base[1]!).slice(0, 34));
  });
  it('name_script and specimen_type_map change nothing for an answer that carries no name / specimen type (DSP-3 empty, DSP-26 others)', () => {
    const base = build(fixture('qry-found'), [found()]);
    for (const options of [{ name_script: 'latin_if_available' }, { name_script: 'as_registered' }, { specimen_type_map: { serum: 'serum' } }]) {
      expect(build(fixture('qry-found'), [found()], ctx({ options })), JSON.stringify(options)).toEqual(base);
    }
    expect(dsp(base[1]!, 3)).toBe('');
  });
  it('options never touch QCK for NF either', () => {
    const base = build(fixture('qry-not-found'), [notFound('not_found', 'MT2600000099')]);
    expect(build(fixture('qry-not-found'), [notFound('not_found', 'MT2600000099')], ctx({ options: { dsr_item_details: 'full', name_script: 'latin_if_available' } }))).toEqual(base);
  });
  // Blocked by the answer shape (HostQueryAnswer has no name / Latin name / specimen type). Need CR-C7-018 (+ a specimen-type field) before these can be written.
  it.todo('name_script = latin_if_available puts the Latin name in DSP-3 when the answer has one, else the registered name; as_registered always the registered name (<= 32 chars, escaped)');
  it.todo('specimen_type_map maps serum/plasma/whole blood/urine/CSF per the table and any unmapped specimen type to "others" in DSP-26');
  it.todo('DSP-1 patient id, DSP-3 name (<= 32), DSP-4 date of birth (time 000000, only if recorded), DSP-12 collection time, DSP-23 received time from the answer');
});

describe('deterministic replay (§5: the server rebuilds the reply on a duplicate query)', () => {
  it('same query bytes + same answers + same ctx => byte-identical replies, repeated 5 times, from separately parsed queries', () => {
    const first = drv().buildHostQueryReply!({ query: parseOk(fixture('qry-found')), answers: [found()], ctx: ctx() });
    for (let i = 0; i < 5; i++) {
      const again = drv().buildHostQueryReply!({ query: parseOk(fixture('qry-found')), answers: [found()], ctx: ctx() });
      expect(again).toHaveLength(first.length);
      again.forEach((b, k) => expect(Buffer.from(b).equals(Buffer.from(first[k]!))).toBe(true));
    }
  });
  it('replay from the stored bytes (re-parse after a round trip through base64) equals the first reply', () => {
    const raw = Buffer.from(fixture('qry-found'), 'utf8');
    const first = build(fixture('qry-found'), [found()]);
    const again = drv().buildHostQueryReply!({ query: parseOk(Buffer.from(raw.toString('base64'), 'base64')), answers: [found()], ctx: ctx() }).map(dec);
    expect(again).toEqual(first);
  });
  it('NF replay is byte-identical too; capturedAt, ageDays and an unknown-to-the-reply field do not change the bytes; inputs are not mutated', () => {
    const answers = Object.freeze([Object.freeze(found())]);
    const base = build(fixture('qry-found'), answers);
    expect(build(fixture('qry-found'), [found({ ageDays: 1 })], ctx({ capturedAt: '2031-02-03T04:05:06.000Z' }))).toEqual(base);
    expect(build(fixture('qry-not-found'), [notFound()])).toEqual(build(fixture('qry-not-found'), [notFound()]));
    expect(answers[0]).toEqual(found());
  });
  it('a changed order state changes the answer: found -> NF after the order is no longer pending; urgent -> DSP-24 Y', () => {
    expect(build(fixture('qry-found'), [found()])).toHaveLength(2);
    expect(build(fixture('qry-found'), [notFound('no_mapped_tests')])).toHaveLength(1);
    expect(dsp(build(fixture('qry-found'), [found({ priority: 'urgent' })])[1]!, 24)).toBe('Y');
  });
});

// ================================================================================================================================
describe('host query stays inert while status is not verified (§0, §6.6 step 2; AC-10.4)', () => {
  const instruments = () => defaultInstruments().map((i) => ({ ...i, driver_code: 'getein_metis', protocol: 'hl7v2' }));
  const run = (s: ReturnType<typeof hqSetup>, raw: string, getDriverFn?: (c: string) => unknown, n = 1) =>
    createHostQueryService({ repo: s.repo, ...(getDriverFn ? { getDriver: getDriverFn as never } : {}) }).submitHostQuery(s.ctx, { body: hqBody({ n, protocol: 'hl7v2', raw: Buffer.from(raw, 'utf8') }) });
  const verified = (c: string) => (c === 'getein_metis' ? { ...geteinMetis, status: 'verified' as const } : undefined);

  it('the registered driver is generic: a live instrument with cap_host_query on is still refused with instruments.capability_not_supported, nothing asked of C5, nothing parsed', async () => {
    const s = hqSetup({ instruments: instruments() });
    const e = await rejection(run(s, QRY(BARCODE)));
    expect(e?.code).toBe('instruments.capability_not_supported');
    expect(s.lab.calls).toHaveLength(0); expect(s.catalog.calls).toHaveLength(0);
    expect(s.world.runs[0]).toMatchObject({ outcome: 'rejected_capability', driver_code: 'getein_metis' });
  });

  it('end to end (driver forced to verified in the test only): found => two reply_messages QCK OK + DSR with the query id, summary has no barcode', async () => {
    const s = hqSetup({ instruments: instruments() });
    const r: any = await run(s, QRY(BARCODE), verified);
    expect(r.status).toBe(200);
    const msgs = r.body.reply_messages.map((m: { raw_base64: string }) => Buffer.from(m.raw_base64, 'base64').toString('utf8'));
    expect(msgs).toHaveLength(2);
    expect(field(msgs[0], 'MSH', 9)).toBe('QCK^Q02'); expect(field(msgs[0], 'QAK', 2)).toBe('OK'); expect(field(msgs[0], 'MSA', 2)).toBe('61');
    expect(field(msgs[1], 'MSH', 9)).toBe('DSR^Q03'); expect(field(msgs[1], 'MSH', 10)).toBe('61');
    expect(dspRow(msgs[1], 21)).toBe(`DSP|21||${BARCODE}|||`);
    expect(r.body.answer_summary).toEqual([{ index: 0, status: 'found', test_count: 2 }]); // glu + na mapped, k unmapped (helpers' default order)
    expect(JSON.stringify(r.body.answer_summary)).not.toContain(BARCODE);
  });

  it('end to end: an unknown barcode gets ONE message, QCK NF', async () => {
    const s = hqSetup({ instruments: instruments(), lab: {} });
    const r: any = await run(s, QRY(BARCODE), verified);
    expect(r.body.reply_messages).toHaveLength(1);
    expect(field(Buffer.from(r.body.reply_messages[0].raw_base64, 'base64').toString('utf8'), 'QAK', 2)).toBe('NF');
    expect(r.body.answer_summary).toEqual([{ index: 0, status: 'not_found', test_count: 0 }]);
  });

  it('end to end: a malformed query (barcode > 40) is quarantined as instruments.message_malformed, no reply, C5 never asked', async () => {
    const s = hqSetup({ instruments: instruments() });
    const e = await rejection(run(s, QRY('M'.repeat(41)), verified));
    expect(e?.code).toBe('instruments.message_malformed');
    expect(s.lab.calls).toHaveLength(0);
  });

  // SPEC GAP (flagged in the notes): hostQuery.service.ts parseQuery() treats an EMPTY barcode list as malformed (barcodes.length < 1), so the
  // sample-number-range / time-range query (extract => []) cannot reach buildHostQueryReply through the service and be answered NF. The service
  // is not a C7b-owned file in this task; the fix is a CR (allow [] => build the reply with answers []).
  it.todo('end to end: qry-sample-range and qry-time-range through the service get ONE message, QCK NF, nothing asked of C5 (needs the service to accept an empty barcode list)');
});
