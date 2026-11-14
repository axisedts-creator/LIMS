// `recording` transport (02-TRD §5.4; REQ-SEC-136): the only adapter allowed outside production. Nothing leaves the process: it accepts the
// message and returns an outcome for the caller to record. No network, no filesystem, no environment access.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { CallbackEvent, OutboundMessage, SendOutcome, Transport } from '../transport.js';

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
const SIG = /^[0-9a-f]{64}$/;

/**
 * Callback wire format of the recording adapter (ours; real providers define theirs in T27/T28): body = JSON {"events":[{provider_message_id, status, occurred_at?}]},
 * header `x-recording-signature` = lower-case hex SHA-256 of the RAW body bytes (CR-C6-001: never of re-serialised JSON). Throws on anything else.
 */
function parseCallback(raw: Uint8Array, headers: Readonly<Record<string, string | undefined>>): CallbackEvent[] {
  const sig = headers['x-recording-signature'];
  const want = createHash('sha256').update(raw).digest();
  if (typeof sig !== 'string' || !SIG.test(sig) || !timingSafeEqual(Buffer.from(sig, 'hex'), want)) throw new Error('bad_signature');
  const body = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new Error('bad_body');
  return events.map((e: unknown): CallbackEvent => {
    const o = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    const id = o['provider_message_id']; const status = o['status']; const at = o['occurred_at'];
    if (typeof id !== 'string' || id === '' || typeof status !== 'string' || !STATUSES.has(status)) throw new Error('bad_event');
    if (at !== undefined && (typeof at !== 'string' || !Number.isFinite(Date.parse(at)))) throw new Error('bad_event');
    return { providerMessageId: id, statusRaw: status, mappedStatus: status as CallbackEvent['mappedStatus'], ...(at === undefined ? {} : { occurredAt: new Date(at as string).toISOString() }) };
  });
}

export const recordingTransport: Transport = {
  providerKind: 'recording',
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    return { providerMessageId: `rec-${msg.deliveryId}`, acceptedAt: new Date().toISOString() };
  },
  parseCallback,
};
