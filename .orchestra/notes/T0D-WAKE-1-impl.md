# T0D-WAKE-1 impl (writer)
Files: core/session/c2.ts + types.ts (`waking:true` on fetch reject only), features/admin/auth/actions.ts (`call()` catch + Fail type), messages.ts (ActionResult `waking?`), middleware.ts (document + waking -> rewrite /auth/waking, forwards fwd headers; JSON/401 unchanged), new WakingState.tsx (WakingState + useAuthSubmit), LoginForm/MfaChallengeForm/SetPasswordForm (use useAuthSubmit; waking -> WakingState instead of card), new app/(auth)/auth/waking/page.tsx.
[CONV] one shared hook `useAuthSubmit` in WakingState.tsx keeps the waking failure during a retry so WakingState stays mounted (one auto retry, never restarted).
[CONV] timeouts left at 5000 ms (<= 8000). requestRecoveryAction still returns { ok:true }.
Round 4 (2026-11-16 21:49, after arbiter round 3): wake1 53/53 pass, ui 41 pass, rs-c2.static 12/14 (same 2 stale-baseline fails; baseline still ec073f164). Impl unchanged; needs tester stage.
Checks (round 3, 2026-11-16 20:45): wake1 config 34 + 19 (component file alone; full run hit a vitest worker-start timeout under load) = 53/53 pass; ui no-raw-style-literals 41 pass; rs-c2.static 12/14 (2 fail: stale baseline, ruling round 2 item 1 still unapplied, no tester commit on rs-c2.baseline.json).
Open: tester re-records rs-c2 baseline with RS_C2_RECORD=1 per ruling; then writer re-runs verify.cmd. Impl unchanged.
