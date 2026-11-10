APPROVE

Scope: `f6d33bbc..HEAD` touches only notes + `test-results/.last-run.json`; the C6-T30 code (b0e41b31, 9c9540fa, d74e2bc0) was already merged before f6d33bbc and had no review on record, so I reviewed all of `apps/portal/**` against AC-10.1–10.3, AC-11.1–11.12, REQ-SEC-068/089–095/098 and the T30 ruling.

Checked, no defects:
- Headers (middleware.ts): per-request nonce CSP, frame-ancestors 'none', no-referrer, no-store, HSTS, nosniff on all non-_next paths. CSP is report-only under `next dev` only [CONV, noted in the impl note].
- Token handling: credentials go only in `X-Lims-Portal-Credential` (api.ts:31), never in a URL. `server-only` is on api/session/origin. Session and challenge cookies are `__Host-`, HttpOnly, Secure, SameSite=Lax. No token in client state. CodeForm only gets the link token, and that is already in the page URL.
- QR (/v): middleware rewrites to `/v/_` with an `x-qr-token` header, so the payload does not depend on the token. Every token, malformed included, goes to Q1. On 404 it calls `notFound()` and renders one token-independent page (AC-10.3, ruling round 2). The test now asserts 404 (spec :326).
- Link flow: the landing page makes no API call (bots cannot trigger an OTP). Invalid/expired/unknown/malformed tokens all reach the same invalid page. Reissue is POST-only with an Origin check and always gives the same confirmation (AC-11.5). Sign-out is POST + Origin. Download needs a session, streams the attachment, and handles 429 (AC-11.6/11.10/11.12).
- Health summary: read-only, N1 copied verbatim from C14 04-UI-UX:171, error copy when the snapshot can't be rendered, no links or controls (AC-11.11).
- Names and copy match 04-UI-UX §4. Only owned paths changed. No secrets (the BFF key is read from a file path in env). No PHI in logs (the portal does no logging).

Non-blocking observations (not defects):
- AC-10.1/10.2 (PRD) say status "Valid" / "Superseded — a newer version of this report exists"; the impl follows 04-UI-UX:293-294 ("This report is genuine." / "replaced by a newer version"). That is a conflict between the spec documents, not an impl bug. The arbiter can raise a CR if the PRD wording is meant to win.
- AC-11.1 / AC-11.3 are flaky under full-suite load (cold `next dev` compile, fixed 150 ms wait). The fix belongs to the tester-owned config/tests (expect timeout, or `next build && next start`).
- Root `test-results/.last-run.json` is tracked and changes on every run. Not owned by C6. The repo owner should gitignore it.
