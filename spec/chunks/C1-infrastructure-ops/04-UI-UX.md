# C1 — Infrastructure & Operations — 04 UI/UX (operator experience)

Status: DRAFT for build, 2026-11-06. C1 has no product UI and uses no `packages/ui` components (CM §7: for non-UI chunks this document is the operator guide — runbook UX for C1). It specifies what operators see and type: commands, dashboards, alert messages, runbooks, on-call procedure, incident templates and the status page. Thresholds marked [CONV] are C1 choices; others cite 04/REQ.

---

## 1. Principles

1. **One entry point.** `infra/README.md` → "what do I do when…" table → runbook file + anchor. Every alert links to exactly one runbook anchor (`annotations.runbook_url`).
2. **Copy-paste safe.** Every runbook step is a command block with `<env>` placeholders and an expected output line; destructive steps are marked `DESTRUCTIVE` and require typing the env name to confirm (playbooks prompt `confirm_env`).
3. **No PHI on operator screens by default.** Dashboards show counts, ids (tenant/centre/agent UUIDs), durations. Row contents of the application DB or audit store are opened only through the audit-investigation runbook with founder approval (07-SECURITY §5).
4. **Nepal time for humans, UTC for machines.** Dashboards default to `Asia/Kathmandu`; logs and metrics store UTC (04 D12).
5. **Reachable only over WireGuard.** No operator UI is on a public address (02-TRD §3.3).

## 2. Access and roles

| Role [CONV] | Grafana | Alertmanager UI | VictoriaLogs UI | SSH/sudo | Ansible prod | Decrypt prod secrets |
|---|---|---|---|---|---|---|
| `ops_admin` | Admin | yes | yes | yes | yes (with approval for deploy) | via deploy service only |
| `ops_oncall` | Editor on "On-call" folder, Viewer elsewhere | yes (silence) | yes | yes (no sudo on data-1 except runbook commands via `sudo -l` allowlist) | runbook playbooks only (`dr-promote`, `studio-breakglass`, `verify`) | no |
| `ops_readonly` | Viewer (not Logs, not Security folders) | no | no | no | no | no |
| Founder | Admin | yes | yes | yes | approver | yes (holds key) |

Onboarding: add WireGuard peer (`inventories/<env>/group_vars/all.yml` → `wg_peers`), Linux account in `ops` group, Grafana user, basic-auth entry — all via `site.yml`. Offboarding within 1 business day (REQ-SEC-140): remove peer, account, Grafana user; rotate any secret the person could decrypt (§4 runbook `secrets.md#offboarding`).

## 3. Dashboards (Grafana, provisioned from `infra/monitoring/grafana/dashboards/`)

