-- T0B-ASYNC-1 (audit RS-11; LD-189 AUTH-SENSITIVE; LD-277): identity.send_recovery (services/worker/src/jobs/identity/tasks/send_recovery.ts)
-- runs as lims_worker and calls app.identity_login_context(uuid); EXECUTE was granted to lims_api only (20261105000800).
-- ONE grant: EXECUTE on that function to lims_worker. No other grant, no REVOKE, no policy, no function change.
-- NOT RUN in the lane (no docker): db/tests/identity/T0B-ASYNC-1_worker_grants.test.sql asserts it; the lead runs it on the machine.
SET LOCAL ROLE lims_owner;

GRANT EXECUTE ON FUNCTION app.identity_login_context(uuid) TO lims_worker;
