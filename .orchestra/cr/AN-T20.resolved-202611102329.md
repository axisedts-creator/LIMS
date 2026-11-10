Title: CR-C8-001: expose the session membership id on ShellSession.actor (AN-T20 schedule creator default)
From chunk: C8            To owner: C2 (field source in SessionState), C0-0D (ShellSession type, apps/web/src/core/session/types.ts)
Type: interface
Blocking? no — AN-T20 ships; the "creator" default recipient is simply absent until this lands (schedules test l.176 stays red by design, AN-T20-review #2).
Problem: 04-UI-UX §8 (US-18) — a new schedule defaults its recipients to the creator. Recipients are membership ids (analytics.yaml ScheduleInput.recipient_membership_ids), but ShellSession.actor (types.ts:9-14) carries only displayName, tenantCode, roles, permissions. The web cannot tell which recipient option is the current user. Same kind of gap as T0D-14 item 3 (permissions).
Proposed change (exact): ShellSession.actor gains `readonly membershipId: string` (uuid of the actor's tenant membership), populated by resolveSession from C2 SessionState; C2 to name the field in its TRD §5.1.
Backward compatible? yes — additive.
Tenant/security impact: none new; the id is the caller's own membership, already visible to them in recipient options; server-side only (REQ-SEC-068 unchanged).
IRD/regulatory impact: n/a
Alternatives considered: matching displayName against recipient options (rejected: names are not unique); calling a "me" API (none in analytics.yaml / routes).
Tests that will prove it: apps/web/src/features/analytics/__tests__/an-t20.schedules.test.tsx l.176 (creator chip present on a new schedule) turns green with no C8 code change (schedules-page.tsx:52 already reads `actor.membershipId`).
