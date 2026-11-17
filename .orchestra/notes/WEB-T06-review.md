APPROVE
Re-review after 8a1acaad: prior item 1 fixed (`t06.out` removed, no longer tracked).

Checked, no defect: E40/E41 routes, `instruments.instrument.manage`, `If-Match "<version>"`, `409 common.version_conflict` -> conflict banner text verbatim (04-UI-UX SCR-11), toast texts, field names/ranges/HH:MM regex from 02-TRD §7.4, no retention field (help text only), body whitelist drops `version`/unknown keys, `server-only` on BFF fns, read-only without manage, no PHI/secrets, no DB/RLS in this task.
Tests: WEB-T06-verify.cmd suite re-run 2026-11-09 -> 2 files, 85/85 passed. Cover banner, If-Match, no-retention, read-only, window toast (AC-15.5 UI side).
