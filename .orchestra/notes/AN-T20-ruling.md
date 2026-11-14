TESTS_WRONG — an-t20.schedules.test.tsx:433 gives the hostile name to the creator (OWNER_M), who is already the default recipient chip, so the explicit pick at 436–437 can never find an option.
1. Spec: Recipients is a multi `Combobox`, 1–20 people, default "creator" (spec/chunks/C8-analytics-mis/04-UI-UX.md:181). With the harness session carrying membershipId = OWNER_M (previous ruling; LD-89), OWNER_M is pre-selected, as line 182 requires.
2. A multi-select need not offer a person already chosen; ScheduleEditor.tsx:87,149 offers only the people not yet chosen. Nothing in 04-UI-UX.md:181 requires a chosen person to be offered again. So with OWNER_M as the only recipient, the list is empty and line 437 fails. The test is at fault, not the implementation.
3. REQ-SEC-088 (spec/chunks/C8-analytics-mis/07-SECURITY.md:22) only needs a hostile name shown as text. LD-89 (inbox AN-T20-arbiter.md:44) wants it reached by an explicit pick, not by the creator chip. A non-creator recipient meets both.
Tester: change only line 433 to
`recipients: [{ membership_id: OWNER_M, display_name: 'Synthetic Owner' }, { membership_id: MEMBER_2, display_name: H }]`
(import MEMBER_2 from ./an-t20.harness if it is not already imported). Leave lines 182 and 434–439 unchanged. Then run notes/AN-T20-verify.cmd.
