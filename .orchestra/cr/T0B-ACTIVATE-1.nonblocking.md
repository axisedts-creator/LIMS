Title: CR-C0-ACTIVATE-1: spec text for first-admin activation of a provisioning tenant (LD-299)
From chunk: C0 (lane C0-0B)            To owner: C2 (spec text owner)
Type: bug
Blocking? no (invite-link fix done under LD-299 in T0B-ACTIVATE-1; pending acceptance split out as ACTIVATE-1c below)
Problem: activateTenant needs an accepted tenant_admin (C2 01-PRD AC-E1.3), but confirmEmailToken accepted invite links only for tenant_status active. A freshly provisioned tenant could never be activated (live: metrolabs 2026-11-16).
Proposed change (exact, spec text only):
- C2 01-PRD AC-E1.3: add "the first tenant admin accepts the invite while the tenant is `provisioning`".
- C2 01-PRD AC-A7.2 (and the invite sibling AC): an `invite` link is usable when tenant status is `provisioning` or `active`; a `recovery` link still needs `active`.
- C2 03-APP-FLOW §4.1: note that login (and resolveSession, session.service.ts:173) of a provisioning tenant stays refused until activateTenant; only the password_setup session from the invite link works there (setPasswordFromSetup does not resolve through it). No resolver widening.
Backward compatible? yes. Tenant/security impact: no RLS change; invite of a provisioning tenant still requires a GoTrue-verified token, exactly one membership, not locked, status invited/active (AU-T6/T21 unchanged, same no-oracle 400).
Tests that will prove it: handlers/__tests__/activate.*.test.ts.

---
Title: CR-C0-ACTIVATE-1c (RULED YES, LD-302 2026-11-17): accept an invitation in status `pending`
From chunk: C0 (lane C0-0B)            To owner: C2 (spec text owner) / lead
Type: bug
Blocking? no longer — RULED by lead LD-302: pending or sent is accepted once the GoTrue invite token is verified, not expired, exactly one membership, not locked, status invited/active; revoked, failed, expired stay refused (same no-oracle 400). Implemented in T0B-ACTIVATE-2. Spec text to apply by C2 owner (not edited here): C2 03-APP-FLOW §2.6 add edge `pending → accepted`; C2 03-APP-FLOW M2 precondition becomes "invitation `pending` or `sent`, not expired".
Problem: C2 03-APP-FLOW §2.6 (line 120) allows only `sent → accepted` (pending → sent/failed/revoked), and M2 (line 60) requires "invitation `sent`, not expired"; domain/invitation.state.ts EDGES agree. Only the worker task identity.send_invitation moves pending → sent; staging runs no worker, so set password there leaves the membership `invited` and activateTenant stays refused.
Proposed change (if ruled): 03-APP-FLOW §2.6 add edge `pending → accepted` (verified GoTrue invite token proves the address); M2 precondition "invitation `pending` or `sent`, not expired"; invitation.state.ts EDGES `pending: ['sent','failed','revoked','accepted']`; INVITE_ACCEPT_SQL `status IN ('pending','sent')`.
Until ruled: staging needs the worker (or the founder SQL workaround, LD-299) to mark the invitation `sent`.
Alternatives considered: run the worker on staging (ACTIVATE-1b) — no spec change.
Tests that will prove it: repository/__tests__/mfa.repo.accept-invitation.test.ts, handlers/__tests__/activate.chain.test.ts (worker-seam step).

---
Title: CR-C0-ACTIVATE-1b (nonblocking): invitation mail needs the worker and the Supabase mail template (founder decision)
Type: port   Blocking? no
Problem: no invitation mail reaches the user on staging: identity.send_invitation runs only in the worker, and the Supabase invite mail template must point at the LIMS confirm route.
Proposed change: run the worker on staging (or founder decision otherwise); set the Supabase "Invite user" (and "Reset password") template link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` (recovery: `type=recovery`), which the web app posts to confirmEmailToken as `{ token_hash, type }`.
Tests that will prove it: manual staging invite of a synthetic user; link opens /auth/confirm and reaches set password.
