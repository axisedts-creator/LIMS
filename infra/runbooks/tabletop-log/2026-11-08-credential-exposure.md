# Tabletop record: synthetic credential exposure

- Date: 2026-11-08
- Scenario: synthetic. An ops engineer's SSH key is found in a public paste; a login from an unknown address appears on the app host. No real patient data, tenant or person is involved.
- Participants: C1 writer agent only (desk walk-through against incident-response.md). The founder and the on-call engineers have not yet taken part; see Actions.
- Incident commander: primary on-call (role played by the writer agent)
- Severity: SEV1 (PHI-possible until excluded)
- Evidence frozen within 4 h: yes (walk-through timeline: T+2 h 10 min)
- Notification decision: notify the affected tenants in the walk-through (synthetic) once counsel has confirmed whether a deadline applies; our own target is 72 h after the assessment.
- Counsel: not consulted (synthetic exercise). In a real incident counsel is consulted; the Privacy Regulation 2077 content is UNVERIFIED (B16).
- Actions: (1) hold the first tabletop with the founder and both on-call engineers using this scenario; (2) confirm B16 with counsel; (3) rehearse the sha256 evidence step on a staging host; (4) add SMS paging only after CR-C1-006 approval.
- Next tabletop: 2027-04-30 (at most 6 months after this one; REQ-SEC-134 requires two per year)

## Walk-through (times are relative to the first signal)
1. T+0: alert `SshLoginOutsideOps` fires, a login by a non-ops account is seen. State: detected. Primary acknowledges within 15 min with the `ack <name>` silence and writes an ops log line.
2. T+0 h 20 min: severity set to SEV1 because PHI access cannot be excluded; incident commander named. State: triaged.
3. T+0 h 40 min: account locked, sessions ended, SSH key removed from the account list, host isolated except wg0 from the ops host. State: contained.
4. T+2 h 10 min: `pg_dump` of the affected range of the audit store, the VictoriaLogs window and nginx logs exported; each file hashed with sha256 and the hashes written to `ops_audit` by `ops-note.sh`; provider snapshot taken. State: evidence_preserved (inside the 4 h limit).
5. T+6 h: facts established with founder-approved `audit_reader` queries: in the synthetic case no record was read. Privacy assessment form filled, sections considered: s.12(4), s.26(1), s.29, s.30 (three-month complaint window), s.31; s.25 and s.27(1) apply only if a tenant is a public body. State: assessed.
6. T+30 h: tenant notice sent using the security template with no PHI, after the founder and counsel agreed the wording. State: notified (inside our 72 h target).
7. Afterwards: secrets held by the host rotated and the host rebuilt (recovered); post-incident review booked within 10 working days (reviewed).

## Findings
- The runbook steps worked in order; no step needed information that is not in a runbook or the secrets store.
- Gap: `secrets.md`, `patching.md` and `dr.md` are written by other tasks and were not available to walk through.
- Gap: nobody outside the writer has run the exercise; that is action (1).
