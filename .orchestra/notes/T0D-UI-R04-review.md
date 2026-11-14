APPROVE

Reviewed `git diff 91985c09..HEAD` against 10-DESIGN-SYSTEM §3, LD-140, C4 02-TRD F1, C5 02-TRD lookup row, 03-INTERFACE-CATALOG routes.
- Names verbatim: POST /v1/lab/specimens/lookup `{barcode}` (^[A-Z0-9]{1,20}$, 404 common.not_found), POST /v1/frontdesk/patients/search `{query, mode:auto, limit:20}`, PatientSummary id/full_name/patient_code, SpecimenDto.order_id, routes staff.frontdesk.order /frontdesk/orders/{order_id} and staff.frontdesk.patient /frontdesk/patients/{patient_id}, permissions frontdesk.patient.read / lab.specimen.read.
- Search text in body only, server action via serverFetch (no token client-side), errors reduced to generic kind, no logging, no PHI in URL. API still enforces; client flags only skip calls.
- Nav still from build-nav generated manifest + hasPermission; 8 groups in spec order; no hard-coded entries. Tokens/kit classes only, no hex or pixel radii.
- Owned paths only (core/shell, core/nav, core/shortcuts, core/i18n, app/layout.tsx, e2e/shell). No DB/RLS surface in this task.
- Reviewer ran verify: build:nav ok (77 entries), vitest r04 config 87/87 pass; tree clean after.
Non-blocking (not defects): centre switcher not shown in production until CR T0D-UI-R04.nonblocking (code comments cite `.orchestra/cr/T0D-UI-R04.md`, the file was renamed by orchestra); e2e "active centre is always visible" will fail until that CR lands. Playwright e2e not run (no stack).
