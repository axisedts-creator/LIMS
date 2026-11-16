# T0A-M5-PHLEBO-1 impl (writer)
Files: apps/phlebo_app/lib/features/route/ui/route_screen.dart (one LimsCard per visit, list padding; cancelled row greyed with neutral.600), identity/ui/identity_screen.dart (instruction + two choice groups on LimsCards), consent/ui/consent_screen.dart (text + version on a LimsCard). Visit already met the look; collect untouched.
[CONV] LD-258: restyle only; no behaviour, API, route, storage or mutation change; existing lims_ui widgets only (packages/ui-flutter untouched).
[CONV] review fix 1: cancelled visit (C17 04-UI-UX:107 "greyed") uses LimsTokens.colorNeutral600 via ListTileTheme.merge plus its two theme-styled Texts (sequence, tubes), not opacity 0.6 (3.2:1 failed the 4.5:1 sunlight gate).
[CONV] no bottom navigation on the route: Handover / Outbox / Settings stay in the route.menu popup.
Gap (founder): board History and Profile tabs (no screen in this app); tube colour dots (no data in the API model); board greeting, progress ring and all sample content (not built).
Gap: per-tube card look on M6 collect needs collect/** in the file list (not in this brief). Open: __tests__/m5 129/129, flutter analyze on touched files clean; full __tests__ 619/620: db_ci_guards REQ-SEC-102 (core/db, untouched) pre-existing.
