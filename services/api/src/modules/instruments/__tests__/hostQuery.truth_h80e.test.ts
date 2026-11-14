// C7 H80-T03 — Truth-H80E host query: extract barcode, build QCK / DSR, OK-NF rules, deterministic replay (08-ADDENDUM-TRUTH-H80E §5, §6, §8; LD-139, 2026-11-13).
// Tests first; synthetic data only. Golden inputs/outputs live in drivers/truth_h80e/testdata/*.hl7 (LF in the files, converted to HL7 CR here).
// LD-139: the manual's DSR carries demographics + a detection mode and NO test list; every U position stays configurable, host query stays inert while status != verified.
// SEAMS (spec gaps chosen here, flagged in notes/H80-T03-tests.md):
//   * the query barcode reaches extractHostQueryBarcodes through parse(): parse() of QRY^Q02 must return ok:true, messageKind 'host_query' and ONE record
//     { recordClass:'host_query', sampleBarcode: QRD-8.1 } (the helpers' fake driver and hostQuery.service.ts work the same way: ParseOk is all extract/build get).
//     An empty / missing / >40 barcode may fail either in parse() (ok:false) or in extractHostQueryBarcodes (throws LimsError code instruments.message_malformed).
//   * replies are HL7 text with CR segment ends incl. a final CR (no MLLP framing: that is the agent's job). QCK/DSR MSH-3/4 are the §6 defaults 'LIS'/'LIMS' (ack_sending_app/facility; 'Truth'/'Truth-H80E' fail ^[A-Z0-9_]+$; CR-C7-017 only if commissioning needs them, U).
//   * HostQueryAnswer carries only sex/ageDays (no patient id / name / DOB / department / accession): DSP-1..4, 6, 13 are therefore empty; DSP-4 is never derived from ageDays (§5 rule).
//   * a 'found' answer with an empty tests[] is NF (rule: OK only with at least one pending mapped test).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rejection } from './agents.helpers.js';
import { AN, BARCODE, INS, TEST, defaultInstruments, hqBody, hqSetup } from './hostQuery.helpers.js';
import { getDriver } from '../drivers/registry.js';
import { truthH80e } from '../drivers/truth_h80e/index.js';
import type { HostQueryAnswer } from '../drivers/types.js';
import { createHostQueryService } from '../service/hostQuery.service.js';

const FIX = fileURLToPath(new URL('../drivers/truth_h80e/testdata/', import.meta.url));
const fixture = (n: string) => readFileSync(join(FIX, `${n}.hl7`), 'utf8').replace(/\r?\n/g, '\r'); // HL7 segment end = CR, final CR kept
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
const drv = () => getDriver('truth_h80e')!;
const ctx = (o: { options?: Record<string, unknown>; receivedAt?: string; capturedAt?: string; tz?: string } = {}) => ({
  receivedAt: o.receivedAt ?? '2026-11-05T04:50:42.000Z', // = 2026-11-05 10:35:42 in Asia/Kathmandu (+05:45) = the §5 example's MSH-7
  capturedAt: o.capturedAt ?? '2026-11-05T04:50:41.000Z', instrumentTimezone: o.tz ?? 'Asia/Kathmandu', qcSampleIdPatterns: [], options: o.options ?? {},
}) as never;
const parseOk = (bytes: Uint8Array | string): any => {
  const r: any = drv().parse(typeof bytes === 'string' ? enc(bytes) : bytes, ctx());
  if (!r.ok) throw new Error(`expected ok parse, got ${JSON.stringify(r)}`);
  return r;
};
const extract = (bytes: Uint8Array | string): { code?: string; barcodes?: string[] } => {
  const r: any = drv().parse(typeof bytes === 'string' ? enc(bytes) : bytes, ctx());
  if (!r.ok) return { code: r.errorCode };
  try { return { barcodes: [...drv().extractHostQueryBarcodes!(r)] }; } catch (e) { return { code: (e as { code?: string }).code ?? `non-LimsError:${String(e)}` }; }
};
const build = (query: string, answers: readonly HostQueryAnswer[], c = ctx()): string[] =>
  drv().buildHostQueryReply!({ query: parseOk(query), answers, ctx: c }).map(dec);

