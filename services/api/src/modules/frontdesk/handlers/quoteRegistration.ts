// F8 POST /v1/frontdesk/registrations/quote (no Idempotency-Key; read-only, REQ-SEC-046: prices are server-side).
import type { Handler } from '../../../core/module.js';
import { quote } from '../service/registration.service.js';

export const handler: Handler = (req, ctx) => quote(ctx, req.body);
