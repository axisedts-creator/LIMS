# Restore drill (02-TRD s9.6, 03-APP-FLOW s4, AC-13.1..13.3)

Run by `infra/ansible/playbooks/restore-drill.yml` on group `ops` (LD-45: the host comes from the
inventory profile). Timer `lims-restore-drill.timer`: first Saturday 02:00 NPT; `TimeoutStartSec=3h`.

| File | Step |
|---|---|
| `restore.sh` | 2: PITR of repo2 to now − `drill_target_offset_min` (30), start, measured RTO |
| `verify.sql` | 3: recovery ended, audit recency (45 min), per-tenant counts, amcheck top 20 |
| `objects_sample.sh` | 4: 200 random Storage objects, sha256 source vs replica |
| `report.sh` | 5: textfile metrics, Markdown report in `infra/runbooks/drill-log/`, PR |

## Restore options (pgBackRest 2.60)

Used by the drill: `pgbackrest --stanza=lims --repo=2 --type=time --target="<YYYY-MM-DD HH:MM:SS+00>"
--target-action=promote restore`. The dr standby (s9.5) uses `--type=standby`. Status: these option
names are taken from the pgBackRest restore command reference; they have **not yet been run against
the 2.60.0 binary of the derived image** in this repository (no host here). The first staging drill
(AC-13.3) confirms them; record the run date and pgBackRest version below when it passes.

- Confirmed on staging: _pending (first staging drill)_

## amcheck

Availability in the derived image is probed at run time by `verify.sql` (`pg_available_extensions()`):
when available, `bt_index_check` runs on the 20 largest btree indexes; when not available the check is
skipped and reported as `amcheck_top20 SKIP` in the drill log. Whether the supabase/postgres image ships
it is not yet observed: record it here after the first staging drill.

## Inventory values the drill needs

`drill_db_image_digest` (sha256 of `lims/postgres-pgbackrest`), `pgbackrest_repo2_sftp_host_fingerprint`,
`secrets_render_enc_file`; where Storage or the replica is not local to the `ops` host:
`drill_objects_src_ssh` / `drill_objects_replica_ssh` (ssh command prefix, remote login shell bash).
`drill_billing_dry_run_argv` stays empty (check `SKIP`) until C0 publishes the `export-tenant-billing.ts` CLI.
