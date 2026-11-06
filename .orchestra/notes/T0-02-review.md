APPROVE

Scope: `git diff 832e062..HEAD` = `tools/lint/ownership.yaml` (new) + `.orchestra/notes/T0-02-impl.md`. Only owned paths (C0-0A `tools/lint/**`).

Checked:
- Every CM §3 tree entry, the module → owner table (identity..homecollection, admin/platform → C2), the route-group / renderer-template exceptions (08 R14, CR-C13-001, CR-C16-001) and every TRD §1.1 0A–0D sub-path have a rule with the owner the spec names. No invented paths or owners (`DOC-OWNER` is the token the test contract defines for CM "DOC OWNER (founder)").
- Nested exceptions (renderer templates/{smart,billing,analytics}, `(staff)/layout.tsx` vs `(staff)/<m>/`) resolve by specificity; no equal-specificity conflicts.
- No feature chunk owns a C0 zone (db, contracts, packages, src/core, .github).
- RLS / permissions / idempotency / rate tier / error codes / PHI logging: not applicable (config file only). No secrets.
- `node --test tests/lint/ownership.test.mjs`: 10/10 pass (no gaps, no overlaps, owners per CM/TRD, AC-0A-1.1 billing → C4 named, AC-0A-1.2 lab-only passes).

Non-blocking note: CM module table rows `core` (C0 tables / C2 logic), `audit` (C0 / C2 viewer) and `migration_staging` (C18) give no module paths under api/worker/web; impl leaves those paths as gaps on purpose (lint will flag them). If a chunk needs `apps/web/src/features/audit/` etc., that needs a CR before T0A-02 relies on it.
