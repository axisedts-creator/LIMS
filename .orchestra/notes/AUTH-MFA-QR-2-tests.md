# AUTH-MFA-QR-2 tests (tester)
- NEW `services/api/src/modules/identity/handlers/__tests__/mfa.qr.compact.test.ts`: goqrsvg-shaped generator in-file (WebFetch NOT used; shape from done_when), real-size 57x57 (>100000 chars), equality 21/41/57/all-dark/random50, bounds, fills/geometry/`unsupported_qr`, prolog, UNSAFE, MAX_IN, handler logs.
- NEW `apps/web/src/features/admin/auth/__tests__/t12.mfa-qr.test.tsx` (picked up by the existing vitest.t12.config.ts): 20000-char image, notice text, notice above key, page not broken.
- EDITED `mfa.qr.prolog.test.ts` lines 122-123 only: too_long inputs 100001/200000 -> 1000001/2000000 (forced by raising MAX_IN; MAX_IN must be 400000..1000000).
- Run: `.orchestra\notes\AUTH-MFA-QR-2-verify.cmd` (also runs mfa.qr.test, mfa.enrol, mfa.integration and t12.forms).
- Output form is free (stroke or fill path); tests decode both. Quiet zone: dark modules >=4 units from edges; viewBox = modules+8 when the source has none.
- Not asserted (impl choice): zero-size rects, fill+stroke styles, white rect over a dark module, missing canvas size, worst-case checkerboard size (may exceed 15000).
- DataUriImage has no length cap, so the 20000-char test should pass without touching it.
