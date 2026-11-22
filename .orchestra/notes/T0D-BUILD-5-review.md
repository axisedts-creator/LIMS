APPROVE
# T0D-BUILD-5 re-review (reviewer)

Prior items resolved:
1. TatView.tsx:46 `more = !!data.next || !!sp['cursor']`; a later page now reads "at least N" with the card note. Tester case added (t0dbuild5.views.test.tsx, sp.cursor, no next).
2. .orchestra/notes/T0D-ELABMENU-3-table.md reverted: no longer in `git diff 2109ee577..HEAD`.

Re-checked, OK: names verbatim (listTatAlerts, getAutoverifyRuleSet, quality.tat_alert.read, quality.tat_alerts); badge checks permission before any request, one call per layout render, failure swallowed and logged (error text only, no PHI/token), '50+' cap, no badge for 0; names via existing listDepartments/listCentres with IdText fallback; kit DataTable replaces BarChart on /quality, /quality/runs, /quality/tat-alerts; autoverify 404 -> EmptyState (contract "404 when none yet"), other failures -> LoadError with reference, no enable button; left file records the missing total. No api/contract/migration/permission change, no secrets.
Note (not blocking): 17 files under apps/web vs "at most 16" (includes tester vitest config); lead may accept.
Ran: T0D-BUILD-5-verify.cmd config -> 91/91 pass. tsc --noEmit: no errors in quality, shell or (staff)/layout files.
