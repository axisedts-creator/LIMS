# T0D-WAKE-1 dispute (writer)
1. wake1.component.test.tsx, the 12 form cases (LoginForm / MfaChallengeForm / SetPasswordForm x 4): TEST HANGS, not an impl fault.
   `setup()` calls `vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] })` BEFORE `submit(u)`. Every userEvent call goes through RTL's
   `asyncWrapper`, which awaits a `setTimeout(0)` drain and only auto-advances it when a global `jest` exists; under vitest it never fires,
   so the first `u.type` never resolves (reproduced: hangs at the first `u.type` before any form code runs; first case times out at 30 s,
   the other 3 cascade with an empty `<div/>` because the stuck act() never ends). Same flow passes with the timers faked first and
   `globalThis.jest = { advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms) }` (scratch test, deleted): 1 call, waking shown,
   retry at 15 s with the same values, stops at 2, Retry stays. Fix (tester): that shim in setup (or `afterEach` delete), or fireEvent instead of userEvent.
2. rs-c2.static.test.ts (m5 config) "data, action ... files are untouched" and "same route files": stale RS-C2 baseline. T0D-WAKE-1 brief
   requires the actions.ts failure branch and a new `(auth)/auth/waking/page.tsx`; re-baseline.
Impl stands; writer stops here.
