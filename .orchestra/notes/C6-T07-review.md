CHANGES
# C6-T07 review (reviewer), diff 4569294..d248ffd

1. services/renderer/src/templates/lab/shared.ts:467-473 (statusBox). 04-UI-UX §3.2 says "replaces version {n} issued {date}", and {date} means the issue date of version n. The snapshot has no field for that date (02-TRD §4.3 `amendmentNotes`), so the code prints `amendedAt` under the "issued" label as a [CONV]. That puts a false date on an amended or addendum clinical report. Under the project rules a missing field gets a CR, not a [CONV].
   Fix: add item 3 to `.orchestra/cr/C6-T07.nonblocking.md` (CR-C6-024). Propose adding `previousIssuedAt: IsoUtc` to 02-TRD §4.3 `amendmentNotes[]`, filled at assembly from `released_at` of version n. Then change the [CONV] comment at shared.ts:467 to cite that CR. Once the CR merges, statusBox prints `previousIssuedAt`.
2. services/renderer/src/templates/lab/shared.ts:465-479. The 04-UI-UX §3.2 "Partial report" box ("PARTIAL REPORT — results for {k} test(s) are still pending.") is not implemented, and no CR exists for it. impl.md only says "skipped". `reportKind: 'partial'` renders with no box.
   Fix: add item 4 to CR-C6-024. Propose a `pendingTestCount: number` field on ReportDocument (02-TRD §4.3), present when reportKind = 'partial'. Add a `// [CONV] partial box pending CR-C6-024` comment at statusBox.

## Checked, OK
- Names match 02-TRD §5.3/§6.5 verbatim. The schema bounds and defaults match §6.5, and every object is closed with `additionalProperties:false`. The LD-26 `trainingMode` and LD-27 `council` additions cite their LDs.
- Only owned paths changed (services/renderer/**, services/api/src/modules/reporting/**). No DB, RLS, routes, permissions or logging in scope. No secrets. Synthetic data only.
- Security: escaping covers all text. The narrative and smart re-sanitiser only allows a list of tags and drops every attribute. Resolver URIs are forced to `data:image/(png|jpeg)`, and no external refs remain.
- QR encoder: I compared it line by line with the reference algorithm (ECC-M tables, RS, format/version bits, placement, masks) and found no differences. It encodes `qr.verifyUrl`. There is no decode test because no decoder is in the repo.
- I ran: renderer templates 73/73 pass; api templates.test 38/38 pass; `tsc -p services/renderer` clean.
- Non-blocking: shared.ts:4 imports bsdate with a relative path outside the package. Billing uses the same pattern. Dockerfile.renderer (`--rootDir src`, no packages/ copied) will fail to build the image. The writer flagged this for T08; the T08 wiring must fix it. qr.ts:3 cites `.orchestra/cr/C6-T07.md`, but the actual file is `C6-T07.nonblocking.md`.
