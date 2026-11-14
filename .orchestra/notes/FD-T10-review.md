APPROVE
Re-review after 3b52cac1. Both earlier defects are fixed:
1. trf.service.ts:98 — maxBytes = min(LIMS_FRONTDESK_TRF_MAX_BYTES via loadFrontdeskConfig().trfMaxBytes, 15728640). The cap matches the DB `trf_attachments__size__ck`. The hard-coded MAX_BYTES is gone.
2. trf.service.ts:96 and trf_scan.ts:41 — the keys are now `{tenant}/q/{yyyy}/{mm}/{id}` and `{tenant}/{yyyy}/{mm}/{id}`, matching 05-SCHEMA. No `.ext`/`bin` suffix is left.
Ran tests/frontdesk/FD-T10.pg.sh: api 66/66 and worker 27/27 pass.
Earlier checks still hold: permissions, 404 scoping, the scan gate, trf.view on every content call, task names and attempts, cron, metric, purge order with `$2::uuid[]`, no PHI in logs, no secrets, only owned paths, and pending.json edited per LD-70.
Non-blocking nit: trf.live.test.ts:6/71 and helpers.ts:154 still use `.pdf`/`.ext` quarantine paths in their fixtures. This is harmless because the worker derives the destination from the id.
Open from before (lead to decide whether a CR is needed): no qpdf sanitise in trf_scan, and JPEG re-encode is a core gap.
