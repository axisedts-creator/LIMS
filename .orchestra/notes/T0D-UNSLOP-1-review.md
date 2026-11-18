APPROVE

Re-review of d53126dc3..HEAD (T0D-UNSLOP-1) per LD-360 / LD-361.
- Only code-side change: rs-c8.screens.admin.test.tsx.snap "New schedule form": removed Scheduled reports crumb + data-label-placement="above" on lims-form (from T0D-DENSITY-1 a2a2474f7). Both inside the LD-360 + LD-361 allow-list. No other snapshot, test or assertion touched.
- Other changes are .orchestra notes only (impl, ruling, dispute file renamed).
- Runs (2026-11-18 06:36 NPT): rs-c8 36/36, unslop1 30/30, an-t18 58/58.
- No route, permission, contract, API, PHI-log or secret change in this range. Cap 75 and part B handled by LD-360 (moved to T0D-UILIST-1/2/3, T0D-UISETTINGS-1).
