# AN-T20 impl (writer) — LD-89
- core/session: types.ts `actor.membershipId?: string`; store.ts dev session sets it from BffSession.membershipId; c2.ts optional `membership_id` -> membershipId only when a string [CONV: LD-89].
- schedules-page.tsx reads `actor.membershipId` directly (cast removed, comment cites LD-89).
- Tests AN-T20: 136/137. Only failure: schedules l.182 (creator as recipient) — harness mock `getShellSession` lacks `membershipId`; see AN-T20-dispute.md (tester adds `membershipId: OWNER_M` at harness l.38).
- l.436 REQ-SEC-088 test passes (tester already picks the recipient explicitly).
- Open: in production the creator default stays absent until C2 resolveSession returns membership_id (lead follow-up).
- Not run: Playwright E2E, other core/session suites, repo-wide tsc.