| # | Folder / Dashboard | Panels (minimum) | Primary users |
|---|---|---|---|
| D1 | On-call / **Platform overview** | traffic-light per component (edge, web, api, worker, DB, PgBouncer, Storage, renderer, pdf-sandbox, scanner, Valkey, backups, off-site archive, audit shipping, monitoring itself); firing alerts table; last deploy (version, time); RPO gauge (`lims_ops_wal_repo2_newest_age_seconds`, warn band at 600 s, page line at 840 s — 08 A25 D-205); last drill age vs 35 d; `NoOffsiteArchive` banner when firing (D-210) | on-call |
| D2 | On-call / **Edge** | req/s by origin; status codes; 429 by zone (login, otp, psession, qrverify, agent, callback, payments, perip); 404s by origin and `lims_ops_edge_not_found_max_per_ip_5m`; p50/p95 upstream time; active connections; fail2ban bans/h; TLS days-to-expiry per origin; Squid egress denied by `dest_class` | on-call |
| D3 | Services / **API** | `lims_http_requests_total` by module/operation/status; p95 `lims_http_request_duration_seconds` per module; `lims_rls_denied_total`; `lims_core_auth_failures_total{reason}`; `lims_ratelimit_rejections_total{tier}`; replicas up | ops, chunk owners |
| D4 | Services / **Worker & queue** | `lims_queue_depth{task}`; `lims_jobs_total{task,outcome}`; `lims_job_duration_seconds`; `lims_core_dead_letters_total`; fan-out lag p95; worker restarts | ops |
| D5 | Data / **PostgreSQL** | connections vs max; tx/s; cache hit; locks/deadlocks; longest tx; replication lag (standby, audit slot); WAL rate; DB size; invalid indexes | ops |
| D6 | Data / **PgBouncer** | cl_active/cl_waiting; sv_active/idle; avg wait; pools | ops |
| D7 | Data / **Backups & DR** | per repo last success, duration, size; `check` result history; WAL newest age repo2; restore drill: last success, measured RTO trend, checks failed; object replica lag; standby lag | ops, founder |
| D8 | Data / **Audit shipping** | lag; subscription state; rows/min by table; digest status last 7 days | ops |
| D9 | Capacity (REQ-ARCH-009) | DB size growth; Storage bytes + object count + bytes/object (measures the UNVERIFIED 150 KB/PDF — 04 §14); `predict_linear` days-to-full per volume; IOPS; CPU/mem per container; queue depth; renderer duration p95 | ops, founder |
| D10 | Services / **Renderer & PDF sandbox** | container health (`lims_ops_container_health`), restarts, memory vs limit (renderer 1.5 GiB, sandbox 512 MiB) from cAdvisor; C6's reporting metrics from the worker (`lims_reporting_render_failures_total`, `lims_reporting_sandbox_rejections_total`); renderer-internal counters (`lims_renderer_*`) re-exported by the worker (02-TRD §11.1, 08 A27.3) | ops, C6 |
| D11 | Services / **Scanner** | scans/min, FOUND count, signature age | ops |
| D12 | Instruments / **Bridge agent fleet** (X6) | table tenant/centre/agent → state, last heartbeat age, queue depth, clock offset, silent instruments, version; counts by state; update failures / config rejections / device-auth failures (C7 counters); latest published release; panel note "No data until C7 metrics are live (flag `c7_metrics_live`); series come from worker-a/b" | ops, C7 |
| D13 | Security (restricted) | login failures (C2 `lims_identity_logins_total`), per-IP failure throttles active (C2, 08 Addendum A1), credential-stuffing signal, RLS denied spikes, exports, support sessions, Studio enabled, SSH logins, sudo, secret decrypts, egress denied | ops_admin, founder |
| D14 | Hosts | node_exporter per host: CPU, memory, disk, network, clock offset, last patch | ops |
| D15 | Modules / one per chunk (Identity, Catalog, Front desk & Billing, Lab, Reporting, …) | panels listed in each chunk's TRD observability section, added through the alert/dashboard intake (§6) | chunk owners |

Panel rules: every panel has a description stating metric source and owning chunk; no panel queries the application DB directly; tenant filter variable `tenant_id` exists only on dashboards whose metrics carry that label.

## 4. Runbooks (`infra/runbooks/`)

### 4.1 Catalogue

