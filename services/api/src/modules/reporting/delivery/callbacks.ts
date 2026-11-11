// Which adapter parses provider callbacks (C6-T29; REQ-SEC-136). Services may not import delivery/adapters directly, so the choice lives here.
// Outside production only `recording`; in production none yet (the real adapters' parseCallback land with T27/T28) => every callback is rejected there.
import { recordingTransport } from './adapters/recording.js';
import type { Transport } from './transport.js';

export function callbackAdapter(env: Readonly<Record<string, string | undefined>>): Transport | undefined {
  return env['NODE_ENV'] === 'production' ? undefined : recordingTransport;
}
