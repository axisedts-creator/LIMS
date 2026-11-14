// Fonepay slot (PG-T07; US-PG-12 AC1; BLOCKED B8). Nothing about the Fonepay API is invented: every method reports
// payments.gateway_not_available (503), no network I/O, no callback-signature or refund members.
import { LimsError } from '../../../core/errors.js';
import type { SecretHandle } from '../service/credentials.js';
import type { CallContext, GatewayCheck, IntentAction, IntentForGateway, StoredIntent } from './khalti.adapter.js';

const unavailable = (): LimsError => new LimsError('payments.gateway_not_available');

export function createFonepayAdapter() {
  return {
    gateway: 'fonepay' as const,
    initiate: async (_i: IntentForGateway, _s: SecretHandle, _c?: CallContext): Promise<never> => { throw unavailable(); },
    check: async (_i: StoredIntent, _s: SecretHandle, _c?: CallContext): Promise<GatewayCheck> => { throw unavailable(); },
    buildAction(_i: StoredIntent, _s: SecretHandle): IntentAction { throw unavailable(); },
  };
}
