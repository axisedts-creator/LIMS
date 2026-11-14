# T-SEC1 impl (writer)
- Round 1: MainActivity.kt `lims_ui/secure_screen` channel (FLAG_SECURE enable/disable), REQ-SEC-109 [CONV channel name from LimsSecureScreen].
- Round 2 (ruling IMPLEMENTATION_WRONG): new service/profile.service.ts + handlers/profile.handlers.ts = E13 listMyProfiles, E18 updateMyProfile, E19 removeMyProfile; R4 listFollowUpSuggestions in reminder.service/.repo/.handlers; registered in handlers/index.ts.
- [CONV] E13: data = active links (≤10), paused_count = suspended count, pending = self_registrations queued or failed-not-expired (≤10). E18/E19 act on the caller's ACTIVE link only (suspended/revoked/foreign = 404); E19 -> revoked, revoked_by_kind 'account', access log app_link.revoke. self clash (23505) -> engagement.link_limit_reached.
- [CONV] R4: smart_summaries of valid report versions; one row per summary.followUps[i]; due_on = released_at + interval_days (UTC date); has_reminder = non-cancelled follow_up reminder with source_ref_id = summary id, seq = i. Unknown patient -> empty list.
- Result: probes 63/63 pass; engagement suite 1980 pass, 1 fail = boot.test PHASE_STUBS (pre-existing, phase-stubs.ts not owned).
- OPEN: no dedicated unit tests for E13/E18/E19/R4 behaviour (T-L6 / T-P4 tester should add); routing note in ruling (task briefs) for lead.
