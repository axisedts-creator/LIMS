APPROVE

PG-T03 review (diff 9e3f3612..HEAD)
- Spec match TRD §6.9: aes-256-gcm, 96-bit random nonce, 16-byte tag, AAD = `tenant_id|gateway|environment|merchant_account_id`, KEK file `{keys,active}` 32-byte base64, fingerprint = first 8 hex sha256, kek id regex = 05-SCHEMA CHECK. Decrypt uses row `kekId` (rotation, 03-APP-FLOW). SecretHandle `use(fn)` per TRD §2/§7 adapter signatures.
- Fail closed: wrong AAD / KEK / unknown kek id / tampered ct|nonce|tag / bad nonce or tag length all give generic `credential decrypt failed`. KEK load errors generic, no key material.
- No logging or console in credentials.ts. SecretHandle masks toJSON/toString/inspect, secret in #private.
- Paths: only `services/api/src/modules/payments/**` and own notes. No secrets: KEKs random per run, secret is a synthetic marker.
- RLS, permissions, idempotency, rate tier, error codes: not applicable (pure service helper, no route or table).
- Ran: vitest credentials.test.ts 34/34 pass; `tsc --noEmit` shows no credentials errors.
- Covers done_when / AC-PG-10.1: round trip with AAD, each AAD field wrong, ciphertext swap between rows, wrong KEK, planted-secret scan over the real logger + console + stdout/stderr.

Non-blocking notes:
1. TRD §6.9 says "zero the Buffer after use (best effort)". At credentials.ts:75 the decrypted Buffer goes straight to a string and is never zeroed. Cheap best-effort fix: keep the Buffer, call `toString('utf8')`, then `fill(0)` it. The JS string still lingers, which the writer note already records.
2. KEK load is stricter than TRD §9 (every key must be valid, not only the active key). This fails closed and is acceptable. PG-T17/C1 should know that one malformed retired key stops boot.
