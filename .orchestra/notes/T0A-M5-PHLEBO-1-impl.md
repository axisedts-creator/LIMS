# T0A-M5-PHLEBO-1 impl (writer)
Files: apps/phlebo_app/lib/features/route/ui/route_screen.dart (one LimsCard per visit, list padding; cancelled row no longer faded), identity/ui/identity_screen.dart (instruction + two choice groups on LimsCards), consent/ui/consent_screen.dart (text + version on a LimsCard). Visit already met the look; collect untouched.
[CONV] LD-258: restyle only; no behaviour, API, route, storage or mutation change; existing lims_ui widgets only (packages/ui-flutter untouched).
[CONV] cancelled visit is marked by the status chip and block icon instead of opacity 0.6 (3.2:1 failed the 4.5:1 sunlight gate).
[CONV] no bottom navigation on the route: Handover / Outbox / Settings stay in the route.menu popup.
Gap (founder): board History and Profile tabs (no screen in this app); tube colour dots (no data in the API model); board greeting, progress ring and all sample content (not built).
Gap: per-tube card look on M6 collect needs collect/** in the file list (not in this brief). Open: __tests__/m5 129/129; full __tests__ 617/620: db_ci_guards (core/db, untouched) fails alone too, the two sync_engine tests failed only under the full parallel run.
