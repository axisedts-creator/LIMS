# T-L4 impl (writer)
- Files: api `service/selfreg.service.ts` (E16/E17 logic), `handlers/selfreg.handlers.ts` (assertRole then service; wired in `handlers/index.ts`); worker `tasks/create_self_patient.ts` (wired in `jobs/engagement/index.ts`).
- Tests: api selfreg.handlers 57/57, worker create_self_patient 26/26; whole engagement api dir 1424/1425, worker engagement 264 pass.
- Unrelated failure: `boot.test.ts` "PHASE_STUBS no longer lists EngagementPort and still lists QualityPort" (phase-stubs.ts, untouched by T-L4).
- tsc: no errors in T-L4 files (repo has pre-existing errors elsewhere).
- [CONV] expires_at = now+30d at request; reset to terminal+30d by the task (purge_ephemeral keys on it). Age rule uses the Asia/Kathmandu calendar date. Future birth_on rejected for self and child.
- [CONV] failure_code = registry error code (e.g. `frontdesk.consent_required`) else `common.internal` (review fix: registered code, no invented name); lost race on self-link index (23505) -> failed at once as `engagement.link_limit_reached`.
- Open: no FOR UPDATE on the registration (FakeDb locks never release); link_consents.patient_id stays NULL (matrix gives no UPDATE on link_consents); no `recorded_by_account_id` column exists (TRD text vs schema), so not written.
