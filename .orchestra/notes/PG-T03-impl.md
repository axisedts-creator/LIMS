# PG-T03 impl (writer)
Files: `services/api/src/modules/payments/service/credentials.ts` (new; only file touched).
Exports: loadKek, encryptSecret, openSecret, secretFingerprint, SecretHandle, types Kek/SecretAad/StoredSecret — match tester seams.
[CONV] Errors are generic (`KEK file invalid`, `credential decrypt failed`); no key/secret material, no logger/console import.
[CONV] AAD = tenant_id|gateway|environment|merchant_account_id; empty or `|`-containing field rejected (fail closed on split ambiguity).
[CONV] kek ids must match `^[A-Za-z0-9_-]{1,32}$` (schema CHECK); all KEK file keys validated as canonical base64 of 32 bytes.
Tests: credentials.test.ts 34/34 pass (vitest, services/api). Full suite/lint/typecheck not run.
Open: SecretHandle keeps the secret in a JS string (#private) — Buffer zeroing not possible; `use()` is repeatable.
