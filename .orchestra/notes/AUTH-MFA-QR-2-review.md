APPROVE
# AUTH-MFA-QR-2 review round 2 (reviewer), diff 7b0145509..HEAD (fixes be41d1b4a..1f87bc134)

Round 1 items closed:
1. mfaQr.ts:53-64 `styleFill` parses the style per declaration: exactly one `fill` (BLACK/WHITE) plus an optional `stroke:none`. Any other declaration, any other stroke or a repeated fill gives 'unsupported_qr'. The real `fill:black;stroke:none` / `fill:white;stroke:none` rects now compact.
2. mfa.qr.compact.test.ts:41-50: the default generator now emits the exact svgo/goqrsvg markup (header, xmlns:xlink, 4-module quiet zone, one rect per module including the light ones, ` />`, no background rect). The new case at :107 asserts that a 57x57 real-markup input over 100000 chars gives a defined base64 of 20000 chars or fewer with the same modules. The new negative cases cover stroke:red, opacity, a repeated fill and a light rect with a stroke.

Re-checked and OK: the `unsupported_qr` reason code comes from done_when/LD-247 and the existing eight codes are unchanged. No contract yaml change, no new dependency. UNSAFE runs on input and output. The output is rebuilt only from integer modules. No SVG, key or token in logs. Only owned paths are touched. The web notice copy is verbatim and sits above the key. RLS, permissions, idempotency and rate tier are not touched.
Reviewer ran (2026-11-16): API mfa.qr*/enrol/integration 464 pass, 5 skipped, 0 fail; web t12.mfa-qr + t12.forms 43/43 pass.

Open for lead (not a defect in this diff):
- `pnpm -s verify` was not re-run. The writer reports it RED at @lims/worker#typecheck: 69 errors, none in owned paths. That baseline must be confirmed against main before the done_when "pnpm -s verify green" can count as met.
- Light rects count toward MAX_RECTS = 10000. That caps GoTrue at QR version 20 (97x97), far above a realistic otpauth URL. A very long issuer/email (version 13+, random-dense) may produce too_large; the page then shows the notice and the key fallback, which is the specified behaviour.
