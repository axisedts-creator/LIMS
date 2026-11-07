# T-07 impl (writer)
- Files: new `infra/database/pgbouncer/pgbouncer.ini.j2` (TRD s7.6 values verbatim, whole-line comments only); `infra/compose/supabase/override.data.yml` pgbouncer `volumes:` (ini ro at /etc/pgbouncer/pgbouncer.ini, auth_file ro from /run/lims/secrets/pgbouncer/userlist.txt).
- [CONV] env vs ini (TRD s7.2): ini wins; the edoburu entrypoint skips env generation when the ini and userlist exist.
- [CONV] lims_api auth via `auth_user = pgbouncer` + `auth_query` (upstream get_auth); auth_file = /etc/pgbouncer/userlist.txt holds only the pgbouncer role's credential.
- LD-45: ini has no host names; data-1/prod-1/dev-1 render the same bytes.
- Checks: `T-07-verify.cmd` 24/24 OK. Full static suite: 8 fail + 2 errors in T-01/T-02/T-09/T-20/T-21 (gitleaks/yamllint/env/promtool). Not caused by T-07: they hit the existing lines/files too. Live test (LIMS_T07_LIVE=1) was not run because there is no docker here.
- OPEN: secrets_render (T-02/T-03 owner) has to render `/run/lims/secrets/pgbouncer/userlist.txt` (`"pgbouncer" "<SCRAM or POSTGRES_PASSWORD>"`). The schema has no entry for it yet, so this may need a CR.
- OPEN: upstream env (`DB_PASSWORD=${POSTGRES_PASSWORD}`) stays in the pgbouncer container. It is unused once the ini is mounted. It could be `!reset` once the live test proves the entrypoint works without it.
- OPEN: the ini is rendered next to the .j2 at deploy (same pattern as pg_hba.conf). AC-07.2 API URLs belong to T-14.
