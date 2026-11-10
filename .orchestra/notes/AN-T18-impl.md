# AN-T18 impl
- Files: app/(staff)/analytics/{page,loading,error}.tsx; features/analytics/components/{DashboardView,DashboardActions}.tsx; features/analytics/server/dashboard.server.ts (new); server/actions.ts (+refreshAction).
- [CONV] page = async server component, whitelist-only searchParams → API (period + comma-joined centre_id/branch_id); API 4xx/5xx rejects → error.tsx (digest only, no raw message).
- [CONV] Refresh via server action refreshAction; 429 is a normal outcome → "Refresh available at {time}".
- Tests: `.orchestra/notes/AN-T18-verify.cmd` → 3 files, 45/45 pass (first cold run had one 15s timeout in error.tsx test, passed on rerun).
- Open: tester-listed NOT covered (shortcuts, FilterBar/PeriodPicker wiring, row-3 cards, "Show yesterday" navigation) not verified; no tsc/lint/full-suite run yet.
