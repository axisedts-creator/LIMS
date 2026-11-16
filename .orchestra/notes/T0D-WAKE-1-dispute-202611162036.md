# T0D-WAKE-1 dispute (writer, round 2)
Ruling item 1 applied by tester: wake1 config now 53/53 pass.
Ruling item 2 NOT applied: rs-c2.static.test.ts still 2 red ("data, action ... untouched", "same route files") against stale rs-c2.baseline.json
(diff: + "app/(auth)/auth/waking/page.tsx"; actions.ts/messages.ts hashes). Ruling says the tester re-records it with RS_C2_RECORD=1 on this tree and commits.
The baseline is a test artifact, so the writer may not edit it. Impl stands; writer stops.
