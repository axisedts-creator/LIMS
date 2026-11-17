APPROVE

T-29b review (diff eb8b1542..HEAD).
- Names verbatim: `getPriceListStatus`, `{ priceListId, isActive, status }`, status set draft|published|superseded|discarded (C3 set, no `retired`) match 02-TRD §6.1 / 08 A24.1 / 08 §4.14 signature; `common.not_found` per §6.1 throws row.
- §7.4a: step 1 tenant-filtered lookup + not_found; step 2 `is_active`; step 3 `listStatus` published > draft > discarded, never superseded; step 4 no effectiveness check. Correct.
- Tenant isolation: tenant bound from ctx only, explicit `tenant_id = $1` on both reads (plus RLS on ctx.tx); bind-only SQL; no DDL in diff (none needed per TRD §15 note). No permission check — matches §6.1 [CONV]. No logs, no PHI, no secrets.
- Paths: only the two brief files + own test + notes. Owned.
- Tests: contract (34) all sub-cases incl. deactivated list and never superseded/retired; (35) unknown + both-direction cross-tenant; S-19 non-disclosure, indistinguishable errors, no v_pub_* read (P-21/R25). Ran verify: real 25/25 pass; fake CatalogPort contract 32/32 pass.
- Non-blocking note: §7.4a/§6.1 say "reads the cached price-list index (§6.3)"; impl is uncached (2 indexed reads), documented [CONV] in T-29b-impl.md. Results identical and fresher; not a contract defect. Revisit if C16 call volume makes it hot.
- Non-blocking: zero-version list reads `discarded` (spec silent; unreachable since a list is created with draft v1).
