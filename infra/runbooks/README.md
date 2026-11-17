# Runbooks (`infra/runbooks/`)

Owner C1. Every alert has a section named after it (anchor = lower-case alert name; the alert's `runbook_url` points here, 02-TRD s11.3). Entry template: 04-UI-UX s4.2. Read "Check first" before you change anything.

## What do I do when...
| Situation | Go to |
|---|---|
| I was paged | [oncall.md](oncall.md), then the runbook anchor in the alert |
| Possible data exposure, intrusion, or a SEV1 | [incident-response.md](incident-response.md) |
| Traffic flood, 5xx, rate-limit alerts | [ddos.md](ddos.md), [edge.md](edge.md) |
| Certificate, nginx, fail2ban, egress | [edge.md](edge.md) |
| Database down, connections, locks, replication slot | [db.md](db.md) |
| WAL archiving, backups, RPO, object replica | [backup.md](backup.md) |
| Restore drill failed or overdue | [drill.md](drill.md), [backup.md](backup.md) |
| Audit shipping or digest mismatch | [audit.md](audit.md) |
| Worker, queue, renderer, scanner, Valkey, rollback | [runtime.md](runtime.md) |
| Disk, memory, clock, patching, config drift, LUKS unlock, site down | [host.md](host.md) |
| SSH, sudo or secret-decrypt alert | [security.md](security.md) |
| Prometheus, Alertmanager or VictoriaLogs down, `Watchdog` missing | [monitoring.md](monitoring.md), [ops.md](ops.md) |
| IRD server access | [ird-access.md](ird-access.md) (blocked, B6) |

## Module runbooks (imported rules, text from each owner)
[analytics.md](analytics.md), [anatomic.md](anatomic.md), [billing.md](billing.md), [catalog.md](catalog.md), [core.md](core.md), [frontdesk.md](frontdesk.md), [identity.md](identity.md), [instruments.md](instruments.md), [inventory.md](inventory.md), [lab.md](lab.md), [micro.md](micro.md), [partners.md](partners.md), [payments.md](payments.md), [quality.md](quality.md), [reporting.md](reporting.md), [smartreport.md](smartreport.md).

## Procedure files written by other tasks
[patching.md](patching.md), `dr.md`, `secrets.md`, `deploy.md`, `studio.md` (patching, disaster recovery, secret rotation, deploy and rollback, Studio break-glass). Runbooks refer to them by name; each is added to this index when its file lands.

## Severity matrix
| SEV | Meaning | Response |
|---|---|---|
| SEV1 | PHI breach suspected, total outage for a tenant, or data loss beyond RPO | page now; founder informed within 30 min; name an incident commander |
| SEV2 | major degradation or a failed security control | page; ack within 15 min |
| SEV3 | partial or single-tenant degradation | warn digest; next business hours |
| SEV4 | informational | dashboard / warn digest |
Full table with examples: [incident-response.md](incident-response.md).

## Contacts
Placeholder only. No names, phone numbers or addresses are stored in git. Contacts live in the sealed secrets store (`alert_contacts`) and in the founder's handover note. The ISP/datacentre mitigation contact is `isp_mitigation_contact` (empty until B12).

## Tabletop and drill logs
Incident tabletops: `tabletop-log/` (index in [incident-response.md](incident-response.md)). Restore drills: `drill-log/`.
