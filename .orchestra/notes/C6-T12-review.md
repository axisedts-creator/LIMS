APPROVE

Round 2 review of `git diff 45cd1038..HEAD` (review-fix commits for C6-T12). All four round-1 items are fixed:
1. DECISIONS.md now gives the `qpdf --help=all` topic for each option (12.4.2 image) and drops the "not read" disclaimer.
2. server.ts:173-186: the stamp is anchored to the CropBox (or MediaBox) origin and rotated by `/Rotate`. Reviewer checked the 90/270 display-to-user-space mapping by hand: display origin is user (x0+w,y0) for 90 and (x0,y0+h) for 270, and pdf-lib `rotate` is counter-clockwise, so the text sits upright. Tests cover an offset MediaBox, an offset CropBox, Rotate 90/180/270, Rotate+offset, and a mixed merge.
3. `/XFA` is in ACTIVE_NAMES and DECISIONS.md. Tests cover the array and single-stream XFA fixtures, and the fixture has no /JS.
4. The Dockerfile pins `QPDF_SHA256=8a58af5b…36397`. Reviewer fetched the upstream `qpdf-12.4.2.sha256` and the `qpdf-12.4.2.tar.gz` line matches exactly. The PGP signature is not verified (noted in the comment; acceptable).

Reviewer ran: `pnpm --dir services/renderer exec vitest run src/sandbox/__tests__` = 69 passed, 0 skipped (container tests included, so done_when "no network in container test" is now exercised).
Scope: only owned paths (`services/renderer/src/sandbox/*`, `Dockerfile.sandbox`) plus notes. No DB, so RLS/permissions/idempotency do not apply. No log lines, no secrets.
Open for the lead (not defects): rejecting `/URI` bounces hyperlinked outsourced PDFs. `Dockerfile.renderer` has the same missing-corepack problem (another owner).
