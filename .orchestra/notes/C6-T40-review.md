APPROVE

Re-review after review-fix commits 485ad1f0 + 7f19446e.
- Defect 1 fixed: domain/messages.ts exports `portalReportUrlOk` (canonical href, no userinfo, https:, origin match, `${origin}/r/` prefix, non-empty token, unset origin fails closed); RenderPort.impl.ts:59 uses it; `portalUrlOk` (§7.2) delegates to it, OTP `v === origin` branch kept.
- Defect 2 fixed: case (8) table now has dot-segment and whitespace cases.
- Ran: api render.access-slip.test.ts 49/49 pass; renderer access-slip.test.ts + registry.test.ts 37/37 pass.
- Full api reporting run: 2 test failures (bulk-release latency self-check, repository.static inline SQL) and 6 files failing in beforeAll hooks (manifest, settings, delivery, messaging-admin, release, regenerate); none of these files touched by this diff — cause not investigated; this diff does not touch those files.
- Still open (not C6-T40): C0-owned contracts/render/partners.access_slip.schema.json and API log-redaction [CONV] for portalUrl.
