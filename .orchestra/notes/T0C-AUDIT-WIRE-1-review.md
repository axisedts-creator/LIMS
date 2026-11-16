APPROVE
Reviewed `git diff 3ad243c5..HEAD` (T0C-AUDIT-WIRE-1).
- done_when 1: the four handlers are imported and registered in handlers/index.ts `implemented`, the same way as the other identity handlers.
- done_when 2: `_audit-view.bind.ts` calls `IdentityPort.assertRole(ctx, { permission: 'audit.log.read' })` once, after the unauthenticated check and before any read. This matches the contract x-permission (identity.yaml) and the existing audit-export.service.ts:121 pattern. A missing port fails closed with the existing `common.internal`. Reads still go only through repository/audit-read.repo via the existing service.
- done_when 3/4: audit-wire.handlers.test.ts checks deny before any read (repo spy plus statement count), the contract shape through AJV (with a non-vacuous check), tenant isolation, the real IdentityPort, and pipeline stage 9. audit-wire.operations.test.ts checks every operationId, with exactly 4 KNOWN_STUBS that each have a reason.
- done_when 5: no contract, SQL, policy, grant, permission or error-code change. No PHI in logs, no secrets. Only owned paths touched. The C2-T18 fixture change is the one the arbiter ruled on and weakens no assertion.
- Ran: vitest audit-wire.* plus audit-view.handlers.test.ts, 193/193 pass.
- Not a blocker for this task: 2 role-packs script-count failures were already present and are not from this task (package.json is untouched). They are left open for the lead.
