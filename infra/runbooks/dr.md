# Disaster recovery runbook (`dr`)

Owner C1. Source: 03-APP-FLOW s11, 02-TRD s9.5/s11.3, 08 A25 D-210, LD-45. Playbook: `infra/ansible/playbooks/dr-promote.yml`. Time targets are [CONV]: RTO 1 h for a data host loss, 4 h for a site loss; RPO is the streaming lag at failure (seconds) and never above the 15 min archive guarantee.
Profiles (LD-45): `full` has a hot standby on the `dr` host; `lean` has none, so a data host loss there means a restore (see `lean-restore-onto-a-fresh-vm`). Read host names from the active inventory. Never paste a secret into a ticket, chat or ops log.

## Host loss data-1
Applies to `full`. Alerts: `TargetDown` for the data host plus `PostgresDown` (page).
1. Confirm the data host cannot be recovered within 30 min and tell the founder. Do not promote for a short outage.
2. Fence the old primary: power it off at the provider console. A promotion while it still answers is a split brain (two primaries). The playbook probes port 5432 of the old primary and refuses while it answers.
3. DESTRUCTIVE: from the ops host run `ansible-playbook -i inventories/<env>/hosts.yml playbooks/dr-promote.yml -e confirm_env=<env>`. `confirm_env` must equal the inventory env; a missing or different value refuses. `lean` refuses and names the restore section.
4. The playbook writes ops_audit notes (start, incident record, end with `rto_seconds=`), promotes, switches `db_primary_wg_ip` to the standby host, re-renders the `db_net` rule, recreates the DB consumers and smokes the API.
5. Afterwards commit the inventory changes: `db_primary_wg_ip` = the standby host's wg address, `standby_promoted: true` on group `dr` (so `site.yml` never touches it as a standby again). Update the status page.
**Escalate when:** the playbook fails twice, or the old primary cannot be fenced -> secondary on-call and founder.
**Close-out:** incident record kept open until switch-back; ops log line with the measured RTO.

## Promote standby
What `dr-promote.yml` does on the standby host, in order: guards (profile `full`, `confirm_env`, groups, split-brain probe), start note, `pg_promote` inside the standby container (a rerun is a no-op once promoted), wait until `pg_is_in_recovery()` is false, write the degraded-mode metric. Any failure writes an ops_audit note and ends the play with an error; fix the cause and rerun the whole playbook.
Check after: `psql -c "select pg_is_in_recovery()"` in the standby container returns `f`; `lims_ops_offsite_archive_configured` is `0` in the textfile directory of the promoted host.

## App reconnect
Same playbook, app hosts: `db_primary_wg_ip` becomes the promoted host, the `nftables` role re-renders the `db_net` DOCKER-USER rule, `secrets_render` re-renders the env files, then api-a, api-b, worker-a, worker-b (project `lims`) and auth, rest, storage (project `supabase`) are recreated with `--force-recreate --wait` and `DATA_WG_IP` set. A plain restart does not re-read the environment. The smoke retries `/v1/core/health/ready` on both API instances. The elapsed time since the start note is the measured RTO (target 1 h).
Needs the same release-lock variables as `site.yml` (`lims_runtime_images`, `secrets_render_enc_file`); the playbook stops before changing anything on the app hosts if they are missing.

## Degraded mode
From promotion until switch-back (or until a repo on another site exists): there is no second-site archive, and the audit store shares the primary's host (it was on the standby host before, so the separation is lost). RPO holds against loss of a host (with the interim repo), not against loss of site B. The playbook writes the incident record (ops_audit): "degraded, no second-site archive, audit store on the promoted primary's host". `NoOffsiteArchive` pages for the whole period. No third site is ordered here (B12 procurement item). Keep the incident record open and name the period in the post-incident review.

## Interim repo
Within 4 h of the promotion request the playbook creates a pgBackRest repo on the first ops host: a different host, but the same site as the promoted primary, so it is interim only and never counts as offsite. Steps: a new key pair and a passphrase of its own (aes-256-cbc, never the repo1 or repo2 passphrase), an SFTP-only account `lims-interim-repo` on the ops host (own group, admitted by `AllowGroups ops lims-interim-repo`, chrooted to `/srv/lims/interim-repo` by a `Match User` block; the repo is `/repo/repo-<stamp>` inside the chroot), `archive_mode` on (one short DB restart), `stanza-create`, then `check`. A failing step fails the play.
Where the passphrase lives: before it is written to the promoted host's tmpfs, the playbook escrows it from the control host with sops in the encrypted file `<env>.dr-interim.enc.yaml` (id `pgbackrest_interim_cipher_pass`, same age recipients as `<env>.enc.yaml`) in the lims-secrets repo, and commits it; that repo is backed up off the host with the ops volume (`secrets.md`). The plaintext exists only in memory and on the promoted host's tmpfs, never on the ops host, never in this repo. A rerun or a reboot of the promoted host reuses the escrowed passphrase.
Restore from the interim repo (promoted host lost): `sops -d --extract '["pgbackrest_interim_cipher_pass"]' <env>.dr-interim.enc.yaml` on the control host, render it into a tmpfs include as `repo1-cipher-pass` on the restore target, take the repo path from the ops_audit note "interim repo verified ... path=", then pgBackRest `restore` as in `lean-restore-onto-a-fresh-vm` step 2.
Repeat inside the window: `ansible-playbook ... dr-promote.yml -e confirm_env=<env> -e secrets_render_enc_file=<path to <env>.enc.yaml> --tags interim_repo -e dr_promote_started_epoch=<epoch from the start note>`. Each run creates a new repo path; the playbook deletes nothing, so remove old ones by hand after switch-back.
The playbook adds a runtime firewall rule on the ops host (ssh from the promoted host); a later `nftables` reload drops it, rerun the tag then.

