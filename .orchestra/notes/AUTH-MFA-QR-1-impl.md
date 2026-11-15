# AUTH-MFA-QR-1 impl (writer)
- Files: services/api/src/modules/identity/handlers/mfaQr.ts (new pure `qrSvgToBase64`), startMfaEnrolment.ts (import + qr_svg_base64 added to the 200 body only when the helper returns a value). No other file changed.
- [CONV] LD-214: reject, never sanitise; any helper failure -> undefined (try/catch), handler never throws for the QR; QR/secret never logged or stored (E1).
- Decisions: data-URI `;base64` params -> strict base64 decode; otherwise decodeURIComponent with raw-text fallback (literal `%` in raw SVG ok); also require a closing `</svg>` or `/>` and reject `<!DOCTYPE`/`<!ENTITY` (extra hardening, not in LD list); input cap 100000 chars.
- Tests: mfa.qr.test.ts + handlers/__tests__ all green (580 passed, 10 skipped); identity+core: 6544 passed; 3 failed = known route-guard.test.ts + jwt.test.ts and bff-session.test.ts, which are flaky under full-suite load (both pass alone: 386/386).
- tsc: no errors in the two touched files.
- Evidence: no local GoTrue reachable in the lane; real totp.qr_code prefix NOT seen.
- Open: real hosted GoTrue qr_code format still unverified live.
