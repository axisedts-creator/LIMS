# FD-T16 impl
- Files changed: none. FD-T16 is tests-only (probes/ owned by tester); no handler code needed.
- [CONV] LD-70: probes/pending.json already `[]` (no stub ops left); no edit needed.
- Ran: registry.static.test.ts -> 38/38 pass (no DB).
- NOT run: 6 *.live.test.ts suites (crossTenant, crossCentre, privilege, tables, phi.logscan, uploads); need Docker PG17 via FD-T16-verify.cmd, which required approval and was not granted in this session.
- Open: run FD-T16-verify.cmd; any live failure is a finding against implementation, not yet known.
