# FD-T17 impl
- Added help/{registration,order,patient,worklist,discount_approvals}.md (Purpose/Fields/Shortcuts) under apps/web/src/features/frontdesk/help/.
- Added docs/manual/frontdesk/{registration,orders-patients,worklist-approvals}.md covering all 5 routes + registration shortcuts.
- Content taken from the shipped components (FD-T13/14) and SHORTCUT_GROUPS; no IRD/approval claims.
- [CONV] help file name = helpKey suffix (per tests); no settings.md (no settings page yet).
- Open: in-app HelpPanel rendering and Nepali manual not covered; `/profile` MFA link wording is a placeholder owned by C2.
- Tests: fd-t17 vitest 18/18 pass; copy-scan.mjs clean (99 files).
