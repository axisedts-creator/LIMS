// Publishers of module instruments (02-TRD §6.5; 03-IC §3.14/§3.15). Payloads are snake_case, verbatim IC; the core `events.publish`
// validates the whole envelope against contracts/events/*.schema.json and fails closed (common.internal) on any violation.
// API-T16 adds calibrationReceived + health_changed to this file.

export interface PublishResult { readonly eventId: string; readonly duplicate: boolean }
export interface EventsPort { publish(ctx: any, type: string, input: { aggregate: { type: string; id: string; seq: number }; idempotencyKey: string; payload: Record<string, unknown> }): Promise<PublishResult> }
type Payload = Record<string, any>;

export const RESULT_EVENT = 'instruments.result.received.v1';
export const QC_EVENT = 'instruments.qc.received.v1';

/** `<instrument_id>:<sample_barcode>:<instrument_analyte_code>:<instrument_result_time or 'none'>` (03-IC §3.14). */
export const resultIdempotencyKey = (p: Payload): string =>
  `${p['instrument_id']}:${p['sample_barcode']}:${p['instrument_analyte_code']}:${p['instrument_result_time'] ?? 'none'}`;

/** `<instrument_id>:qc:<control_id_raw>:<instrument_analyte_code>:<instrument_result_time or raw_sha256>` (03-IC §3.15). */
export const qcIdempotencyKey = (p: Payload, rawSha256: string): string =>
  `${p['instrument_id']}:qc:${p['control_id_raw']}:${p['instrument_analyte_code']}:${p['instrument_result_time'] ?? rawSha256}`;

export const CALIBRATION_EVENT = 'instruments.calibration.received.v1';

/** `<instrument_id>:cal:<instrument_analyte_code>:<instrument_result_time or raw_sha256>` (02-TRD §6.5; 03-IC §3.26). */
export const calibrationIdempotencyKey = (p: Payload, rawSha256: string): string =>
  `${p['instrument_id']}:cal:${p['instrument_analyte_code']}:${p['instrument_result_time'] ?? rawSha256}`;

export function createInstrumentEvents(events: EventsPort) {
  const aggregate = (p: Payload) => ({ type: 'instrument_message', id: p['instrument_message_id'] as string, seq: 1 });
  return {
    resultReceived: (ctx: unknown, payload: Payload): Promise<PublishResult> =>
      events.publish(ctx, RESULT_EVENT, { aggregate: aggregate(payload), idempotencyKey: resultIdempotencyKey(payload), payload }),
    qcReceived: (ctx: unknown, payload: Payload, o: { rawSha256: string }): Promise<PublishResult> =>
      events.publish(ctx, QC_EVENT, { aggregate: aggregate(payload), idempotencyKey: qcIdempotencyKey(payload, o.rawSha256), payload }),
    calibrationReceived: (ctx: unknown, payload: Payload, o: { rawSha256: string }): Promise<PublishResult> =>
      events.publish(ctx, CALIBRATION_EVENT, { aggregate: aggregate(payload), idempotencyKey: calibrationIdempotencyKey(payload, o.rawSha256), payload }),
  };
}
export type InstrumentEvents = ReturnType<typeof createInstrumentEvents>;
