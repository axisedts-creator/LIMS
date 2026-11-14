# C6-T30 dispute (round 2) — AC-10.2/10.3 test "unknown / revoked / unreleased / malformed: status, headers and body identical" (spec.ts:317)

Revised normaliser (spec.ts:19) still misses one form of the same per-response nonce the ruling (C6-T30-ruling.md) says to mask.

Measured (4 tokens, dev server, test's exact norm()): the only remaining difference is the RSC flight payload inside the body's `self.__next_f.push(...)` script, where Next serialises the CSS preload hint as `["...css","style",{"nonce":"<per-request nonce>"}]`. After JSON.stringify of the test this appears as `\\\"nonce\\\":\\\"K79gJyo62wUeZ2g5MDxYBg==\\\"` — key/value JSON form, not `nonce="..."` nor `nonce-...`, so none of the regexes match.
With that one form also masked, all 4 shots are byte-identical (checked: `/nonce(\\+)":(\\+)"[^"\\]*\\+"/g` -> `nonce$1":$2"X$2"`).

Same class as ruling reason 2 (REQ-SEC-089 nonce, required, token-independent); the app cannot drop it without dropping the nonce CSP.

Ask: tester adds a mask for the JSON key form `"nonce":"<value>"` (raw and escaped), keeping all other bytes compared.

Writer fix made this round (real defect, found while diffing): malformed tokens skipped the Q1 call, so React's dev debug chunks (and timing) differed; `/v/[token]/page.tsx` now forwards every token to Q1 (API answers malformed with the same 404, AC-10.3).
