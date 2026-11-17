# Incident response (`incident-response`)

Owner C1. REQ-SEC-134, 03-APP-FLOW s12, 04-UI-UX s5. For alerts see the family runbooks; for the on-call routine see [oncall.md](oncall.md). This file holds the severity matrix, the incident states, the evidence-freeze procedure, the Privacy Act decision record and the notification templates.
Nothing in an incident record contains patient data: use tenant ids (UUIDs), counts, timings and hashes only.

## Severity matrix
| SEV | Definition | Examples | Response |
|---|---|---|---|
| SEV1 | PHI confidentiality breach suspected, or total outage of registration/reporting for at least one tenant, or data loss beyond RPO | public DB port open; cross-tenant leak report; site A down | page immediately; founder informed within 30 min; incident commander assigned |
| SEV2 | major degradation or security control failure without known disclosure | WAL archiving failing; audit shipping down; one service down with failover; TLS cert expiring under 7 days | page; ack within 15 min |
| SEV3 | partial or single-tenant degradation | one bridge agent offline over 1 h; queue backlog | warn digest; next business hours |
| SEV4 | informational | Studio enabled; `EdgeNotFoundSpike` without other signals | dashboard / warn digest |

## Roles
- **Incident commander:** the primary on-call, unless handed over by name. Decides severity, containment order and who is called. Keeps the timeline in the ops log (`infra/ci/ops-note.sh`).
- **Founder / counsel contact:** informed at once for SEV1/SEV2; decides tenant notification with counsel.
- **C2 console (platform admin):** used to lock users, revoke sessions and end support sessions; the incident commander asks a platform admin if they do not hold the role.
- **Tenant admin:** the tenant's contact; receives the notification. Patient notification is the tenant's decision.

## States
The states below are recorded in order. Each state change gets a line in the ops log.

| State | Entered when | Exit criteria | Mandatory records |
|---|---|---|---|
| `detected` | alert, tenant report, staff report, external report | on-call acknowledges | time detected, source |
| `triaged` | severity assigned (SEV1 to SEV4) | incident commander named | severity, PHI-possible yes/no |
| `contained` | blast radius stopped: isolate a host, block an IP, revoke tokens and sessions, disable an account via C2, disable a route at nginx | no ongoing access | actions with timestamps |
| `evidence_preserved` | PHI-possible: evidence frozen (see "Evidence freeze") | hashes recorded in `ops_audit` | within 4 h of `triaged` |
| `assessed` | facts established: which tenants, which records (counts by class), which actor | privacy assessment form filled (below) | sections considered |
| `notified` | tenant(s) informed per decision; counsel consulted | records of who, when and what | our own target: affected tenant informed within 72 h after `assessed` |
| `recovered` | service normal; secrets rotated; patched | none | none |
| `reviewed` | post-incident review within 10 working days | actions tracked | review document |

Containment actions: isolate the host (nftables drop all except wg0 from the ops host), revoke tokens and sessions, lock the user in C2, end a support session, block the IP (`edge.md#manual-ban`), disable one route (`edge.md`). Contain first when data is leaving; preserve evidence second, but still within 4 h of `triaged`.

## Evidence freeze
Within 4 h of `triaged` for any PHI-possible incident (not only after `contained`):
1. **Audit store:** `pg_dump` of the affected tenant range of `lims_audit` (and the source tables if the audit store is suspect). Hash it: `sha256sum <file>`.
2. **Logs:** export the VictoriaLogs window of the incident (start 1 h before the first signal) and nginx logs from the host. Hash each file with `sha256sum`.
3. **Host:** take a provider snapshot of the affected host if available; otherwise note that none exists. Do not reboot or rebuild before the snapshot.
4. **Record:** write each file name, size and sha256 with `infra/ci/ops-note.sh "evidence <file> sha256 <hash>"` so the hashes land in `ops_audit`.
5. Store the files on the ops host in a directory only ops can read; copy them to site B backup storage.
6. Reading `access_log` or `audit_log` for the assessment uses `audit_reader` only with founder approval (`audit.md`, "Investigation access").

## Privacy assessment form
Filled in state `assessed`. Fields:
- incident id
- tenants affected (UUIDs)
- data classes affected (health / personal / none; REQ-SEC-004)
- record counts per class
- actor type (external / insider / staff error / system)
- disclosure confirmed / possible / excluded
- channel
- containment time
- evidence hashes
- tenant is a public body? (s.25 and s.27(1) apply directly only then; 04 L17)
- sections considered: s.12(4) (health-examination details disclosed without consent), s.26(1) (body corporate use or sharing), s.29 (offences by any person; staff can be personally liable), s.30 (complaint within three months), s.31 (compensation)
- decision on tenant notification
- counsel consulted (name and date)
- Privacy Regulation 2077 obligations: **UNVERIFIED, counsel to confirm (B16)**

04 L17 lists no breach-notification deadline. Whether the Act or the Regulation sets one is **UNVERIFIED**; counsel confirms (B16). Our own target is the 72 h above. Do not tell a tenant that a deadline exists or does not exist until counsel confirms.

## Notification templates
No PHI in any template. Patient notification is the tenant's decision and communication; the LIMS provider supplies facts and a draft on request.

**Tenant, security incident:**
> Subject: Security notice for <lab name> - incident <id>.
> We detected <category> on <date, NPT>. Affected: <data classes, counts>. Actions taken: <containment>. What you should do: <steps>. Contact: <ops contact>. Details are available to your tenant admin in a meeting; we do not send patient data by e-mail.

**Tenant, maintenance:**
> Planned maintenance <date> <22:00-02:00 NPT>. Services affected: <list>. Expected impact: <minutes>.

**Status page component states** (`infra/status/status.yaml`): `operational`, `degraded`, `partial_outage`, `major_outage`, `maintenance`. Status notices name components only, never tenants or patients.

## Tabletop log
A tabletop exercise on a synthetic scenario is held twice a year (REQ-SEC-134) and recorded as a dated file here. The next one is due by the `Next tabletop` date of the newest record.
- [2026-11-08 synthetic credential-exposure scenario](tabletop-log/2026-11-08-credential-exposure.md)