const NEW = BARCODE;                                              // E2600000042
const TESTS = [{ testId: TEST.glu, analyteId: AN.glu, instrumentCode: 'HbA1c_NGSP' }];
const found = (o: Partial<HostQueryAnswer> = {}): HostQueryAnswer => ({ barcode: NEW, status: 'found', sex: 'female', ageDays: 9000, priority: 'routine', tests: TESTS, ...o });
const notFound = (status: HostQueryAnswer['status'] = 'not_found', barcode = NEW): HostQueryAnswer => ({ barcode, status, tests: [] });
const QRY = (barcode: string, over: { id?: string; time?: string } = {}) =>
  `MSH|^~\\&|Truth|Truth-H80E|||${over.time ?? '20261105103542'}||QRY^Q02|${over.id ?? '126'}|P|2.3||||||UTF-8||||\rQRD|20261105103542|R|D|65|||RD|${barcode}||||\rQRF|||||RCT|COR|ALL|||\r`;
const seg = (m: string) => m.split('\r').filter((s) => s.length > 0);
const field = (m: string, segName: string, n: number) => seg(m).find((s) => s.startsWith(segName + '|'))!.split('|')[segName === 'MSH' ? n - 1 : n];

// ================================================================================================================================
describe('extractHostQueryBarcodes — QRD-8 component 1 (addendum §8)', () => {
  it('golden qry-found: parse is a host_query with one record carrying the barcode; extract returns exactly [E2600000042]', () => {
    const p = parseOk(fixture('qry-found'));
    expect(p).toMatchObject({ ok: true, messageKind: 'host_query', messageControlId: '126' });
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ recordClass: 'host_query', sampleBarcode: NEW });
    expect(typeof drv().extractHostQueryBarcodes).toBe('function');
    expect(extract(fixture('qry-found'))).toEqual({ barcodes: [NEW] });
  });
  it('golden qry-not-found and qry-no-hba1c-order parse like any query (the answer, not the query, decides NF)', () => {
    expect(extract(fixture('qry-not-found'))).toEqual({ barcodes: ['E2600000099'] });
    expect(extract(fixture('qry-no-hba1c-order'))).toEqual({ barcodes: ['E2600000043'] });
  });
  it('only component 1 of QRD-8 is used (E26...^x -> E26...)', () => {
    expect(extract(QRY(`${NEW}^extra^more`))).toEqual({ barcodes: [NEW] });
  });
  it('length bound: exactly 40 characters is accepted, 41 is instruments.message_malformed (never truncated)', () => {
    expect(extract(QRY('E'.repeat(40)))).toEqual({ barcodes: ['E'.repeat(40)] });
    expect(extract(QRY('E'.repeat(41)))).toEqual({ code: 'instruments.message_malformed' });
  });
  it('empty QRD-8, QRD-8 component 1 empty, QRD too short, and no QRD at all => instruments.message_malformed', () => {
    expect(extract(QRY(''))).toEqual({ code: 'instruments.message_malformed' });
    expect(extract(QRY('^only-second-component'))).toEqual({ code: 'instruments.message_malformed' });
    expect(extract('MSH|^~\\&|Truth|Truth-H80E|||20261105103542||QRY^Q02|126|P|2.3||||||UTF-8||||\rQRD|20261105103542|R|D|65\rQRF|||||RCT|COR|ALL|||\r')).toEqual({ code: 'instruments.message_malformed' });
    expect(extract('MSH|^~\\&|Truth|Truth-H80E|||20261105103542||QRY^Q02|126|P|2.3||||||UTF-8||||\rQRF|||||RCT|COR|ALL|||\r')).toEqual({ code: 'instruments.message_malformed' });
  });
  it('a query with no MSH is malformed; the reason string carries no barcode (no PHI)', () => {
    const r: any = drv().parse(enc('QRD|20261105103542|R|D|65|||RD|E2600000042||||\r'), ctx());
    expect(r).toMatchObject({ ok: false, errorCode: 'instruments.message_malformed' });
    expect(String(r.reason)).not.toContain(NEW);
  });
  it('hostile: CR/LF smuggling inside the barcode field cannot create a second barcode or segment', () => {
    const out = extract(`MSH|^~\\&|Truth|Truth-H80E|||20261105103542||QRY^Q02|126|P|2.3||||||UTF-8||||\rQRD|20261105103542|R|D|65|||RD|${NEW}\rQRD|x|x|x|x|||RD|E2600000777||||\r`);
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
  it('ACK^Q03 whose MSA-2 (126) differs from the DSR id (171 in the manual) is accepted, not matched: ok, kind other, no records, no warnings (§6)', () => {
    for (const msa2 of ['126', '171', '999']) {
      const p = parseOk(fixture('ack-q03-mismatched-id').replace('MSA|AA|126|', `MSA|AA|${msa2}|`));
      expect(p).toMatchObject({ ok: true, messageKind: 'other', messageControlId: '127' });
      expect(p.records).toEqual([]);
      expect(p.warnings).toEqual([]);
    }
  });
});

