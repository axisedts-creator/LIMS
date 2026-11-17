// F9 POST /v1/frontdesk/registrations (Idempotency-Key required; the core hook stores the 201, 03-APP-FLOW §2.3). One request = one tx.
import type { Handler } from '../../../core/module.js';
import { create } from '../service/registration.service.js';

export const handler: Handler = (req, ctx) => create(ctx, req.body);
