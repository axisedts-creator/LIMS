-- T0B-GREEN-3 / LD-365 (founder approved 2026-11-18 07:40 NPT; CR .orchestra/cr/T0B-GREEN-3.identity-worker-uuidv7.nonblocking.md).
-- Worker SQL calls app.uuidv7() (pure id generator, no data access); EXECUTE was lims_owner only.
SET LOCAL ROLE lims_owner;

GRANT EXECUTE ON FUNCTION app.uuidv7() TO lims_worker;
