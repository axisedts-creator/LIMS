# T0D-WAKE-1 impl (writer)
Files: core/session/c2.ts + types.ts (`waking:true` on fetch reject only), features/admin/auth/actions.ts (`call()` catch + Fail type), messages.ts (ActionResult `waking?`), middleware.ts (document + waking -> rewrite /auth/waking, forwards fwd headers; JSON/401 unchanged), new WakingState.tsx (WakingState + useAuthSubmit), LoginForm/MfaChallengeForm/SetPasswordForm (use useAuthSubmit; waking -> WakingState instead of card), new app/(auth)/auth/waking/page.tsx.
[CONV] one shared hook `useAuthSubmit` in WakingState.tsx keeps the waking failure during a retry so WakingState stays mounted (one auto retry, never restarted).
[CONV] timeouts left at 5000 ms (<= 8000). requestRecoveryAction still returns { ok:true }.
Checks (round 2, after the ruling): wake1 config 53/53 pass; ui no-raw-style-literals 41 pass; rs-c2.static 12/14 (2 fail on the stale baseline because ruling item 2 is not applied yet).
Open: the tester re-records the rs-c2 baseline (dispute.md, round 2). Not committed.
