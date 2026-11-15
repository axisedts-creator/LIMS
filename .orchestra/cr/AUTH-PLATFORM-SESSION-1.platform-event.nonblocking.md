Title: CR-AUTH-PLATFORM-SESSION-1 (to C2 and the lead): platform MFA enrolment still fails at its last step, recordPlatformEvent is refused by RLS
Severity: non-blocking (does not hold AUTH-PLATFORM-SESSION-1). Needs a separate founder decision before any change.
Fact: completeMfaEnrolment for a platform user calls repo.recordPlatformEvent (event platform_mfa_enrolled): a plain INSERT INTO identity.platform_events as the system actor. The table is FORCE RLS; the only INSERT policy is, in db/migrations/20261105001300_identity__create_identity_schema.sql lines 841-842:
  CREATE POLICY platform_events__insert__owner_only ON identity.platform_events FOR INSERT TO lims_owner
    WITH CHECK (event_type = 'bootstrap_admin_created');
lims_api is not lims_owner and the event type differs, so the insert is refused and enrolment would end in a 500 even after the two read DEFINERs.
Not changed here: recordPlatformEvent and every policy are untouched (LD-216 scope).
Ask C2 and the lead: decide how platform_mfa_enrolled is recorded (a write DEFINER like app.identity_platform_auth_write_*, or a policy change), after a founder yes.
