# AUTH-MFA-QR-1 tests (tester)
- File: services/api/src/modules/identity/handlers/__tests__/mfa.qr.test.ts (only file added; no helper/fixture changes).
- Helper tests: `qrSvgToBase64` from `../mfaQr.js` (new, pure): accepted spellings, XML decl, UTF-8 round trip, each rejected construct (bare / percent-encoded / base64), 20000 vs 20004 chars, non-string and malformed input.
- Handler tests: `createStartMfaEnrolment` with the fake gateway + per-test `qrSvg`: good QR -> `qr_svg_base64` + 3 base keys, validated against `MfaEnrolmentStart` (contract yaml, response AJV options); bad/missing QR -> omitted, 200; log/write/tx hygiene (E1).
- Decision: raw SVG with a literal `%` (width="100%") after the comma must round-trip (tolerant decoding); internal `url(#id)` / `href="#id"` and the xmlns URL are accepted.
- Run: `pnpm --dir services/api exec vitest run src/modules/identity/handlers/__tests__/mfa.qr.test.ts` (= AUTH-MFA-QR-1-verify.cmd).
- Existing mfa.enrol / mfa.integration / mfa.wiring untouched (fake returns no QR).
