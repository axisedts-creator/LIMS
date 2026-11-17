# Topology profiles (LD-45, LD-48)

**Default for prod: `lean` = `inventories/prod-lean/`.** `full` = `inventories/prod/` (4-host topology of 02-TRD §3.1, kept as written). Staging: `staging-lean/` (one optional VM, spun up before releases) or `staging/` (full, 2 VMs). Dev: `dev/` (one VM). The profile is the inventory var `topology_profile` (`lean` | `full`) in `group_vars/all.yml`.

## lean

- `prod-1`, site A (16 vCPU / 32 GB / ~640 GB NVMe): groups `data`, `app`, `ops` (every data-1 + app-1 + ops-1 role).
- `backup-1`, site B, **different provider** (4 vCPU / 8 GB / ≥ 160 GB, growable): group `backup` only. Runs pgBackRest repo2 (SFTP target, continuous WAL archiving, RPO ≤ 15 min unchanged), the encrypted object-storage replica, the nightly audit digests and ops_audit copy, and the external blackbox/uptime check + alert relay, so a prod-1 outage still pages.
- No hot standby: group `dr` is empty. DR = restore onto a fresh VM from backup-1, target RTO ≤ 4 h, rehearsed in the monthly restore drill (04 I3).
- Audit store = separate database `lims_audit` in the same Postgres cluster, owned by a role the app cannot use; nightly hash digests shipped to backup-1.
- prod-1 memory budget: `mem_limit_gib` in `prod-lean/hosts.yml`; Σ ≤ 85 % of 32 GiB = 27.2 GiB.

## Scale triggers: move prod to `full`

Any one of:

- sustained CPU > 60 % or RAM > 80 % at peak for 7 days;
- database > 150 GB;
- a second lab group signs.

Never weaken encryption, WAL archiving to site B, or the restore drill to save cost.

Roles read host placement from the inventory groups; no role hard-codes a host name (LD-48).
