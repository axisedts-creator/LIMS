Title: CR-C0-ACTIVATE-1: spec text for first-admin activation of a provisioning tenant (LD-299)
From chunk: C0 (lane C0-0B)            To owner: C2 (spec text owner)
Type: bug
Blocking? no (code fixed under LD-299 in T0B-ACTIVATE-1)
Problem: activateTenant needs an accepted tenant_admin (C2 01-PRD AC-E1.3), but confirmEmailToken accepted invite links only for tenant_status active, and acceptInvitation accepted only invitations in status sent (worker identity.send_invitation sets sent; no worker on staging). A freshly provisioned tenant could never be activated (live: metrolabs 2026-11-16).
Proposed change (exact, spec text only):
- C2 01-PRD AC-E1.3: add "the first tenant admin accepts the invite while the tenant is `provisioning`".
- C2 01-PRD AC-A7.2 (and the invite sibling AC): an `invite` link is usable when tenant status is `provisioning` or `active`; a `recovery` link still needs `active`.
- C2 03-APP-FLOW §3.7: invitation acceptance moves an invitation in status `pending` or `sent` (expiry checked) to `accepted`.
- C2 03-APP-FLOW §4.1: note that login (and resolveSession, session.service.ts:173) of a provisioning tenant stays refused until activateTenant; only the password_setup session from the invite link works there (setPasswordFromSetup does not resolve through it). No resolver widening.
Backward compatible? yes. Tenant/security impact: no RLS change; invite of a provisioning tenant still requires a GoTrue-verified token, exactly one membership, not locked, status invited/active (AU-T6/T21 unchanged, same no-oracle 400).
Alternatives considered: keep `sent` only and require the worker (rejected: staging has no worker; a verified token already proves the address).
Tests that will prove it: handlers/__tests__/activate.*.test.ts, repository/__tests__/mfa.repo.accept-invitation.test.ts.

---
Title: CR-C0-ACTIVATE-1b (nonblocking): invitation mail needs the worker and the Supabase mail template (founder decision)
Type: port   Blocking? no
Problem: no invitation mail reaches the user on staging: identity.send_invitation runs only in the worker, and the Supabase invite mail template must point at the LIMS confirm route.
Proposed change: run the worker on staging (or founder decision otherwise); set the Supabase "Invite user" (and "Reset password") template link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` (recovery: `type=recovery`), which the web app posts to confirmEmailToken as `{ token_hash, type }`.
Tests that will prove it: manual staging invite of a synthetic user; link opens /auth/confirm and reaches set password.
