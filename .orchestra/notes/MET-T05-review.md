APPROVE
- Diff 9e0bf59d..HEAD: only `apps/web/src/features/instruments/components/InstrumentForm.tsx` (owned) + impl note. H80E constants, wording and tests untouched.
- Matches 09-ADDENDUM §1 (tcp_server, lab-PC static LAN IP, never 0.0.0.0, allowed peer = analyser IP, lab PC not cloud, no TLS), §3 example ids (U2, nothing seeded), §9 nine steps + runbook path `docs/manual/instruments/getein-metis-commissioning.md`, CR-C7-021/022 named verbatim. LD-163 cited.
- Host-query toggle gate unchanged (capability AND status = verified), so disabled with reason while getein_metis is generic.
- No backend/RLS/permission/PHI/secret surface in this diff.
- Ran: met-t05 vitest 38/38 pass; h80-t06 vitest 31/31 pass. Not run: Playwright/axe e2e (needs stack), tsc/lint.
