// C7 MET-T02 — getein_metis through the REAL ingest pipeline: events carry no PHI, calibration emits nothing, a malformed QC is quarantined.
// 09-ADDENDUM-GETEIN-METIS §3 (PHI minimisation), §4, D-MET-2 (calibration = other, no events); 07-SECURITY (no PHI in events/logs); LD-163. Synthetic data only.
// Uses the real registry driver (no fake driver): fails now because getein_metis is not registered, so every message is quarantined or rejected.
import { describe, expect, it } from 'vitest';
import { getDriver } from '../drivers/registry.js';
import { createIngestService } from '../service/ingest.service.js';
import { AGENT_A1, INS, MiB, batch, makeIngestCtx, makeWorld, message, type Row, type World } from './ingest.helpers.js';
import { insRow } from './instruments.helpers.js';

const RESULT = 'instruments.result.received.v1';
const BARCODE = 'MT2600000042';
const LIVE = INS(2);
const world = () => makeWorld({ instruments: [insRow(2, { state: 'live', agent_id: AGENT_A1, protocol: 'hl7v2', driver_code: 'getein_metis' })] });

const MSH = (ctrl: string, t: string, flag: string) => `MSH|^~\\&|GP|Metis|||${t}||ORU^R01|${ctrl}|P|2.3.1||||${flag}||UTF8|||`;
const PID = 'PID|1|V000123|||Test Patient||19880912000000|F';
const OBR_P = `OBR|1|${BARCODE}|7|^|N|20261114085510|20261114092940|||||||20261114085730|serum`;
const OBX1 = 'OBX|1|NM|0|ALT|31.2|U/L|0-40|N|||F||31.2|20261114093001|||0';
const OBX2 = 'OBX|2|NM|1|AST|44.8|U/L|0-40|H~A|||F||44.8||||0';
const OBX3 = 'OBX|3|ST|1112|CoV2Ag|Negative||||-||F|||20261114093010|||1';
const wire = (segments: string[]) => Buffer.from(segments.join('\r') + '\r', 'utf8');

async function send(w: World, raw: Buffer, n = 1) {
  const c = makeIngestCtx(w);
  const svc = createIngestService({ repo: w.repo, getDriver, maxMessageBytes: MiB } as any);
  const r = await svc.submitMessageBatch(c.ctx, { body: batch([message({ n, instrument: LIVE, protocol: 'hl7v2', raw })]) });
  return { c, res: r.body.results as Row[] };
}

describe('patient result: one event per OBX, no PHI anywhere downstream', () => {
  const PHI = ['Test Patient', '19880912', 'V000123'];
  it('three OBX rows -> three result events for the OBR-2 barcode, message accepted, run parsed', async () => {
    const w = world();
    const { res } = await send(w, wire([MSH('57', '20261114093015', '0'), PID, OBR_P, OBX1, OBX2, OBX3]));
    expect(res[0]).toMatchObject({ outcome: 'accepted' });
    const ev = w.eventsOf(RESULT);
    expect(ev).toHaveLength(3);
    for (const e of ev) expect(e['payload']).toMatchObject({ sample_barcode: BARCODE, protocol: 'hl7v2', instrument_id: LIVE });
    expect(ev.map((e) => e['payload']['instrument_analyte_code']).sort()).toEqual(['0', '1', '1112']);
    expect(ev.map((e) => e['payload']['value_raw']).sort()).toEqual(['31.2', '44.8', 'Negative']);
    expect(w.runs[0]).toMatchObject({ outcome: 'parsed', emitted_events: 3 });
  });

  it('no PHI field in emitted events, record rows, run rows or logs: name, date of birth, patient id, sex', async () => {
    const w = world();
    const { c } = await send(w, wire([MSH('57', '20261114093015', '0'), PID, OBR_P, OBX1, OBX2, OBX3]));
    expect(w.eventsOf(RESULT)).toHaveLength(3); // guards against a vacuous pass when nothing was parsed
    for (const [label, text] of [['events', JSON.stringify(w.events)], ['records', JSON.stringify(w.records)], ['runs', JSON.stringify(w.runs)], ['logs', c.logText()]] as const) {
      for (const phi of PHI) expect(text, `${label} contains ${phi}`).not.toContain(phi);
    }
    for (const e of w.events) {
      expect(Object.keys(e['payload']).filter((k) => /name|birth|dob|sex|gender|patient_id|mrn/i.test(k))).toEqual([]);
    }
  });

  it('a Devanagari patient name never reaches an event either', async () => {
    const w = world();
    await send(w, wire([MSH('57', '20261114093015', '0'), 'PID|1|V000123|||परीक्षण रोगी||19880912000000|O', OBR_P, OBX1]));
    expect(w.eventsOf(RESULT)).toHaveLength(1);
    expect(JSON.stringify(w.events)).not.toContain('परीक्षण');
  });
});

