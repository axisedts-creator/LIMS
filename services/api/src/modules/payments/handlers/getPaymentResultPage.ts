// PG-T09 — P34 getPaymentResultPage (TRD §5.2, §7.5): static page, no data, no DB, no ctx use. `intent_id` is accepted by the contract and ignored here.
import type { Handler } from '../../../core/module.js';
import { renderResultPage } from '../pages/resultPage.js';

export const getPaymentResultPage: Handler = async (req) => renderResultPage((req.query as { outcome?: unknown } | undefined)?.outcome);
