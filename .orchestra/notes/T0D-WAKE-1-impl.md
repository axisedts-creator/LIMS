# T0D-WAKE-1 impl (writer)
Files: core/session/c2.ts + types.ts (`waking:true` on fetch reject only), features/admin/auth/actions.ts (`call()` catch + Fail type), messages.ts (ActionResult `waking?`), middleware.ts (document + waking -> rewrite /auth/waking, forwards fwd headers; JSON/401 unchanged), new WakingState.tsx (WakingState + useAuthSubmit), LoginForm/MfaChallengeForm/SetPasswordForm (use useAuthSubmit; waking -> WakingState instead of card), new app/(auth)/auth/waking/page.tsx.
[CONV] one shared hook `useAuthSubmit` in WakingState.tsx keeps the waking failure during a retry so WakingState stays mounted (one auto retry, never restarted).
[CONV] timeouts left at 5000 ms (<= 8000). requestRecoveryAction still returns { ok:true }.
Checks: wake1 config 41/53 pass (12 = test hang, see dispute); t12 142/142; web-auth-redirect-2 90/90; build-boundaries 16/16; ui no-raw-style-literals 41 pass; m5 380/382 (2 stale rs-c2 baselines, dispute).
Open: dispute items 1-2 for tester/arbiter; not committed.
