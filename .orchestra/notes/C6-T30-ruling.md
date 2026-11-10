TESTS_WRONG — in tests/portal-e2e/C6-T30.portal.spec.ts norm() (:19-24) also mask the JSON key/value nonce form emitted in the RSC flight payload (`self.__next_f.push`), raw and escaped at any depth, e.g. `.replace(/nonce(\\*)":(\\*)"[^"\\]*\\*"/g, 'nonce$1":$2"X$2"')`. Mask only the nonce value; keep every other byte compared (status, all other headers, body).

Reasons (round 2; round-1 reasons still stand):
1. AC-10.3 (spec/chunks/C6-reporting-delivery/01-PRD.md:208) requires identical body/status/headers across unknown/revoked/unreleased/malformed — purpose: no token-derived signal (07-SECURITY.md:36 REQ-SEC-093).
2. REQ-SEC-089 (07-SECURITY.md:34; AC-11.9 01-PRD.md:222) mandates a nonce CSP on /v/ pages, so a fresh per-response nonce is required. Next.js echoes that same nonce as `{"nonce":"…"}` in the flight data for the CSS preload hint; it is the same value already masked as `nonce-…`/`nonce="…"` and is token-independent. Not masking it makes the test contradict REQ-SEC-089.
3. The previous ruling's intent was "mask the per-request nonce"; the regex list was incomplete, not the implementation. Writer reports all other bytes identical across 4 tokens.
4. Writer's change forwarding malformed tokens to Q1 is consistent with AC-10.3 (same 404 path for all four cases); no objection.
5. Not a spec gap — no CR.
Note (repeat, not disputed): AC-10.3 fixes 404 `reporting.verify_not_found`; test :325 checks only `< 500` — tester should tighten to `toBe(404)`.
