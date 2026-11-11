# PG-T06 impl (writer)
Files: services/api/src/modules/payments/gateways/esewa.adapter.ts (new; exports createEsewaAdapter, esewaSign, StoredIntent, IntentAction, GatewayCheck, CallContext).
Run: 101/102 pass; 1 fails on a wrong test, see PG-T06-dispute.md (`/name/` matches mandated `signed_field_names`).
[CONV] check() does its own fetch, not callGateway: TRD §7.2.4 needs raw body text for the `totalAmount` regex (callGateway returns parsed JSON only, floats lose 90071992547409.91). Reuses http.ts redactResponse/cutChars/limits; same outcome classification and sink row.
[CONV] buildAction/verifyCallbackSignature are async (SecretHandle.use is async); TRD §7.1 shows sync types, tests await.
[CONV] scd != productCode -> answer without amountPaisa (never matches); service-level gateway_identity_mismatch is PG-T14.
Open: initiate() not implemented (IntentForGateway/expiresAt undefined in spec); tsc/lint not run yet.
