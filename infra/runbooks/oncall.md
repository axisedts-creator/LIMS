# On-call (`oncall`)

Owner C1. 04-UI-UX s5.2. Severity definitions and incident handling are in [incident-response.md](incident-response.md) (SEV1 to SEV4). Contacts are never committed here: names, phones and addresses live in the sealed secrets store (`alert_contacts`) and are rendered into Alertmanager at deploy time.

## Rota
- Weekly rota with a primary and a secondary on-call (at least 2 engineers). A staffing plan for 24/7 cover is still an open item (research 03 s11 q9); until then the primary and secondary agree their own out-of-hours gaps with the founder.
- Handover is every Monday 10:00 NPT (see "Handover").

## When you are paged
1. Acknowledge within 15 min by creating an Alertmanager silence with the comment `ack <name>` (matching the alert name and host, duration 1 h, renewed while you work).
2. Open the runbook anchor from the alert (`runbook_url`), run "Check first" before you change anything.
3. Write a line in the ops log: `infra/ci/ops-note.sh "<what you saw and did>"` (this lands in `ops_audit`).
4. Classify the severity with the matrix in `incident-response.md`. SEV1: inform the founder within 30 min and name an incident commander.

## Escalation
- No acknowledgement in 15 min: Alertmanager pages the secondary.
- No acknowledgement in 30 min: the founder is paged. These timings come from the receiver `repeat_interval` and routing in the Alertmanager config; do not extend `repeat_interval` to quiet a page.
- You can escalate yourself at any time when a runbook says "Escalate when".

## Paging channel
- Pages go by e-mail through the transactional relay (the only pre-allowed foreign egress pattern).
- SMS paging is not enabled: it needs founder approval first (CR-C1-006). Until then, keep your phone's mail notification on for the on-call address.
- If mail itself may be failing, `Watchdog` (every 6 h) is the heartbeat: see `monitoring.md` and `ops.md#watchdog`.

## Silences
- Use silences to acknowledge or to hide a known, planned condition (maintenance). Always add a comment and an end time; no open-ended silences.
- Never silence `Watchdog`, `AuditDigestMismatch`, `ForbiddenPortOpen` or any `security` alert without the secondary's agreement.

## Handover
- Monday 10:00 NPT, 15 min call or written note.
- Review: open incidents, active silences (remove stale ones), pending patches (`patching.md`), alerts that fired this week and which runbook lines were wrong or missing.
- The outgoing on-call writes the handover note into the ops log with `ops-note.sh`.
