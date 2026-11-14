APPROVE

Scope: git diff b6ab4e2d..HEAD (d0b9a178, debugger round 10).
- QueueBoard.tsx / TokenSlip.tsx: inline `border-radius` removed from CSS strings; same values moved to packages/ui/src/components/kit.css (`var(--lims-radius-md)`, print `0`). Fixes the real failure "component code: no ... border-radius" (10-DESIGN-SYSTEM s2.3, s8; LD-140). Comment cites LD-140.
- Appearance unchanged (same token, same print override); no API/field/route/permission change. No test edited. Owned paths only (packages/ui/src/components/**, plus the debug note).
- No colour literals, secrets or PHI added. RLS/idempotency/error codes: not applicable (UI-only diff).
- Reviewer ran ui-r03-kit-pass.test.tsx: 149/149 pass.
- Note (not a defect): consumers rendering QueueBoard/TokenSlip must import `@…/ui/kit.css` to get the radius, same as every other kit component (.lims-card etc.).
