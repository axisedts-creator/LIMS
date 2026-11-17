# T0B-GOLIVE-1 impl
- Files: docs/ops/GO-LIVE-OWN-SERVER.md (topology, power checklist, monitoring, offline link, outage drill, founder decisions, unknowns), docs/ops/BACKUP-RESTORE.md (backups, retention, RTO/RPO, restore drill), docs/ops/CUTOVER-ROLLBACK.md (freeze window, cutover, smoke test, rollback). Test by tester, unchanged.
- [CONV] Extends docs/ops/STORAGE.md (T0B-STORAGE-1) by link; offline section follows C:/LIMS-state/offline-design-20261117.md and LD-322; only placeholder hosts/IPs (example.com, RFC 5737/1918), no secrets.
- Decision: RTO 4 h same hardware / 8 h new hardware, RPO 15 min (WAL) / 24 h whole office loss; targets until the first drill measures them.
- Decision: cloud copy kept read only as fallback for 14 days after cutover; retiring it is a founder decision (data deletion).
- Tests: T0B-GOLIVE-1 84/84 pass. tests/lint + tests/docs 263/264: one failure in C2-T30 (admin page.tsx screen table), checks apps/ page.tsx vs docs/manual, files this task never touches; not fixed here.
- Open: every founder decision in GO-LIVE section 7 (hardware, ISP, providers, backup location, credentials, Nepal legal review, offline devices, accountant on provisional numbers); SYNC tasks not yet on main.
