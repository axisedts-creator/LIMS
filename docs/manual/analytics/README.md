# Analytics and MIS: user manual

This manual explains the Analytics screens for lab owners, managers and finance staff. Every screen also has a help panel (Alt+H) with the same rules in short form. All screenshots use a synthetic demo lab, never real patients or real figures.

## Screens

| Page | Route | Who sees it |
|---|---|---|
| [Owner dashboard](dashboard.md) | `/analytics` | users who may read the dashboard |
| [MIS reports](reports.md) | `/analytics/reports` and the report pages | users who may read the dashboard |
| [Collections history](reports.md#collections-history) | `/analytics/collections` | users who may read collections (finance) |
| [Referral business report](referral-incentive.md) | `/analytics/referral-incentive` | users with the referral report permission, if switched on for the lab |
| [My exports](exports.md) | `/analytics/exports` | users who may export data |
| [Scheduled reports](schedules.md) | `/analytics/schedules` | users who may manage schedules |
| Report run (from an email link) | `/analytics/report-runs/{id}` | recipients and the owner of a schedule, after sign-in |

## Rules that apply everywhere

- **Business day.** A day runs 00:00–24:00 Nepal time (UTC+05:45). The same rule is used for every report.
- **Periods.** Every period is shown in both A.D. and B.S. dates. Presets include This B.S. month, Last B.S. month, This fiscal year and This A.D. month. A custom range can be at most 366 days.
- **Freshness.** The header shows "Updated {time} (Nepal time)". "Data may be out of date" means recent changes are still being processed or the last update failed. Refresh is available again after 5 minutes.
- **Centre scope.** You only see figures for the centres you have access to. Users with access to all centres see everything.
- **Money.** Amounts are in NPR with lakh grouping, for example 2,25,000. A negative net sales figure shows a minus sign.
- **Internal MIS.** Exports and reports are internal MIS and not a statutory register.

## Metric ids

Help and manual name each figure with an id such as M12 (Income, net sales) or M27 (Net collected). The ids are the same in every document, so you can quote them when you ask a question.
