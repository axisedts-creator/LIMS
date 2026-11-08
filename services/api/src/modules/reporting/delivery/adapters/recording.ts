// `recording` transport (02-TRD §5.4; REQ-SEC-136): the only adapter allowed outside production. Nothing leaves the process: it accepts the
// message and returns an outcome for the caller to record. No network, no filesystem, no environment access.
import type { OutboundMessage, SendOutcome, Transport } from '../transport.js';

export const recordingTransport: Transport = {
  providerKind: 'recording',
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    return { providerMessageId: `rec-${msg.deliveryId}`, acceptedAt: new Date().toISOString() };
  },
};
