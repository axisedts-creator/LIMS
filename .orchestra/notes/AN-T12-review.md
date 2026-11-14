APPROVE
Diff 2db8a83b..HEAD reviewed for AN-T12 (TAT).
- tat.repo.ts SQL matches TRD §6.6 verbatim (tenant $1, segment ANY $2, [from,to) on business_date, scope $5/$6, optional priority/specimen_type_code/processing_branch_id bound after $6; percentile_cont 0.5/0.9, max, n and anomalies split on is_anomaly). Group keys come from a closed constant map; there is no input interpolation.
- Handler: permission `analytics.dashboard.read`, query params and group_by enum match TRD §5 #10. Validation runs before any read; an unknown or foreign processing_branch_id returns 404 common.not_found without echoing the id. The mapper rounds half-up. Label keys are `analytics.tat.<segment>.start/.stop`.
- Tenant always comes from ctx; an empty restricted scope returns no rows; NULL-centre facts are visible only to all-centre users. This diff has no migrations, RLS changes, logging or secrets. All paths are inside the C8 analytics module.
- Tests cover US-11.1–6 plus missing endpoint, negative/anomaly, rejected/aliquot, urgent filter, scope, injection and tenant isolation. Ran the 3 files: 91/91 pass. tsc reports 0 errors in modules/analytics.
- Note (no defect): the exclusion rules live in the tat_facts refresh (AN-T04). Here they are exercised through the helpers.t12 emulator, not against a real DB. Real-DB SQL execution has not been verified in this lane.
