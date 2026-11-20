# T0B-GOLIVE-1 tests
- File: tests/docs/T0B-GOLIVE-1.runbook.test.mjs (node:test, no dependencies). Run: `.orchestra/notes/T0B-GOLIVE-1-verify.cmd` or `node --test tests/docs/T0B-GOLIVE-1.runbook.test.mjs`.
- Covers done_when 1-8: three docs exist (>=250 words), required headings (`##`/`###`) per doc, named content items, FOUNDER DECISIONS section (must be a heading; each decision plus options, recommended default, "stays with the founder"), no secret-like patterns, only placeholder IPs/hosts/emails.
- Heading contract for the writer: GO-LIVE: Topology, Power is not availability, Monitoring, Offline link, Outage drill, Founder decisions, Unknowns (or "open questions"). BACKUP-RESTORE: Backups, Restore drill, Retention, Recovery time (RTO/RPO). CUTOVER-ROLLBACK: Cutover, Freeze window, Smoke test, Rollback.
- Placeholders allowed: example.com/.invalid/.test, 192.0.2.x, 198.51.100.x, 203.0.113.x, private ranges. No 32+ hex or 40+ base64 strings, no phone numbers.
- Expected now: fails because the three docs do not exist. Existing repo lint/docs tests are not re-run by verify.cmd.