describe('D-MET-2: calibration (MSH-16 = 1) is archived, no records, no events', () => {
  it('the message is accepted and stored, but no event and no record row is produced', async () => {
    const w = world();
    const raw = wire([MSH('59', '20261114111500', '1'), 'OBR|1|7|AST|^|||20261114111000||||2|1^2|CALSYN1^CALSYN2|LOT111^LOT222|20300101^20300101||L^H|45.0^120.0|4.5^9.0|44.1^123.4|U/L']);
    const { res } = await send(w, raw);
    expect(res[0]).toMatchObject({ outcome: 'accepted' });
    expect(w.messages).toHaveLength(1);
    expect(w.events).toEqual([]);
    expect(w.records).toEqual([]);
  });
  it('a calibration that also carries PID and OBX rows still produces nothing', async () => {
    const w = world();
    const { res } = await send(w, wire([MSH('59', '20261114111500', '1'), PID, OBR_P, OBX1, OBX2]));
    expect(res[0]).toMatchObject({ outcome: 'accepted' });
    expect(w.events).toEqual([]);
    expect(w.records).toEqual([]);
  });
});

describe('QC through the pipeline', () => {
  const OBR_QC = (measured: string, levels = 'L^H') =>
    `OBR|1|7|AST|^|||20261114101455||||2|1^2|QCSYN1^QCSYN2|LOT111^LOT222|20300101^20300101||${levels}|45.0^120.0|4.5^9.0|${measured}|U/L`;
  it('QC message -> two QC records for the two control entries, no sample barcode, no patient result', async () => {
    const w = world();
    const { res } = await send(w, wire([MSH('58', '20261114101502', '2'), OBR_QC('44.1^123.4')]));
    expect(res[0]).toMatchObject({ outcome: 'accepted' });
    expect(w.records).toHaveLength(2);
    for (const r of w.records) expect(r['sample_barcode'] ?? null).toBeNull();
    expect(w.records.map((r) => r['control_id_raw'])).toEqual(['QCSYN1', 'QCSYN2']);
    expect(w.records.map((r) => r['control_level'])).toEqual(['low', 'high']);
  });
  it('QC lists of different length -> quarantined instruments.message_malformed, raw archived, no records, NO event', async () => {
    const w = world();
    const { res } = await send(w, wire([MSH('58', '20261114101502', '2'), OBR_QC('44.1', 'L^H')]));
    expect(res[0]).toMatchObject({ outcome: 'quarantined', error_code: 'instruments.message_malformed' });
    expect(w.messages).toHaveLength(1);
    expect(w.runs[0]).toMatchObject({ outcome: 'quarantined', error_code: 'instruments.message_malformed' });
    expect(w.records).toEqual([]);
    expect(w.events).toEqual([]);
  });
  it('a message with no MSH -> quarantined instruments.message_malformed, no event', async () => {
    const w = world();
    const { res } = await send(w, wire([PID, OBR_P, OBX1]));
    expect(res[0]).toMatchObject({ outcome: 'quarantined', error_code: 'instruments.message_malformed' });
    expect(w.events).toEqual([]);
  });
});
