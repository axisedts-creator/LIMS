# Patching runbook (`patching`)

Owner C1. Procedure for 02-TRD s13 (04 I9; REQ-SEC-129/138; AC-16.1, AC-16.2). One playbook, `infra/ansible/playbooks/patch.yml`, one environment per run. Host names come from the active inventory profile (LD-45: `lean` = `prod-1` + `backup-1`, `full` = four hosts); the plays use group names only.
Evidence per host: `lims_ops_last_patch_timestamp_seconds` (written by `infra/monitoring/textfile/patch_metrics.sh` from `/var/lib/lims/patch/last_patch_timestamp`). `PatchOverdue` (warn, see `host.md#patchoverdue`) fires when a host is over 35 days without a patch.
Base images and container digests are bumped by `deploy.yml` (deploy.md), not by `patch.yml`. Supabase snapshot upgrades are a separate change with their own staging soak.

## Monthly window
Second Saturday, 22:00-02:00 NPT (outside lab peak). Order: dev (Wed) -> staging (Thu, 24 h soak) -> prod (Sat). Each run is one environment; the previous run's time is the evidence for the next.

1. Dev: `cd infra/ansible && ansible-playbook -i inventories/dev/hosts.yml playbooks/patch.yml`
2. Note the epoch time of the dev run: `ssh <dev-host> cat /var/lib/lims/patch/last_patch_timestamp`.
3. Staging (Thu): `ansible-playbook -i inventories/staging/hosts.yml playbooks/patch.yml -e patch_previous_done_at=<dev epoch>`. Run the staging smoke tests (C1 deploy smoke) and note the staging epoch the same way.
4. Prod (Sat, in the window): `ansible-playbook -i inventories/prod/hosts.yml playbooks/patch.yml -e patch_previous_done_at=<staging epoch>`. In the `lean` profile use the `-lean` inventories.
5. The guards run first and stop the run when the environment is unknown, the evidence is missing, in the future, or (prod) less than 24 h old.
6. After the run, hosts hold a new stamp; check Prometheus: `time() - lims_ops_last_patch_timestamp_seconds` is small for every host. Add a row to the patch log. A host over 35 days without a stamp raises `PatchOverdue`.

If any host fails, the run stops (one host at a time). Fix the cause, then re-run the same command; the upgrade is idempotent. Never edit the stamp by hand.

## Emergency patch
Trigger: a critical CVE, CVSS 9.0 or higher or actively exploited, triaged by the C1 on-call (AC-16.2). Target: fixed in prod within 72 h of triage.

1. On-call records the CVE and triage decision in the triage file and opens the patch log row (below).
2. Patch dev, then staging as in the monthly window; the staging smoke test is kept.
3. Prod: `ansible-playbook -i inventories/prod/hosts.yml playbooks/patch.yml -e patch_emergency=true -e patch_previous_done_at=<staging epoch>`. `patch_emergency` skips the 24 h soak guard only. The evidence is still required, and the hosts are still upgraded and stamped.
4. Announce any reboot on the status page (see `kernel-reboots`).
5. Fill the patch log row with the time prod was fixed and open a pull request.

## Kernel reboots
`patch.yml` reboots a host only when `/var/run/reboot-required` exists after the upgrade. Rebooted hosts need their LUKS volumes unlocked (see `host.md#luks-unlock-at-boot`).
- Database host: reboot only while the standby is healthy (`full` profile). In `lean` there is no standby; announce the short outage and confirm the latest WAL is archived to site B first (`backup.md`).
- App host: the reboot is a short outage. Announce it on the status page at least 48 h ahead for the monthly window; for an emergency announce as early as the 72 h target allows.
- After the reboot: `systemctl is-active` for the lims units, Grafana D1 shows no new alerts.

## Dry run
`ansible-playbook -i inventories/<env>/hosts.yml playbooks/patch.yml --check` (add `-e patch_previous_done_at=...` for staging and prod). A dry run runs the guards and reports what apt would change. It does not refresh the stamp or the metric, so a dry run never hides a `PatchOverdue`. Use it the day before each window.

## Patch log
Append one row per environment run and per emergency, via pull request. Emergency rows must show a prod time within 72 h of triage (AC-16.2).

| Date (NPT) | Env | Type | CVE / advisory | Triage by | Prod fixed at | Notes |
|---|---|---|---|---|---|---|
