// Which adapter parses provider callbacks (C6-T29; REQ-SEC-136). Services may not import delivery/adapters directly, so the choice lives here.
// Outside production only `recording`; in production none yet (the real adapters' parseCallback land with T27/T28) => every callback is rejected there.
// SEC-ENV-1 (LD-236): "production" = isProductionEnv (LIMS_CORE_ENV or NODE_ENV), so the unkeyed recording adapter is unreachable there.
import { isProductionEnv } from '../../../core/config.js';
import { recordingTransport } from './adapters/recording.js';
import type { Transport } from './transport.js';

export function callbackAdapter(env: Readonly<Record<string, string | undefined>>): Transport | undefined {
  return isProductionEnv(env) ? undefined : recordingTransport;
}
