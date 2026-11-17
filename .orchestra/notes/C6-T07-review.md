APPROVE
# C6-T07 review round 2 (reviewer), diff 4569294..eb3195d

## Round-1 items: both fixed
1. shared.ts:167-168: the "issued {date}" [CONV] now cites CR-C6-024 item 3 (`amendmentNotes[].previousIssuedAt`). Item 3 has been added to `.orchestra/cr/C6-T07.nonblocking.md`.
2. shared.ts:169: the partial box [CONV] cites CR-C6-024 item 4 (`ReportDocument.pendingTestCount`). Item 4 has been added to the CR.
- Non-blocking nit fixed: qr.ts:3 now cites `.orchestra/cr/C6-T07.nonblocking.md`.

## Re-checked, OK
- Only owned paths changed (services/renderer/**, services/api/src/modules/reporting/**, plus the role notes/CR files).
- No DB, RLS, routes, permissions or logging in scope. No secrets. Synthetic data only.
- Narrative re-sanitiser (REQ-SEC-088): allowlist only, all attributes dropped, dangerous elements dropped with their content, text re-escaped, output balanced.
- LD-27 sigLine: prints "<council> No. <registrationNo>" only when council is NMC or NHPC and a registration number is present. Otherwise it prints name + title only.
- LD-26 watermark cites its LD and appears on every page (tested).
- Ran: renderer templates 73/73 pass; api templates.test 38/38 pass; `tsc --noEmit -p services/renderer` clean.

## Carry-over (non-blocking, for T08 / lead)
- Dockerfile.renderer builds with rootDir src and does not copy packages/shared-ts, so the image build will break on the bsdate import. The T08 wiring must fix this.
- The worker must pass `trainingMode` from the C2 settings port (LD-26).
- CR-C6-024 items 1–4 are still open with the lead.
