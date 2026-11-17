Title: CR-C15-0nn: eSewa callback token cannot be regenerated on createIntent replay / getIntent
From chunk: C15            To owner: C15 (TRD owner / founder)
Type: api
Blocking? no (PG-T08 ships with the workaround below; PG-T09 callbacks are unaffected for the first action)
Problem: TRD §6.1 step 2 and §5.3 `getIntent` require the eSewa action (`form_post` with `success_url`, `failure_url`, `launchUrl`) to be regenerated on replay / while open (§7.2). The URLs embed the 256-bit callback token, but only `sha256(token)` is stored (REQ-SEC-053 / TRD §6.1 step 8), so the original token cannot be reproduced. The signed fields (`total_amount, transaction_uuid, product_code`) do not include the URLs, so the signature stays identical.
Proposed change (exact): choose one. (a) Accept: a regenerated action carries a fresh token that does not match the stored hash, so its success/failure callbacks resolve to `outcome=unknown` while polling still settles (what PG-T08 does today). (b) Derive the token: `token = base64url(HMAC-SHA256(KEK-derived key, intent_id))`, stored as sha256, reproducible; needs a rotation rule for the derivation key.
Backward compatible? yes
Tenant/security impact: (b) adds a derivation key; (a) none. No new public surface.
IRD/regulatory impact: none
Alternatives considered: persisting the raw token (rejected, REQ-SEC-053).
Tests that will prove it: replay/getIntent action URLs equal the first action's, and the callback with that token resolves the intent (PG-T09).
