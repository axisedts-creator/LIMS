# Host runbook (`host`)

Owner C1. One section per alert in `monitoring/rules/host.rules.yml` plus `TargetDown` (from `ops.rules.yml`), and the LUKS procedure (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Host names and counts come from the active inventory profile (LD-45): `lean` = `prod-1` (site A) and `backup-1` (site B); `full` = the four-host topology. Do not assume a host exists; read the inventory.

## TargetDown
Severity: page   Owner: C1   Last tested: never
Severity is `page` for prod hosts (names starting `data-`, `app-` or `prod-`) and `warn` otherwise.
**Means:** Prometheus cannot scrape a target for 2 min.  **Impact:** that service or host may be down, or only its exporter.
**Check first:** Grafana D1 firing alerts table (`job`, `host`, `instance` labels); `ssh <host> systemctl is-active <service>`; `curl -s http://<instance>/metrics | head -3` over wg0.
**Fix:** 1. Host unreachable: check the provider console; if the host is rebooting for patching, wait; if it needs a LUKS unlock, see `LUKS unlock at boot`. 2. Host up, one service down: `systemctl restart <service>` or `docker restart <name>`; read the log first. 3. Exporter only: restart the exporter; the service itself may be healthy. 4. For `job` `victorialogs` see `monitoring.md#victorialogs-down`; for `prometheus`, `monitoring.md#prometheus-down`.
**Escalate when:** a prod host target is down over 10 min -> secondary on-call; every target of site A -> `SiteADown`.
**Close-out:** ops log line with target, cause, action.

## DiskFillForecast
Severity: page   Owner: C1   Last tested: never
**Means:** a filesystem is forecast to fill within 24 h (linear fit over 6 h).  **Impact:** a full disk stops PostgreSQL, logs or uploads.
**Check first:** `df -h` and `du -xh --max-depth=1 <mountpoint> | sort -h | tail` (find the grower); Grafana D14 (Hosts) disk panel.
**Fix:** 1. Typical growers: Docker images/logs (`docker system df`), VictoriaLogs retention, PostgreSQL WAL (`db.md#replicationslotwalretained`), old backups. 2. Free space with the safe options first: `docker image prune` for dangling images, `journalctl --vacuum-time=7d`. 3. DESTRUCTIVE: never delete files from `pg_wal`, a pgBackRest repo, the object-storage volume or the audit store by hand. 4. If the data is legitimate, grow the volume (LVM `lvextend -r`) and record it.
**Escalate when:** forecast under 6 h, or free space under 10 % -> secondary on-call.
**Close-out:** ops log line with mountpoint, grower, action and new size.

## StorageVolumeForecastFull
Severity: warn   Owner: C1   Last tested: never
**Means:** the object storage volume (`/srv/lims/storage`) is forecast to fill within 90 days.  **Impact:** none yet; uploads fail once it is full.
**Check first:** `lvs` and `df -h /srv/lims/storage`; the trend on Grafana D9 (Capacity).
**Fix:** 1. Grow the logical volume and filesystem online: `lvextend -r -L +<size> <vg>/<lv>` (check free space in the volume group first; if none, grow the provider disk). 2. Confirm `df -h` and the alert clearing. 3. The site-B replica also needs space: check `backup.md#objectreplicastale` expectations and grow the replica volume too.
**Escalate when:** under 30 days remain and no capacity can be added -> founder (cost decision; LD-45 scale triggers).
**Close-out:** ops log line with old and new size.

## ClockSkew
Severity: warn   Owner: C1   Last tested: never
**Means:** the clock offset exceeds 0.5 s for 5 min.  **Impact:** token expiry, audit timestamps and TLS checks can misbehave.
**Check first:** `chronyc tracking` and `chronyc sources -v` (expect offset under 50 ms and a selected source).
**Fix:** 1. `systemctl restart chrony`. 2. If no source is reachable, check the NTP allow rules in nftables and the internal time source. 3. Re-run the `chrony` role if the config drifted.
**Escalate when:** offset over 5 s -> secondary on-call; audit timestamps in that window are recorded in the ops log.
**Close-out:** ops log line with the offset peak and cause.

## HostMemoryPressure
Severity: warn   Owner: C1   Last tested: never
**Means:** available memory is below 10 % for 10 min.  **Impact:** the kernel may OOM-kill a container, often PostgreSQL or a worker.
**Check first:** `free -m`, `docker stats --no-stream` (compare with each `mem_limit`), `dmesg -T | grep -i oom`.
**Fix:** 1. Find the grower; restart a leaking container. 2. Check that the container memory limits sum to under 85 % of RAM (LD-45 lean budget: 27.2 GiB of 32 GiB). 3. Do not add swap to hide a leak on the DB host.
**Escalate when:** an OOM kill of PostgreSQL happened, or pressure is sustained at peak -> the LD-45 scale trigger "RAM above 80 % at peak for 7 days" -> founder.
**Close-out:** ops log line with the culprit and action.

## PatchOverdue
Severity: warn   Owner: C1   Last tested: never
**Means:** a host has not been patched for more than 35 days (04 I9).  **Impact:** known vulnerabilities may remain.
**Check first:** read the patch log table in `patching.md` and the last-patch panel on Grafana D14 (Hosts).
**Fix:** 1. Follow the monthly patch procedure in `patching.md`. 2. If a patch window is blocked, record the reason and the new date.
**Escalate when:** over 45 days -> founder.
**Close-out:** patch log entry (in `patching.md`) and an ops log line.

## ConfigDrift
Severity: warn   Owner: C1   Last tested: never
**Means:** a host differs from the playbook (`lims_ops_config_drift_changes` above 0 for 5 min).  **Impact:** hand edits may be lost at the next run or hide a compromise.
**Check first:** `ansible-playbook playbooks/site.yml --limit <host> --check --diff` (the diff names the changed files).
**Fix:** 1. If the change was a deliberate hot-fix, move it into the repo through the owning task and re-run. 2. If nobody made it, treat it as suspicious: check `auth.log`, `SshLoginOutsideOps` history (`security.md#sshloginoutsideops`), and open `incident-response.md`. 3. Re-run the playbook to restore the intended state.
**Escalate when:** unexplained change on a security file (sshd, nftables, sudoers) -> founder, SEV1 review.
**Close-out:** ops log line with files, who changed them, decision.

## SiteADown
Severity: page   Owner: C1   Last tested: never
**Means:** every site A target (`data-`, `app-` or `prod-` hosts) is down for 5 min, seen from the external probe at site B.  **Impact:** SEV1; the lab cannot register or report.
**Check first:** the provider status page and console for site A; from site B `ping`/`mtr` the site A address; `LUKS unlock at boot` if the host rebooted.
**Fix:** 1. Power or network event at the provider: wait for the provider while informing the founder. 2. Host rebooted and waits for the disk key: unlock it (below). 3. If site A cannot return within the RTO budget, start the DR restore onto a fresh VM from site B (`dr.md`; target RTO 4 h, LD-45) after the founder agrees.
**Escalate when:** always -> founder immediately; start `incident-response.md` for SEV1.
**Close-out:** incident record with start/end, cause, whether DR was used, and data-loss assessment (RPO 15 min).

## LUKS unlock at boot
Procedure (PLAN R11). Encrypted volumes need a key after a reboot.
1. Check state: `lsblk -f` and `systemctl list-units 'systemd-cryptsetup@*'`; services that depend on the volume stay stopped.
2. Normal path: the key is supplied automatically by the unlock mechanism of the `luks_volumes` role. If that fails, use the provider's console (out-of-band access) to enter the passphrase; there is no remote shell before the unlock.
3. The passphrase is in the sealed secrets store (`secrets.md`); two people are needed if the break-glass copy is used. Never write it in tickets or chat.
4. After unlock: `systemctl start postgresql` and the Docker stack come up in order; confirm `TargetDown` clears.
5. Record the reboot and unlock with `infra/ci/ops-note.sh`.
