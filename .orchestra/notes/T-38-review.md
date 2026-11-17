APPROVE

T-38 review (reviewer), diff b90b4d8d..HEAD.
- done_when met: help/<slug>.md for all 19 screens (SCR-01…19, SCR-07/08 analyte/ranges, SCR-18/19 imports); docs/manual/catalog one page per screen + README index; integration.md covers every 04-UI-UX §7 item (CatalogPort, snapshots, birthOn/ageDays, getPriceListStatus vs catalog.v_pub_*, kind = text, catalog.changed.v1); runbook.md has the three §7 entries incl. verbatim `catalog.import_*`. 05-DoD §3.8 satisfied.
- Names: every backticked token (routes, permissions, error code catalog.tax_config_missing, regexes, CP00001/DR00001, keys) found verbatim in 03-IC §permissions / C3 02-TRD / 04-UI-UX. No invented names. "commission" absent. Tax disclaimer present on tax screens.
- Paths: only docs/manual/catalog/**, features/catalog/help/** (writer), __tests__ (tester), role notes. The C1.T-24 cr rename (R100) is orchestrator housekeeping, no content change.
- N/A for docs task: RLS, idempotency, rate tier, logs. No PHI, no secrets (synthetic examples only, e.g. +9779800000000).
- Tests: ran vitest web-t38 config, TZ=Asia/Kathmandu: 216/216 pass. Ruling applied at test:230 (raw-text check).
