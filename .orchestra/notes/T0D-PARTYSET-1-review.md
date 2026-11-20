CHANGES

1. Missing CR file `.orchestra/cr/T0D-PARTYSET-1.md`. Code cites it but it does not exist: `apps/web/src/features/partners/components/OnboardingQueue.tsx:5` ("CONTRACT GAP (CR T0D-PARTYSET-1)") and `apps/web/src/features/partners/components/PenaltyEvents.tsx:5` (same). `.orchestra/notes/T0D-PARTYSET-1-impl.md:7` says "Open: CR for contract gaps a, b, c, e". CLAUDE.md requires the CR whenever a name or field is missing. Fix: write `.orchestra/cr/T0D-PARTYSET-1.md` using the template in spec/program/04-CHANGE-REQUESTS.md §2 (precedent: `.orchestra/cr/T0D-SALES-1.md`). Use one numbered item per gap:
   (a) `PartyOnboarding` (partners.yaml schema used by listPartyOnboarding) has no creator field. Ask for a `created_by` field (with a display name for Requested By) so the UI can disable Approve, Hold and Reject for the creator before the server refuses with 403. The service already enforces the rule at `service/partyset.service.ts:175`.
   (b) `NonComplianceEvent` has no `party_name` or `penalty_name`, so the UI has to join them from lists capped at 200 rows.
   (c) `Doctor` has no `tax_number` (doctor PAN), so done_when 4 is met only in part.
   (e) There is no party search operation for the Raise picker.
   Each item needs a to-chunk, the exact proposed field or operation, and a note that it does not block. No source change is needed.

Verified (no other defects):
- Paths, methods and operationIds match `contracts/openapi/partners.yaml` (8190–9260) and catalog.yaml.
- Idempotency-Key is sent on every create, raise and charge (x-idempotency required), and charge sends both the key and If-Match. If-Match is sent on PATCH, deactivate, decision and waive. The PUT on settings has no key (x-idempotency none) and leaves out If-Match only on the first save of a default row, as the contract says.
- The server actions re-check kind, uuid, enums and ranges. The reveal returns its value only into component state (not logged, stored or put in a URL), and the server audits it.
- Permissions match LD-321 and routes.yaml. No PHI, no secrets. All files are web or routes files; nothing under admin, platform or auth.
- Tests run by the reviewer on 2026-11-20, all green: partyset1 165/165, t16 120/120, rs-c2 74/74, uilist3 173/173, web-t33.components 76/76, nav-complete.catalog 6/6. The sales1 suite, uiset1 and the nav.manifest node test were not re-run.
