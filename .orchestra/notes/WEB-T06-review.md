CHANGES
1. t06.out:1 — stray vitest output committed at repo root; path not owned by C7 (01-CHUNK-MAP §3). Fix: `git rm t06.out` (keep run output in `.orchestra/notes/` only if the role allows, otherwise drop it).

Checked, no defect: E40/E41 routes, operationIds, permission `instruments.instrument.manage`, `If-Match "<version>"`, `409 common.version_conflict` → banner text verbatim (04-UI-UX SCR-11), toast text verbatim, field names/ranges/HH:MM regex verbatim from 02-TRD §7.4, no retention field (help text only, verbatim), body whitelist excludes `version`/unknown keys, `server-only` on BFF fns, no PHI/secrets, read-only without manage. No DB/RLS in this task. Tests cover banner, If-Match, no-retention, read-only, window toast (AC-15.5 window part, UI side).
