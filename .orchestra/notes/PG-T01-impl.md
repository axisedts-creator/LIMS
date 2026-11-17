# PG-T01 impl (writer)
Files: api `modules/payments/{index,config,permissions}.ts`, `handlers/index.ts`, `ports/PaymentProviderPort.impl.ts`; worker `jobs/payments/index.ts`; C0 `core/ports/phase-stubs.ts` (PaymentProviderPort removed, P-20).
Result: api 643 pass / 17 skipped (payments + core/ports), src/__tests__ + core/auth 436 pass (real-modules-boot incl.), worker 10 pass; tsc clean for payments.
[CONV] handlers = 33 placeholders -> 503 common.service_unavailable (as billing BL-T01); port methods = stub result payments.gateway_not_available; worker manifest empty (tasks come with their tasks).
[CONV] `paymentCallback` is a callable carrying `.resolve` (core registry needs `.resolve`, test wants typeof function); resolves nothing = fail closed until PG-T09.
[CONV] config also requires https on all four gateway URLs and on every RETURN_URL_ALLOWLIST entry; KEK-file errors never echo file content (JSON.parse message would).
Open: LD-26 training-tenant sandbox-only check not implementable (no C2 port exposes trainingMode) -> `.orchestra/cr/PG-T01.nonblocking.md` (CR-C15-011, pairs with CR-C2-T16 / CR-C6-023); belongs to merchant-account task.
Worker imports api `modules/payments/config.js` (same cross-service pattern as analytics jobs).
