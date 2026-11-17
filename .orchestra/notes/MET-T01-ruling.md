TESTS_WRONG — `TestH80E_OtherProfilesKeepTodaysBehaviour` (apps/bridge-agent/internal/drivers/truth_h80e_test.go:76-95) asserts that no profile except truth_h80e may ever set ExpectAckOnReply=true or ReplyAckPolicy=last; the spec only requires that the *defaults* keep today's behaviour.

Reasons:
1. CR-C7-016 says only "defaults keep today's behaviour" (spec/chunks/C7-instrument-integration/08-ADDENDUM-TRUTH-H80E.md:231). It does not ban later profiles from opting in explicitly. The test's own comment says "by default" (truth_h80e_test.go:74).
2. The binding Metis addendum (LD-163) registers `getein_metis` with `ExpectAckOnReply: true, ReplyAckPolicy: "last", ReplyAckMatchControlId: false` (09-ADDENDUM-GETEIN-METIS.md:230-239). It is built "on the fields CR-C7-016 added for H80E" (:232). The H80E test and §7 cannot both pass, so the test goes beyond the spec.
3. The task brief says "no existing profile or test changes behaviour". Adding getein_metis to the skip list changes no assertion about any existing profile: the zero-value checks for every other code, and the two sketch checks at :96-102, stay as they are.

Change to the test: in the loop at truth_h80e_test.go:78, change the condition to `if code == "truth_h80e" || code == "getein_metis" { continue }`. Change nothing else. The Metis values are already pinned by drivers/getein_metis_test.go.
Process: LD-163 says "Do not change the Truth H80E driver, its tests". This one-line skip leaves every H80E assertion as it is. The lead must authorize the edit, and the tester role (not the writer) makes it. No spec CR is needed.
