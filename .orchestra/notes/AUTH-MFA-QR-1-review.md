APPROVE

# AUTH-MFA-QR-1 review (reviewer)
- Scope: diff 6aedd740..HEAD touches only the 3 LD-214 files (startMfaEnrolment.ts, new handlers/mfaQr.ts, new __tests__/mfa.qr.test.ts) plus lane notes. No gateway/fake/contract/web/db/spec edits.
- Names verbatim: `qr_svg_base64`, `MfaEnrolmentStart` (maxLength 20000), `qrSvgToBase64(input: string | undefined): string | undefined` as LD-214 states; gateway `qrSvg?: string` already existed.
- Helper vs LD-214 HELPER RULES: accepts image/svg+xml and img/svg+xml, optional params, ;base64, percent-encoded, raw text, bare SVG; requires `<svg` after whitespace + optional XML declaration; rejects script/foreignObject/iframe/object/embed, on*=, javascript:, href/xlink:href/url( to http(s), // or data:; no sanitising; output is plain base64, capped at 20000; non-string/empty/malformed gives undefined; try/catch so it never throws. Extra hardening (closing tag needed, DOCTYPE/ENTITY rejected) is stricter than the LD and does not break any AC.
- Handler: qr_svg_base64 is added only when the helper returns a value; factor creation, stale-factor delete, GoTrue calls and errors are unchanged. Nothing new is logged (E1); no PHI and no secrets.
- No RLS/migration/permission/rate-tier/idempotency surface changed (x-idempotency none kept).
- Tests cover every listed done_when/AC item, including AJV validation against the contract with the response options, the 20000/20004 boundary, round trip and log/write/tx hygiene.
- Ran: `vitest run src/modules/identity/handlers/__tests__/` gave 580 passed, 10 skipped. jwt.test + bff-session.test run alone gave 386/386 (the writer's reported full-suite failures are in untouched files). tsc shows no errors in the touched files.
- Not verified: the real hosted GoTrue qr_code format (never seen live, as LD-214 NOT COVERED notes). Non-blocking: entity-encoded attribute values (e.g. `&#106;avascript:`) would get past the regexes, but the web renders the QR via <img src=data:>, where SVG scripts and external fetches are inert.