| File | Covers (anchors = alert names or procedures) |
|---|---|
| `README.md` | "what do I do when…" index; severity matrix (§5.1); contacts placeholder |
| `oncall.md` | rota, acknowledge, escalate, handover (§5.2) |
| `edge.md` | `TLSCertExpiring*`, `Edge5xxRate`, `RateLimitSpike`, `ForbiddenPortOpen`, `Fail2banBanSpike`, `LimsAuthJailBan`, `EdgeNotFoundSpike` (find the IP in VictoriaLogs; never ban a tenant lab's NAT for 404s — 08 A25 D-211), `EgressDenied`, manual ban/unban, disabling one public route, `edge-routes-drift` CI failure |
| `ddos.md` | posture and steps without a foreign CDN (§4.3) |
| `db.md` | `PostgresDown`, connections, locks, long tx, `PgBouncerWaiting`, `PostgresInvalidIndex`, `ReplicationSlotWalRetained` |
| `backup.md` | `WalArchiveLagging`, `RpoAtRisk`, `WalArchiveFailing`, `NoOffsiteArchive`, `BackupMissed`, forcing a full backup, `repo1-full`, repo2 full |
| `drill.md` | running/reading the monthly drill; `RestoreDrillOverdue`, `RestoreDrillFailed`; drill log |
| `dr.md` | §11 of 03-APP-FLOW: DB host loss (`dr-promote.yml` incl. the interim ops-1 repo within 4 h and the degraded-mode incident record — 08 A25 D-210), site A loss, Storage loss, switch-back, game-day script |
| `audit.md` | `AuditShipping*`, `AuditDigestMismatch`, backfill, investigation access |
| `runtime.md` | `WorkerDown`, `QueueBacklog`, dead letters (hand-off to C2 console), renderer, pdf-sandbox (C6 health), scanner, `ValkeyDown` (page: logins/OTP fail closed — restart Valkey, no state to restore), `DeployRolledBack` cross-link |
| `instruments.md` | `BridgeAgent*`: contact lab, check C7 fleet page, LAN checklist (REQ-SEC-120/122); imported C7 rules `Instruments*` (runbook text from C7); agent release run (`agent-release.sh`, CR-C7-012) |
| `hosts.md` | disk, memory, `ClockSkew`, LUKS unlock at boot, `ConfigDrift` |
| `patching.md` | monthly + emergency procedure; patch log table |
| `secrets.md` | rotation per secret id; JWT/Storage signing keys; BFF keys (overlap: old + new in `LIMS_CORE_BFF_KEY_FILES`); `payments-kek` (add → set active → `payments.rewrap_credentials` → remove old — CR-C15-008); C7 config-signing key; offboarding; suspected exposure |
| `deploy.md` | release, approval, rollback, `DeployRolledBack`, stuck env lock |
| `studio.md` | break-glass |
| `monitoring.md` | Prometheus/Alertmanager/VictoriaLogs down, `Watchdog` missing, `MetricCardinalityHigh` |
| `incident-response.md` | §5 of this document, Privacy Act decision record |
| `ird-access.md` | placeholder: IRD server access (04 L4) — BLOCKED B6 |
| `<module>.md` | one per imported rule file (C3–C17), anchors = alert names; text from the owner's TRD (02-TRD §11.3) |

### 4.2 Runbook entry template (every anchor)

```markdown
## <AlertName or Procedure>
Severity: page|warn|info   Owner: C1 (or Cxx for imported rules)   Last tested: YYYY-MM-DD
**Means:** one sentence.  **Impact:** who notices what.
**Check first:** 1–3 commands with expected output.
**Fix:** numbered steps (commands). DESTRUCTIVE steps marked.
**Escalate when:** condition → whom.
**Close-out:** what to record (ops_audit / incident).
```

### 4.2a `edge.md#LimsAuthJailBan` (08 Addendum A3.2)
Severity: page (receiver `oncall-email`, `notify_tenant=false`)   Owner: C1
**Means:** one IP produced ≥ 300 nginx `limit_req` rejections in the `login` zone within 10 min and fail2ban `lims-auth` banned it for 15 min. Failed passwords (401) never cause this ban; they are handled by C2's per-IP failure throttle.
**Impact:** every user behind that IP (possibly a whole lab on shared NAT) cannot reach the public origins for 15 min.
**Check first:** `fail2ban-client status lims-auth` on app-1 (banned IP listed); VictoriaLogs query on `access.json` for that `remote_addr`, `limit_req_status=REJECTED`, last 15 min, grouped by `route`; D13 per-IP failure throttles active (C2).
**Fix:** 1. If the IP belongs to a known tenant lab (tenant ops contact or the lab reports an outage) and the traffic is a misbehaving client, not an attack: `fail2ban-client set lims-auth unbanip <ip>` (`edge.md#manual-ban`), record in `ops_audit`, contact the lab. 2. Otherwise let the ban expire; if the flood resumes, follow `ddos.md`.
**Escalate when:** repeated bans of the same IP within 1 h, or bans from many IPs at once → secondary on-call (possible distributed attack, `ddos.md`).
**Close-out:** ops log line with IP class (tenant lab / unknown), ban duration, action taken.

### 4.3 DDoS posture without a foreign CDN (04 I7; REQ-SEC-135) — `ddos.md`
1. Recognise: `RateLimitSpike`, D2 req/s ≫ baseline, `Edge5xxRate`, connection count near `worker_connections`.
2. Classify: application-layer (HTTP requests visible in access.json) vs volumetric (packet drops, link saturation on the provider graph; nginx sees little).
3. Application layer: identify top IPs/ASNs from VictoriaLogs (`route`, `remote_addr` counts); add to nftables ban set (`edge.md#manual-ban`); tighten `perip` zone temporarily (`group_vars` `edge_perip_rate`, redeploy edge only); if one route is targeted (e.g. `/v/`), lower its limit or temporarily return 503 for it (portal shows its error state).
4. Volumetric: contact the DC/ISP using `isp_mitigation_contact` (empty until B12; which Nepali ISP offers scrubbing is UNVERIFIED — 04 I7). Accept downtime above upstream capacity; post status page notice. **No foreign CDN/scrubber may be enabled without founder approval (04 §11, B11).**
5. After: incident record; review limits.

## 5. On-call and incident response

### 5.1 Severity matrix [CONV]
| SEV | Definition | Examples | Response |
|---|---|---|---|
| SEV1 | PHI confidentiality breach suspected, or total outage of registration/reporting for ≥ 1 tenant, or data loss beyond RPO | public DB port open; cross-tenant leak report; site A down | page immediately; founder informed ≤ 30 min; incident commander assigned |
| SEV2 | major degradation or security control failure without known disclosure | WAL archiving failing; audit shipping down; one service down with failover; TLS cert expiring < 7 d | page; ack ≤ 15 min |
| SEV3 | partial or single-tenant degradation | one bridge agent offline > 1 h; queue backlog | warn digest; next business hours |
| SEV4 | informational | Studio enabled; `EdgeNotFoundSpike` without other signals | dashboard / warn digest |

### 5.2 On-call procedure
- Rota: weekly, primary + secondary (≥ 2 engineers) [CONV]; staffing plan for 24/7 is an open item (research 03 §11 q9).
- On page: acknowledge by Alertmanager silence with comment `ack <name>` ≤ 15 min; open the runbook anchor; post a line in the ops log (`ops_audit` via `infra/ci/ops-note.sh "<text>"`).
- Escalation: no ack in 15 min → secondary; 30 min → founder (Alertmanager `repeat_interval`).
- Handover: Monday 10:00 NPT; open incidents, silences, pending patches reviewed.
- Paging channel: e-mail via the transactional relay (only pre-allowed foreign pattern); SMS paging only after founder approval (CR-C1-006).

### 5.3 Privacy assessment form (filled in state `assessed`, 03-APP-FLOW §12)
Fields: incident id; tenants affected (UUIDs); data classes affected (health/personal/none — REQ-SEC-004); record counts per class; actor type (external/insider/staff error/system); disclosure confirmed / possible / excluded; channel; containment time; evidence hashes; tenant is a public body? (s.25/s.27(1) apply directly only then — 04 L17); sections considered: s.12(4) (health-examination details disclosed without consent), s.26(1) (body corporate use/sharing), s.29 (offences, any person — staff personally liable), s.30 (complaint within three months), s.31 (compensation); decision on tenant notification; counsel consulted (name/date); Privacy Regulation 2077 obligations — **UNVERIFIED, counsel to confirm (B16)**.

### 5.4 Notification templates (no PHI in any template)
- **Tenant — security incident:** "Subject: Security notice for <lab name> — incident <id>. We detected <category> on <date, NPT>. Affected: <data classes, counts>. Actions taken: <containment>. What you should do: <steps>. Contact: <ops contact>. Details are available to your tenant admin in a meeting; we do not send patient data by e-mail."
- **Tenant — maintenance:** "Planned maintenance <date> <22:00–02:00 NPT>. Services affected: <list>. Expected impact: <minutes>."
- **Status page component states:** `operational`, `degraded`, `partial_outage`, `major_outage`, `maintenance`.
Patient notification is the tenant's decision and communication; the LIMS provider supplies facts and a draft on request.

## 6. Alert and dashboard intake (for every chunk; 05-DoD §3.7)

Chunks keep their alert rule file in their own path and list it in their TRD table "Alert rules for C1" (08 A13 P-14); one CR per chunk asks C1 to wire it, and `infra/ci/import-rules.sh` imports it (02-TRD §11.3). A chunk without a rule file files a CR of type `alert` to C1 with:
```yaml
alert: <PascalCaseName>
owner: Cxx
expr: <PromQL using only metrics the chunk exports>
for: <duration>
severity: page|warn|info
notify_tenant: false|true   # true only if the tenant can act on it
summary: "<no PHI; may include {{ $labels.tenant_id }} UUIDs>"
runbook: <docs/manual/<module>/… or text C1 copies into infra/runbooks/<module>.md>
test_cases: [ {series: …, expect: firing|not_firing} ]
```
C1 transcribes thresholds verbatim, adds routing, writes `promtool` tests and returns the rule id. Dashboard requests: list of panels with metric + description (D15).

## 7. Command-line UX

| Task | Command (from ops-1, repo checkout at the release tag) |
|---|---|
| Converge hosts | `ansible-playbook -i inventories/<env> playbooks/site.yml [--limit app] [--check --diff]` |
| Deploy | `infra/ci/deploy.sh <env> <release>` (prod asks for the approval id) |
| Rollback | `infra/ci/rollback.sh <env>` |
| Verify | `ansible-playbook -i inventories/<env> playbooks/verify.yml` → TAP summary `ok N / not ok M` |
| External tests | `infra/tests/run.sh external <env>` |
| Rotate a secret | `ansible-playbook … rotate-secret.yml -e secret_id=<id>` |
| Restore drill now | `ansible-playbook … restore-drill.yml -e reason="<text>"` |
| Promote standby | `ansible-playbook … dr-promote.yml -e confirm_env=prod` (DESTRUCTIVE) |
| Studio break-glass | `ansible-playbook … studio-breakglass.yml -e action=enable -e hours=2 -e approval=<ref>` |
| Patch | `ansible-playbook … patch.yml [-e emergency=true -e cve=<id>]` |
| Ops note | `infra/ci/ops-note.sh "<text>"` |
Exit codes: 0 ok, 2 pre-flight refused (nothing changed), 1 failed after changes (see output for the step and runbook anchor).

## 8. Alert message format (e-mail)

```
Subject: [PAGE][prod] RpoAtRisk — WAL in DR repo older than 14 min
Env: prod   Site: A   Started: 2026-11-06 14:05 NPT (08:20 UTC)
Labels: host=data-1 repo=2
Summary: newest WAL in repo2 is 851 s old while WAL is waiting to be archived (threshold 840 s; RPO 15 min).
Runbook: https://<ops host>/runbooks/backup.md#rpoatrisk   (reachable over WireGuard only)
Dashboard: D7 Backups & DR
```
Template lint: rejects label names on the 02-TRD §11.2 drop list and any annotation containing `@` (e-mail addresses) or digit runs ≥ 7 (phone numbers) [CONV].

## 9. Accessibility and language
Runbooks and templates in English (CV §13); Grafana default theme; colour is never the only signal — status panels show text (`OK`, `WARN`, `DOWN`).