## NoOffsiteArchive
Severity: page   Owner: C1   Last tested: never
**Means:** no pgBackRest repo with a passed `check` exists on a site other than the primary's (`lims_ops_offsite_archive_configured` is 0).  **Impact:** SEV2; a loss of the whole site loses data written since the last off-site copy.
**Check first:** `cat /var/lib/node_exporter/textfile/lims_ops_offsite_archive_configured.prom` on the primary's host; `pgbackrest --stanza=lims info`.
**Fix:** after a DR promotion this alert fires on purpose and stays firing: the interim repo is on the same site, so it does not clear it. It ends only when a repo at a site other than the promoted primary's site is configured and its `check` passed, normally after switch-back. Do not silence it for longer than the incident.
**Escalate when:** firing with no promotion in progress -> secondary on-call.
**Close-out:** ops log line with the date and the repo that cleared it.

## Site A loss
Whole primary site gone (app host and data host). Target RTO 4 h, RPO 15 min or less. Follow `dr-site-failover` below. Confirm with the founder before DNS moves; the provider console decides whether site A is really gone or only unreachable.

## DR site failover
1. Declare the incident (SEV1) and name an incident commander; write the time in ops_audit.
2. Provision the app VM at site B (or start the pre-provisioned cold VM if B12 allows) and run `site.yml` with the site B inventory (`prod-siteB`). Container images come from the registry mirror on the DR side; if the ops registry is gone, load them from the mirror, never from an unverified source.
3. Promote the standby with `dr-promote.yml` (guards apply; the old site must be fenced) or restore from repo2 when no standby exists.
4. Restore Storage: mount the object replica volume as `/srv/lims/storage`.
5. Move the DNS records of the origins to site B's public IP (DNS provider is a B12 item; TTL 300 s was set in advance). Issue certificates with ACME at site B.
6. Smoke the API and a signed-in staff flow; update the status page.
Time budget: RTO 4 h from the declaration; RPO 15 min or less. Record each step time for the game day.

## Lean restore onto a fresh VM
Profile `lean` (LD-45) has no hot standby: `dr-promote.yml` refuses. DR is a restore onto a fresh VM from the backup host at site B (pgBackRest repo2, WAL archived continuously, RPO 15 min or less). Target RTO 4 h, rehearsed every month by the restore drill (`drill.md`).
1. Provision the fresh VM at the provider of choice; run `site.yml` with the lean inventory so the host has the base, Docker and wireguard roles.
2. Restore the database from repo2 (backup host over wg0; passphrase from the secrets store, `secrets.md`) to the latest WAL; pgBackRest `restore` as the `postgres` user, then start Postgres and wait for the end of recovery.
3. Restore objects from the encrypted object replica and the audit digests from the backup host; start the stack and smoke the API.
4. Change the inventory (new host address) and update DNS (TTL 300 s).
The measured restore time of the last drill is the input to this RTO; above 3 h is a warning (`drill.md`).

## Switch-back
Planned, in a maintenance window, after the cause is fixed. The promoted host archives to the interim repo only; repo2 receives nothing until switch-back (LD-106, CR-C1-T29b option (a); 02-TRD s9: repo2's host never holds a cipher pass), so the new standby is seeded only from the interim repo. 1. Take a fresh full backup of the promoted primary into the interim repo (`pgbackrest backup --type=full` with the interim config) and `check` it. 2. Rebuild the lost host and seed it as the new standby from that fresh backup in the interim repo (or by a base backup streamed from the promoted primary; `site.yml`, role `standby`; empty data directory first). 3. Wait for replication lag near zero. 4. In the window: promote the rebuilt host (or run the planned switch), set `db_primary_wg_ip` back, recreate the consumers as in `app-reconnect`. 5. Confirm the normal backup roles archive from the primary again (repo1 local, the second-site repo by the backup role) and `lims_ops_offsite_archive_configured` becomes 1 only through the normal backup metrics; then close the incident record. 6. Remove the interim repo by hand once the second-site repo has a full backup of the switched-back primary.

## Game day
Semi-annual (every 6 months); a tabletop for the site failover alongside. Run in staging with the `full` profile; synthetic data only.
1. Script: in staging stop only the Postgres container of the site-A VM (port 5432 closed, the split-brain probe passes; staging runs `data-1`+`app-1` on one VM, 02-TRD s3.1); in prod fence the data host; then run `dr-promote.yml -e confirm_env=staging` and note the start epoch.
2. Measure: RTO (start note to the API smoke; target 1 h), time until the interim repo `check` passed (target 4 h).
3. Verify `NoOffsiteArchive` fired and stays firing after the interim repo exists (still firing at the end of the run); record the time it fired.
4. Write the record `infra/runbooks/gameday-log/<YYYY-MM-DD>-dr-promotion.md` with the keys of the tabletop record template: Date, Environment, Scenario, Participants, Promotion started, Application reconnected, RTO measured, RTO target, Interim repo check, Interim repo host, NoOffsiteArchive fired, NoOffsiteArchive still firing at, Actions, Next game day. In staging the interim repo shares the promoted VM (site B runs `dr-1`+`ops-1` on one VM), so the record says so; AC-22.3's "different host" is proven only where `groups['ops'][0] != groups['dr'][0]` (prod `full`).
5. Site failover tabletop: desk walk-through, record in `infra/runbooks/tabletop-log/<YYYY-MM-DD>-site-failover.md`.
6. Rebuild the staging standby afterwards (switch-back steps).
