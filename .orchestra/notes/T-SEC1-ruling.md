IMPLEMENTATION_WRONG — the test is right; E13 listMyProfiles, E18 updateMyProfile, E19 removeMyProfile and R4 listFollowUpSuggestions must be real handlers (not the T-01 `common.service_unavailable` stub) before T-SEC1 can close.
Reasons:
- spec/chunks/C16-patient-engagement/07-SECURITY.md:129 — §6.1 probes are required for *every* operationId in TRD §5 (E*, R*, ...), each must return `404 common.not_found` with no B data/side effect; a 503 stub cannot satisfy that, so "covered by nothing" is a correct assertion.
- 07-SECURITY.md:22 — REQ-SEC-040 "probes for every operation and table"; plan row T-SEC1 done_when "every operation and table covered" (06-IMPLEMENTATION-PLAN.md:97).
- All four ops are fully specified: 02-TRD.md:442 (E13), :447 (E18), :448 (E19), :513 (R4) — no spec gap, so not CR_NEEDED.
- They are planned, not orphaned: 06-IMPLEMENTATION-PLAN.md:70 T-L6 explicitly includes "remove/relationship (E13, E18, E19)"; :79 T-P4 includes "(+ R4 suggestions source)"; :43 T-R2 R4 panel "when T-P4 exists".
- T-SEC1 depends on "all API tasks" (06-IMPLEMENTATION-PLAN.md:97), so it correctly gates on them.
What the implementation must do: implement E13/E18/E19 per TRD:442-448 (permissions engagement.self.read / engagement.self.manage, If-Match on E18/E19, ≤10 profiles + pending + paused_count) and R4 per TRD:513 (engagement.reminder.read, no test codes/text). Do NOT allow-list them in the test.
Routing note for lead: these handlers sit outside T-SEC1's `__tests__/probes/**`; reopen T-L6 (backend part of E13/E18/E19) and T-P4 (R4) to deliver them — T-L6's file list (features/profiles/** only) omits its backend paths, fix that in the task brief, not the test.
