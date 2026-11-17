APPROVE

Scope: aa70974f..HEAD — docs/manual/instruments/{user-guide,site-installation}.md + writer/tester notes. Docs only; no code, schema, RLS, routes or endpoints touched, so tenant isolation / idempotency / rate tier checks are N/A.

Checked against spec (verbatim):
- Routes + permissions (04-UI-UX §1 nav table; `catalog.instrument_code_map.manage` §SCR-08): match.
- Page keys Alt+A/E/I/P/R + Alt+P Reprocess (04-UI-UX key table): match.
- CLI commands, flags, exit codes 0/1/2/3, `--force-discard-pending`, `firewall enable|disable` (04-UI-UX §CLI): match.
- Agent error codes auth_rejected/tls_verify_failed/disk_low/firewall_rule_missing/config_rejected + 500 MB guard (04-UI-UX, 02-TRD disk guard): match.
- Enrolment code: once, one PC, 24 h, earlier codes stop working, "I have copied this code" (SCR-03, AC-01.3): match.
- Go-live 4 checkbox labels, evidence min 10, not-verified block (SCR-07): match. Suspend/retire reason 3–300 (E29/E31): match.
- Offline > 180 s (AC-13.2), poll 30 s, message range ≤ 31 days / default 24 h (AC-18.1), records 90 days + preview parse (D-11, SCR-10): match.
- Agent retire needs all instruments retired (A6); retired agents cannot get codes (E14 409): match.
- REQ-SEC-120/122 checklists reflected; no PHI, no secrets, synthetic placeholders only. Paths owned by C7.

Non-blocking: brief has tests="none"; verify.cmd no-op is consistent with done_when="reviewed".
