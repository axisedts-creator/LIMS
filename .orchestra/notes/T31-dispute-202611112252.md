# T31 dispute (writer): 2 cases in session-kinds.login.test.ts are TESTS_WRONG (missing clock seam)
Cases: openMobileSession "permitted membership -> 200 ..." (line 111) and "LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS ... 8 h" (line 121).
Why: both assert `ins.absoluteExpiresAt - m.w.clock.ms === N h`, i.e. against the VIRTUAL clock (START 2026-11-11T04:00Z), but the
deps they pass (`makeWorld().deps`) carry no clock and loginRunner's hctx has no `now`, so the handler can only use wall time
(observed diff 89 954 534 ms instead of 43 200 000). No implementation can pass without reading the test's private clock.
Fix (tester, one line): in mobileWorld() add `now: () => new Date(w.clock.ms)` to deps. The writer added the seam `AuthDeps.now`
(used by the shared login envelope, default new Date()). With it both cases pass; everything else is green (99/101).
