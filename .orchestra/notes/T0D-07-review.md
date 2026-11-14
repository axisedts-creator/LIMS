APPROVE
Round 2. Both round-1 defects are fixed:
1. authz-guard.ts now emits `lims_core_authz_not_asserted_total` with `{ operation_id }`, matching 02-TRD:1038.
2. helpers.ts `makeMetrics` now records labels (`labelsOf`). authz-guard.test.ts:107 asserts `{operation_id:'createWidget'}` and registry.test.ts:179 asserts `{module:'instruments',port:'CatalogPort'}` for `lims_core_port_consumer_not_listed_total` (02-TRD:572/1038).

Re-checked, OK: names verbatim, resolution matrix (03-APP-FLOW §3.4, AC-0D-6.1–6.4, 2.4), fail-closed strict envs, no detail in the consumer error, no PHI or secrets, only owned paths. Ports suite: 135/135 pass. `tsc --noEmit` is clean.
Nit (not blocking): the header comment at registry.ts:2 says "real > forced fake" but the code does forced fake > real in dev/ci, as the impl notes say. Fix the comment when convenient.
Open (T0D-01 follow-up): wire `resolvePorts` into API/worker boot and `check` into stage 9.
