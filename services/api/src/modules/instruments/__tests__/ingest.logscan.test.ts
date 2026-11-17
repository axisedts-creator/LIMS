// C7 API-T09 — AC-09.12 / S-12 log-scan: no log line, metric label, response body or error detail contains a barcode, analyte value or raw message content (02-CV §9.2, 07-SECURITY §5).
// Planted synthetic sentinels travel through EVERY outcome of E04 (accepted, duplicate, quarantined, rejected x3, retry-after-DB-error whose message itself contains PHI).
import { describe, expect, it } from 'vitest';
import { createIngestService } from '../service/ingest.service.js';
import { HL7_ORU, INS, PLANT, REQ_ID, batch, bytes, makeIngestCtx, makeWorld, message, msgId } from './ingest.helpers.js';

const PHI_ORU = HL7_ORU.replace('PID|1||P0001', `PID|1||P0001||Zzyzx^${PLANT.name}^^^`).replace('||5.4|', `||${PLANT.value}|`);   // barcode E2600000042 is already in OBR.3

describe('AC-09.12 log-scan', () => {
  it('no sentinel (barcode, patient name, value, raw text, base64, result key) in logs, metrics, response — across every outcome; failures log request_id + agent_message_id only', async () => {
    const w = makeWorld(); const c = makeIngestCtx(w);
    let k = 0; w.failOn('insertRun', () => ++k === 3, () => new Error(`insert failed for barcode ${PLANT.barcode} value ${PLANT.value} name ${PLANT.name}`));
    const hl7 = (n: number, raw: string, ins = INS(2)) => message({ n, instrument: ins, protocol: 'hl7v2', raw });
    const accepted = hl7(1, PHI_ORU);
    const msgs = [accepted, accepted,                                                   // accepted, then agent-key duplicate
      hl7(3, `garbage ${PLANT.barcode} ${PLANT.name} ${PLANT.value}`),                  // quarantined (malformed)
      hl7(4, PHI_ORU.replace('MSG00001', 'MSG00002').replace(PLANT.value, '7731.5'), INS(2)),   // 3rd insertRun -> unexpected DB error with PHI in its message -> retry
      hl7(5, PHI_ORU, INS(4)), hl7(6, PHI_ORU, INS(3)), hl7(7, PHI_ORU, INS(5)),        // device_mismatch, instrument_unknown (other centre), instrument_unknown (draft)
      message({ n: 8, instrument: INS(2), protocol: 'hl7v2', raw: Buffer.alloc(1024 * 1024 + 1, 0x41) })];   // message_too_large
    const r = await createIngestService({ repo: w.repo } as any).submitMessageBatch(c.ctx, { body: batch(msgs) });
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(['accepted', 'duplicate', 'quarantined', 'retry', 'rejected', 'rejected', 'rejected', 'rejected']);

    const text = c.logText() + '\n' + JSON.stringify(r);
    const sentinels = [PLANT.barcode, PLANT.name, PLANT.value, 'Zzyzx', 'garbage', 'Glucose', `${INS(2)}:${PLANT.barcode}`, bytes(PHI_ORU).toString('base64'), bytes(PHI_ORU).toString('hex'), PHI_ORU.slice(0, 40)];
    for (const s of sentinels) expect(text, `sentinel leaked: ${s.slice(0, 20)}`).not.toContain(s);
    const failureLines = c.lines.filter((l) => l.includes(msgId(4)));
    expect(failureLines.length).toBeGreaterThan(0); for (const l of failureLines) expect(l).toContain(REQ_ID);
  });
  it('the persisted warnings/error_reason of runs and records contain codes and field names only', async () => {
    const w = makeWorld(); await createIngestService({ repo: w.repo } as any).submitMessageBatch(makeIngestCtx(w).ctx, { body: batch([message({ n: 1, instrument: INS(2), protocol: 'hl7v2', raw: `junk ${PLANT.barcode} ${PLANT.value}` })]) });
    const stored = JSON.stringify([w.runs.map((r) => [r['error_code'], r['error_reason']]), w.messages.map((m) => m['warnings']), w.records]); for (const s of [PLANT.barcode, PLANT.value]) expect(stored).not.toContain(s);
  });
});
