# Third-party ops tools register

Every tool C1 runs, from 02-TRD §2, with version, licence, host and network reach.
This file is the register required by **CR-C1-007** (accepted, CV §15.2 ops-tools row).

Conditions for every GPL / AGPL / MPL tool below (CR-C1-007):

1. **Unmodified**: the official upstream release or OS package, never patched or forked by us.
2. **Separate process**: runs as its own program or container. It is never linked into, bundled with or distributed with product code.
3. **Ops network only**: reachable over the WireGuard ops network (`wg0`) or the host itself, never by tenant users. AGPL Grafana is never exposed to tenant users. The exceptions are nginx and certbot, which are permissive tools on the public edge. fail2ban and nftables have no listener at all.
4. **Registered here**: a tool that is not in this table must not be deployed.

Versions are the 02-TRD §2 values. "C1 pins" means the exact version is fixed when the owning task pins it, in `ansible/requirements.yml`, `compose/supabase/upstream/UPSTREAM.lock` or `releases/<env>.lock.yaml`. This table is updated in the same change.

| Name | Version | Licence | Host | Reachable from |
|---|---|---|---|---|
| Ubuntu Server (OS) | 24.04 LTS | various (distribution) | all VMs | n/a (OS) |
| Docker Engine + Compose v2 | C1 pins (Compose with `!reset` support) | Apache-2.0 | all VMs | local socket only (root) |
| Supabase self-hosted snapshot (gateway, auth, rest, storage, imgproxy, meta, studio, realtime) | per `UPSTREAM.lock` (02-TRD §2 tags) | Apache-2.0 / MIT / PostgreSQL | app-1, data-1 | app-1 docker networks; studio/meta 127.0.0.1 break-glass only |
| PostgreSQL (supabase/postgres + pgBackRest image) | 17 (`supabase/postgres:17.6.1.136`) | PostgreSQL | data-1, dr-1 (standby, audit store) | app-1 `db_net` via wg0 (5432/6432), dr-1 replication over wg0 |
| PgBouncer | 1.25.2 (`edoburu/pgbouncer:v1.25.2-p0`) | ISC | data-1 | app-1 `db_net` via wg0 (6432) |
| pgBackRest | 2.60.0 | MIT | data-1, dr-1 (repo2) | wg0 only (SFTP to dr-1) |
| nginx (edge + ops nginx) | 1.30.x, C1 pins patch | BSD-2-Clause | app-1 (edge), ops-1 (ops nginx) | edge: internet 80/443; ops nginx: wg0 only |
| certbot (ACME client) | C1 pins (distribution package) | Apache-2.0 | app-1 | outbound to ACME CA only |
| fail2ban | 1.1.1 | GPL-2.0+ | app-1 | no listener (reads logs, writes nftables sets) |
| WireGuard (kernel module + wireguard-tools) | OS package | GPL-2.0 | all VMs | peer IPs only (UDP), hub on ops-1 |
| nftables | OS package | GPL-2.0 | all VMs | no listener (host firewall) |
| chrony | OS package | GPL-2.0 | all VMs (server on ops-1) | wg0 only (NTP from ops-1) |
| Ansible (ansible-core) | 2.22.0 | GPL-3.0 | ops-1 (controller) | no listener (SSH out over wg0) |
| SOPS | 3.13.3 | MPL-2.0 | ops-1 | no listener (CLI) |
| age | 1.3.2 | BSD-3-Clause | ops-1 | no listener (CLI) |
| Prometheus | 3.16.0 | Apache-2.0 | ops-1 | wg0 only, via ops nginx |
| Alertmanager | 0.34.2 | Apache-2.0 | ops-1 | wg0 only, via ops nginx |
| Grafana OSS | 13.3.0 | AGPL-3.0 | ops-1 | ops network (wg0) only, via ops nginx basic-auth; never tenant users |
| VictoriaLogs | 1.53.0 | Apache-2.0 | ops-1 | wg0 only (Fluent Bit ingest, ops nginx) |
| Fluent Bit | 5.1.5 | Apache-2.0 | all VMs | no listener (ships to VictoriaLogs over wg0) |
| node_exporter | v1.12.1 | Apache-2.0 | all VMs | wg0 only (Prometheus scrape) |
| postgres_exporter | v0.20.1 | Apache-2.0 | data-1, dr-1 | wg0 only (Prometheus scrape) |
| pgbouncer_exporter | v0.12.1 | Apache-2.0 | data-1 | wg0 only (Prometheus scrape) |
| blackbox_exporter | v0.29.1 | Apache-2.0 | ops-1 | wg0 only (Prometheus scrape) |
| nginx-prometheus-exporter | v1.5.3 | Apache-2.0 | app-1 | wg0 only (Prometheus scrape) |
| cAdvisor | v0.60.6 | Apache-2.0 (C1 re-checks at pin) | all VMs running containers | wg0 only (Prometheus scrape) |
| Valkey | 9.1.3 | BSD-3-Clause | app-1 | app-1 `app_net` only |
| ClamAV (clamd) | 1.5.4 | GPL-2.0 | app-1 | app-1 `app_net` only |
| Squid (egress proxy + ops proxy) | C1 pins | GPL-2.0 | app-1 (worker egress), ops-1 (ops proxy) | app-1 `app_net` / ops-1 wg0 only; out to the FQDN allowlist |
| Container registry (CNCF Distribution) | v3.1.2, C1 pins | Apache-2.0 | ops-1 | wg0 only (`registry.lims.internal:5000`) |
| testssl.sh | 3.2.5 | GPL-2.0 | ops-1 (test runner) | no listener (CLI) |
| gitleaks | as pinned by C0 (C0 02-TRD §2) | MIT | ops-1 CI runner | no listener (CLI) |
| trivy | as pinned by C0 (C0 02-TRD §2) | Apache-2.0 | ops-1 CI runner | no listener (CLI) |
| Load generator for AC-24.1 (k6-class) | C1 pins | must be on CV §15.2 allowlist | staging only | no listener (CLI) |
| Python 3 (stdlib only) | OS package | PSF | all VMs | no listener (infra test scripts) |
| Authenticode signing tool (Linux) | C1 pins in T-34 | to be recorded in T-34 | ops-1 (release service only) | no listener (CLI) |

Not run by C1: qpdf (inside C6's `pdf-sandbox` image; C6 pins and builds it, 08 A25 D-204).
