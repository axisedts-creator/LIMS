TESTS_WRONG — fix the normaliser in tests/portal-e2e/C6-T30.portal.spec.ts:18/316 so per-request randomness is masked: also replace the JSON-escaped form `nonce=\"...\"` (e.g. normalise header/body before JSON.stringify, or add `/nonce=\\"[^"\\]*\\"/g`) and mask `self.__next_r="<id>"` (`/__next_r="[^"]*"/g` on the raw body). Keep every other byte compared (status, all other headers, body).

Reasons:
1. AC-10.3 (spec/chunks/C6-reporting-delivery/01-PRD.md:208) requires body, status and headers identical across unknown/revoked/unreleased/malformed; its purpose is no token-derived signal (07-SECURITY.md:36 REQ-SEC-093, :68 T1, :97 A2).
2. REQ-SEC-089 (07-SECURITY.md:34; AC-11.9 01-PRD.md:222) mandates a nonce CSP on /v/ pages, so a fresh nonce per response is required; a literal byte-identical reading would contradict it. The test author already accepts this (norm() masks `nonce-…` and `nonce="…"`), but the regex misses the escaped form produced by JSON.stringify — a test defect, not an implementation one.
3. `__next_r` is per-render framework randomness, same class as the nonce, independent of the token; the spec skeleton requires a server-rendered Next page (`v/[token]/page.tsx`), so the app cannot remove it.
4. Writer evidence: all other bytes match across 4 tokens. Not a spec gap, so no CR.
Note (not disputed): AC-10.3 fixes status 404 `reporting.verify_not_found`; test line 319 only checks `< 500` — tester may tighten to 404.
