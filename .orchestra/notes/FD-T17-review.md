APPROVE

FD-T17 review (diff 434f6336..99fefd83).
- Spec 04-UI-UX §11: help/<screen>.md exists for all 5 frontdesk PageHeader helpKeys (registration, order, patient, worklist, discount_approvals), each with Purpose / Fields / Shortcuts sections. docs/manual/frontdesk/ mirrors them and covers all 5 routes.
- Copy matches shipped components: SHORTCUT_GROUPS keys, the 500-character reject note, the 10 s poll (POLL_MS), and Ctrl+Enter on the dialogs. No IRD or approval overclaims and no "commission" wording.
- Paths: only owned paths (frontdesk help, docs/manual/frontdesk, frontdesk __tests__, .orchestra/notes). No PHI, no secrets, no new names (routes copied from §3–§7).
- Ran: fd-t17 vitest 18/18 pass; copy-scan.mjs "99 files clean".
- Not blocking: the shipped copy-scan.mjs summary does not list frontdesk help/manual. The fd-t17 test does its own line-level banned-word scan over them, so done_when is still met. J-T03 should add these paths to the CI scan job.
- Not covered (out of task scope): HelpPanel rendering, Nepali manual (§11 defers it), settings help (no settings page yet).
