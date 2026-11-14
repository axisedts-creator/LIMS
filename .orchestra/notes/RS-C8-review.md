APPROVE

Scope: git diff ea5ceaf2..HEAD (DashboardView.tsx, ExportDialog.tsx, ReportView.tsx, rs-c8.dashboard.test.tsx per ruling 2, rs-c8 snapshots per LD-170, CR + notes).

Checked:
- Only owned paths (apps/web/src/features/analytics/**) plus role-named .orchestra notes/cr. No API client, field, validation, permission or route change; hrefs are the pre-existing an-t18 hrefs.
- s4/s6: one `<ol aria-label="Sample pipeline">` with the 7 stage labels verbatim; counts only where a source tile exists (pending_tests, results_approved), each inside a filter link; "Needs you" region; money strip only when the API sent a paisa tile, with "Rs." (fmt) and period.label_ad; `Grid columns={3}` of tiles removed. Missing stage counts / role feed raised as CR (.orchestra/cr/RS-C8.md), nothing invented.
- No raw colour, px radius or inline style object: ExportDialog uses kit `Inline`; ReportView `style` is DurationText's format variant (not CSS). Classes used (lims-stepper-list, lims-step, lims-step-label) exist in packages/ui kit.css:190-195.
- Test edits match RS-C8-ruling.md items 1-2 exactly (delta stripped before digit scan; outside cap 2; :98/:141 kept).
- No PHI in logs, no secrets, no backend/RLS surface touched (UI-only task).

Runs (reviewer, CI=true): rs-c8 config 36/36; an-t18 config 58/58; an-t17 config 30/30 (the writer's an-t17/an-t18 timeouts did not reproduce).
Not run: an-t19/an-t20 (writer reported green), eslint (no binary in apps/web).
