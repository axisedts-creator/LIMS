# PG-T06 impl (writer)
Files: services/api/src/modules/payments/gateways/esewa.adapter.ts (new; exports createEsewaAdapter, esewaSign, StoredIntent, IntentAction, GatewayCheck, CallContext).
Run: 102/102 pass after arbiter ruling (test fixed, impl unchanged).
[CONV] check() does its own fetch, not callGateway: TRD §7.2.4 needs raw body text for the `totalAmount` regex (callGateway returns parsed JSON only, floats lose 90071992547409.91). Reuses http.ts redactResponse/cutChars/limits; same outcome classification and sink row.
[CONV] buildAction/verifyCallbackSignature are async (SecretHandle.use is async); TRD §7.1 shows sync types, tests await.
[CONV] scd != productCode -> answer without amountPaisa (never matches); service-level gateway_identity_mismatch is PG-T14.
Open: initiate() not implemented (IntentForGateway/expiresAt undefined in spec). tsc: 0 errors in adapter (25 pre-existing in contracts/ports, not owned); eslint not installed in services/api.
