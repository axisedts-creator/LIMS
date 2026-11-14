# PG-T10 impl (writer)
- Added: services/api/src/modules/payments/events/publish.ts (only file changed).
- Exports SETTLED_EVENT, settledIdempotencyKey, createPaymentsEvents(events).intentSettled(ctx, payload, { intentVersion }).
- [CONV] Key `<gateway>:<ref>:settled`; aggregate payment_intent/id=intent_id/seq=intentVersion; payload passed verbatim, so core schema validation (additionalProperties:false) fails closed.
- [CONV] Publishes only via the injected events port, so the row lives in the caller's tx (rollback -> no event).
- Tests: vitest events/__tests__ -> 40/40 pass; tsc shows no errors in events/.
- Open: outcome.service.ts:133 still calls deps.events.publish directly (same key and shape). Rewiring through this publisher is optional and not done (PG-T08 file).
