# AN-T20 impl (writer) — LD-89
- core/session: types.ts `actor.membershipId?: string`; store.ts dev session sets it from BffSession.membershipId; c2.ts optional `membership_id` -> membershipId only when a string [CONV: LD-89].
- schedules-page.tsx reads `actor.membershipId` directly (cast removed, comment cites LD-89).
- Tests AN-T20 (verify.cmd config, after tester commit 6d801403): 137/137 pass. No code change needed in this round.
- tsc -p apps/web: no errors in core/session or analytics AN-T20 paths.
- Open: in production the creator default stays absent until C2 resolveSession returns membership_id (lead follow-up).
- Not run: Playwright E2E, other core/session suites.
