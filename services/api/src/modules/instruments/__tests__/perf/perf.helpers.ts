// C7 API-T15 perf helpers (not a test file). 02-TRD §12 volumes (N = 10 labs): 2.1 msg/s, 200 agents. "10x" = 100 labs / 2,000 agents. Synthetic data only.
// Harness: in-process services over the in-memory worlds of API-T09/T10/T06 (real core events + schema validation, real savepoint semantics). They measure the service's OWN overhead (no N+1, no serial blow-up);
// real-DB statement latency (~1 ms/statement in TRD §12.2) is NOT covered here.
import type { InstrumentDriver } from '../../drivers/types.js';
import { batch, message, type Row } from '../ingest.helpers.js';

export const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Open-loop load: fires `fn(i)` at `ratePerSec` for `seconds` WITHOUT waiting for earlier calls (arrivals do not slow down when the server does); returns each call's latency (ms) and errors. */
export async function openLoop(ratePerSec: number, seconds: number, fn: (i: number) => Promise<unknown>) {
  const total = Math.round(ratePerSec * seconds), gap = 1000 / ratePerSec, t0 = performance.now();
  const times: number[] = [], errors: unknown[] = [], inflight: Promise<void>[] = [];
  for (let i = 0; i < total; i++) {
    const wait = t0 + i * gap - performance.now(); if (wait > 1) await sleep(wait);
    const s = performance.now();
    inflight.push(fn(i).then(() => { times.push(performance.now() - s); }, (e) => { errors.push(e); }));
  }
  await Promise.all(inflight);
  return { times, errors, total, wallMs: performance.now() - t0 };
}

/** raw bytes `PERF|<n>`; barcode and result keys are distinct per n (distinct message key, distinct result idempotency keys). */
export const perfRaw = (n: number) => Buffer.from(`PERF|${n}`, 'latin1');
export const RECORDS_PER_MESSAGE = 8;     // 02-TRD §12.2: ~8.3 records/message
/** Deterministic driver: PERF|<n> -> 8 patient records (codes C1..C8 for barcode E26<n>), like the ~830-record / 100-message row of TRD §12.2 (≤ ~40 distinct codes per batch). */
export function perfDriver(): { driver: InstrumentDriver; getDriver: (code: string) => InstrumentDriver } {
  const driver: InstrumentDriver = {
    code: 'astm_generic_e1394', version: '9.9.9', protocol: 'astm', status: 'generic', optionsSchema: {},
    capabilities: { resultUpload: true, hostQuery: false, worklistDownload: false, qc: true, attachments: false, calibration: false },
    parse(raw) {
      const n = Number(Buffer.from(raw).toString('latin1').split('|')[1]);
      return { ok: true, messageKind: 'results', warnings: [], records: Array.from({ length: RECORDS_PER_MESSAGE }, (_v, i) => ({
        recordSeq: i + 1, recordClass: 'patient' as const, recordKind: 'quantitative' as const, sampleBarcode: `E26${String(n).padStart(8, '0')}`, instrumentAnalyteCode: `C${i + 1}`,
        valueRaw: '5.4', unitRaw: 'mmol/L', instrumentResultTimeLocal: '2026-11-07T10:12:00', instrumentFlags: [], warnings: [] })) };
    },
  };
  return { driver, getDriver: () => driver };
}
export const perfBatch = (ns: number[]): Row => batch(ns.map((n) => message({ n, raw: perfRaw(n) })));