// ================================================================================================================================
describe('buildHostQueryReply — [QCK] for NF, [QCK, DSR] for OK, byte-exact goldens (§5)', () => {
  it('golden qry-found: OK => exactly two messages, QCK then DSR, byte-identical to the fixtures', () => {
    const r = build(fixture('qry-found'), [found()]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBe(fixture('qry-found.qck'));
    expect(r[1]).toBe(fixture('qry-found.dsr'));
  });
  it('golden qry-not-found: unknown barcode => exactly one message (QCK NF), no DSR', () => {
    const r = build(fixture('qry-not-found'), [notFound('not_found', 'E2600000099')]);
    expect(r).toEqual([fixture('qry-not-found.qck')]);
  });
  it('golden qry-no-hba1c-order: no mapped pending test (no_mapped_tests) => one message (QCK NF), no DSR', () => {
    const r = build(fixture('qry-no-hba1c-order'), [notFound('no_mapped_tests', 'E2600000043')]);
    expect(r).toEqual([fixture('qry-no-hba1c-order.qck')]);
  });
  it('every non-found status is NF with exactly one message; the QCK never echoes the barcode (PHI minimisation)', () => {
    for (const s of ['not_found', 'not_receivable', 'no_mapped_tests'] as const) {
      const r = build(fixture('qry-found'), [notFound(s)]);
      expect(r, s).toHaveLength(1);
      expect(field(r[0]!, 'QAK', 2), s).toBe('NF');
      expect(r[0], s).not.toContain(NEW);
    }
  });
  it('rule: OK only with at least one pending mapped test — status found with tests [] is NF', () => {
    const r = build(fixture('qry-found'), [found({ tests: [] })]);
    expect(r).toHaveLength(1);
    expect(field(r[0]!, 'QAK', 2)).toBe('NF');
  });
  it('the DSR has no test list: no OBR/OBX/ORC/TQ1 segments and the mapped instrument codes (HbA1c_NGSP) never appear', () => {
    const r = build(fixture('qry-found'), [found({ tests: [...TESTS, { testId: TEST.elec, analyteId: AN.na, instrumentCode: 'HbF' }] })]);
    expect(r).toHaveLength(2);
    expect(seg(r[1]!).map((s) => s.slice(0, 3))).toEqual(['MSH', 'MSA', 'ERR', 'QAK', 'QRD', ...Array<string>(22).fill('DSP'), 'DSC']);
    expect(r.join('')).not.toMatch(/HbA1c_NGSP|HbF|OBX|OBR|ORC/);
  });
  it('QCK/DSR message types and control ids derive from the query MSH-10: <id>01 / <id>02, MSA-2 echoes the query id', () => {
    const r = build(QRY(NEW, { id: '7788' }), [found()]);
    expect(field(r[0]!, 'MSH', 9)).toBe('QCK^Q02'); expect(field(r[0]!, 'MSH', 10)).toBe('778801'); expect(field(r[0]!, 'MSA', 2)).toBe('7788');
    expect(field(r[1]!, 'MSH', 9)).toBe('DSR^Q03'); expect(field(r[1]!, 'MSH', 10)).toBe('778802'); expect(field(r[1]!, 'MSA', 2)).toBe('7788');
  });
  it('output is Uint8Array UTF-8 text with every segment ended by CR (no MLLP framing bytes)', () => {
    const raw = drv().buildHostQueryReply!({ query: parseOk(fixture('qry-found')), answers: [found()], ctx: ctx() });
    for (const b of raw) {
      expect(b).toBeInstanceOf(Uint8Array);
      expect(b.includes(0x0b) || b.includes(0x1c) || b.includes(0x0a)).toBe(false);
      expect(dec(b).endsWith('\r')).toBe(true);
    }
  });
});

describe('MSH-7 = ctx.receivedAt rendered in the instrument timezone (§5 determinism)', () => {
  it('Asia/Kathmandu (+05:45): 04:50:42Z => 20261105103542, also in QRD-1 of the DSR', () => {
    const r = build(fixture('qry-found'), [found()]);
    expect(field(r[0]!, 'MSH', 7)).toBe('20261105103542'); expect(field(r[1]!, 'MSH', 7)).toBe('20261105103542'); expect(field(r[1]!, 'QRD', 1)).toBe('20261105103542');
  });
  it('the query\'s own MSH-7 / capturedAt are NOT used', () => {
    const r = build(QRY(NEW, { time: '20200101000000' }), [found()], ctx({ capturedAt: '2030-01-01T00:00:00.000Z' }));
    expect(field(r[0]!, 'MSH', 7)).toBe('20261105103542');
  });
  it('UTC zone and a day rollover (20:30Z => 02:15:00 next day in Kathmandu)', () => {
    expect(field(build(fixture('qry-found'), [found()], ctx({ tz: 'UTC' }))[0]!, 'MSH', 7)).toBe('20261105045042');
    expect(field(build(fixture('qry-found'), [found()], ctx({ receivedAt: '2026-11-05T20:30:00.000Z' }))[0]!, 'MSH', 7)).toBe('20261106021500');
  });
});

describe('DSR content: demographics + detection mode only (§5 DSP table)', () => {
  const dsp = (m: string, n: number) => seg(m).find((s) => s.startsWith(`DSP|${n}|`))!.split('|')[3];
  it('DSP-5 gender: male 1, female 2, other 0, unknown 0, absent 0', () => {
    const g = (sex?: HostQueryAnswer['sex']) => {
      const { sex: _drop, ...rest } = found();
      return dsp(build(fixture('qry-found'), [sex ? { ...rest, sex } : rest])[1]!, 5);
    };
    expect([g('male'), g('female'), g('other'), g('unknown'), g(undefined)]).toEqual(['1', '2', '0', '0', '0']);
  });
  it('DSP-4 date of birth stays empty when only an age is known — never invented from ageDays; DSP-6 history is always empty', () => {
    const d = build(fixture('qry-found'), [found({ ageDays: 12345 })])[1]!;
    expect(dsp(d, 4)).toBe(''); expect(dsp(d, 6)).toBe('');
    expect(seg(d).filter((s) => s.startsWith('DSP|')).map((s) => s.split('|')[3]).filter((v) => /^(19|20)\d{6}$/.test(v!))).toEqual([]);
  });
  it('DSP-21 echoes the queried barcode; DSP-22 detection mode defaults to 0 and follows option host_query_detection_mode (1 / 2)', () => {
    const q = fixture('qry-found');
    expect(dsp(build(q, [found()])[1]!, 21)).toBe(NEW);
    expect(dsp(build(q, [found()])[1]!, 22)).toBe('0');
    expect(dsp(build(q, [found()], ctx({ options: { host_query_detection_mode: 1 } }))[1]!, 22)).toBe('1');
    expect(dsp(build(q, [found()], ctx({ options: { host_query_detection_mode: 2 } }))[1]!, 22)).toBe('2');
  });
  it('the detection mode option does not touch the QCK, and the QCK has no DSP', () => {
    const q = fixture('qry-found');
    expect(build(q, [found()], ctx({ options: { host_query_detection_mode: 2 } }))[0]).toBe(build(q, [found()])[0]);
  });
});

describe('HL7 escaping and injection (§5: all values escaped, line breaks removed)', () => {
  const dspRow = (m: string, n: number) => seg(m).find((s) => s.startsWith(`DSP|${n}|`))!;
  it('| ^ ~ \\ & in a value become \\F\\ \\S\\ \\R\\ \\E\\ \\T\\ (backslash escaped first, never double-escaped)', () => {
    const d = build(fixture('qry-found'), [found({ barcode: 'E26&1\\2|3^4~5' })])[1]!;
    expect(dspRow(d, 21)).toBe('DSP|21||E26\\T\\1\\E\\2\\F\\3\\S\\4\\R\\5|||');
  });
  it('line breaks are removed and cannot start a new segment (28 segments, MSH only first)', () => {
    const d = build(fixture('qry-found'), [found({ barcode: 'E26\r\nMSH|x\nPID|1' })])[1]!;
    expect(seg(d)).toHaveLength(28);
    expect(seg(d).filter((s) => s.startsWith('MSH|'))).toHaveLength(1);
    expect(dspRow(d, 21)).toBe('DSP|21||E26MSH\\F\\xPID\\F\\1|||');
  });
  it('a hostile query control id (MSH-10 containing &) is escaped in MSA-2 and the reply ids, never raw', () => {
    const r = build(QRY(NEW, { id: '1&2' }), [found()]);
    expect(field(r[0]!, 'MSA', 2)).toBe('1\\T\\2'); expect(field(r[0]!, 'MSH', 10)).toBe('1\\T\\201'); expect(field(r[1]!, 'MSH', 10)).toBe('1\\T\\202');
  });
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
  it('NF replay is byte-identical too; capturedAt, priority and ageDays do not change the bytes; inputs are not mutated', () => {
    const answers = Object.freeze([Object.freeze(found())]);
    const base = build(fixture('qry-found'), answers);
    expect(build(fixture('qry-found'), [found({ priority: 'urgent', ageDays: 1 })], ctx({ capturedAt: '2031-02-03T04:05:06.000Z' }))).toEqual(base);
    expect(build(fixture('qry-not-found'), [notFound()])).toEqual(build(fixture('qry-not-found'), [notFound()]));
    expect(answers[0]).toEqual(found());
  });
  it('a changed order state changes the answer: found -> NF after the order is no longer pending', () => {
    expect(build(fixture('qry-found'), [found()])).toHaveLength(2);
    expect(build(fixture('qry-found'), [notFound('no_mapped_tests')])).toHaveLength(1);
  });
});

// ================================================================================================================================
describe('host query stays inert while status is not verified (§0, §6.6 step 2; AC-10.4)', () => {
  const instruments = () => defaultInstruments().map((i) => ({ ...i, driver_code: 'truth_h80e', protocol: 'hl7v2' }));
  const run = (s: ReturnType<typeof hqSetup>, raw: string, getDriver?: (c: string) => unknown, n = 1) =>
    createHostQueryService({ repo: s.repo, ...(getDriver ? { getDriver: getDriver as never } : {}) }).submitHostQuery(s.ctx, { body: hqBody({ n, protocol: 'hl7v2', raw: Buffer.from(raw, 'utf8') }) });
  const verified = (c: string) => (c === 'truth_h80e' ? { ...truthH80e, status: 'verified' as const } : undefined);

  it('the registered driver is generic: a live instrument with cap_host_query on is still refused with instruments.capability_not_supported, nothing asked of C5, nothing parsed', async () => {
    const s = hqSetup({ instruments: instruments() });
    const e = await rejection(run(s, fixture('qry-found')));
    expect(e?.code).toBe('instruments.capability_not_supported');
    expect(s.lab.calls).toHaveLength(0); expect(s.catalog.calls).toHaveLength(0);
    expect(s.world.runs[0]).toMatchObject({ outcome: 'rejected_capability', driver_code: 'truth_h80e' });
  });

  it('end to end (driver forced to verified in the test only): found => two reply_messages QCK OK + DSR, summary has no barcode', async () => {
    const s = hqSetup({ instruments: instruments() });
    const r: any = await run(s, fixture('qry-found'), verified);
    expect(r.status).toBe(200);
    const msgs = r.body.reply_messages.map((m: { raw_base64: string }) => Buffer.from(m.raw_base64, 'base64').toString('utf8'));
    expect(msgs).toHaveLength(2);
    expect(field(msgs[0], 'MSH', 9)).toBe('QCK^Q02'); expect(field(msgs[0], 'QAK', 2)).toBe('OK'); expect(field(msgs[0], 'MSA', 2)).toBe('126');
    expect(field(msgs[1], 'MSH', 9)).toBe('DSR^Q03'); expect(field(msgs[1], 'MSH', 10)).toBe('12602');
    expect(seg(msgs[1]).find((x: string) => x.startsWith('DSP|21|'))).toBe(`DSP|21||${NEW}|||`);
    expect(seg(msgs[1]).find((x: string) => x.startsWith('DSP|5|'))).toBe('DSP|5||2|||');       // C5 patient.sex female
    expect(r.body.answer_summary).toEqual([{ index: 0, status: 'found', test_count: 2 }]);   // glu + na mapped, k unmapped (helpers' default order)
    expect(JSON.stringify(r.body.answer_summary)).not.toContain(NEW);
  });

  it('end to end: unknown barcode and a tube registered without a mapped HbA1c test both get ONE message, QCK NF', async () => {
    const s1 = hqSetup({ instruments: instruments(), lab: {} });
    const r1: any = await run(s1, fixture('qry-not-found'), verified);
    expect(r1.body.reply_messages).toHaveLength(1);
    expect(field(Buffer.from(r1.body.reply_messages[0].raw_base64, 'base64').toString('utf8'), 'QAK', 2)).toBe('NF');
    expect(r1.body.answer_summary).toEqual([{ index: 0, status: 'not_found', test_count: 0 }]);

    const s2 = hqSetup({ instruments: instruments(), lab: { E2600000043: { tests: [{ testId: TEST.glu, analyteIds: [AN.k] }] } } }); // AN.k has no outbound mapping
    const r2: any = await run(s2, fixture('qry-no-hba1c-order'), verified, 2);
    expect(r2.body.reply_messages).toHaveLength(1);
    expect(field(Buffer.from(r2.body.reply_messages[0].raw_base64, 'base64').toString('utf8'), 'QAK', 2)).toBe('NF');
    expect(r2.body.answer_summary).toEqual([{ index: 0, status: 'no_mapped_tests', test_count: 0 }]);
  });

  it('end to end: a malformed query (barcode > 40) is quarantined as instruments.message_malformed, no reply, C5 never asked', async () => {
    const s = hqSetup({ instruments: instruments() });
    const e = await rejection(run(s, QRY('E'.repeat(41)), verified));
    expect(e?.code).toBe('instruments.message_malformed');
    expect(s.lab.calls).toHaveLength(0);
    expect(INS(1)).toBeTruthy();
  });
});
