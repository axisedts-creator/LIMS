Title: CR-C0-T0D-NAV-COMPLETE-1.1: nav-table screens whose staff page does not exist (no nav entry until the page ships)
From chunk: C0 (C0-0D)            To owner: C4, C5, C16
Type: bug
Blocking? no  (T0D-NAV-COMPLETE-1 ships the entries whose page exists; LD-250 forbids stubbing a page)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
The chunk navigation tables name these screens, but apps/web/src/app/(staff) has no page.tsx for them, so no nav entry was added:
- C4 04-UI-UX s8.11: /frontdesk/settings (frontdesk.settings.manage; discount self-limit and absolute max percent). Founder (LD-246, LD-250) wants this in the administrator navigation; it needs a page task.
- C5 04-UI-UX s1: /lab/worklists (lab.worklist.read; only /lab/worklists/{department_id} exists).
- C5 04-UI-UX s1: /lab/critical-values (lab.critical_value.read; only /lab/critical-values/{critical_event_id} is in routes.yaml, no page).
- C16 04-UI-UX s1.3: /engagement/settings (engagement.settings.manage; route staff.engagement.settings exists, page does not).
Proposed change (exact): the owning chunk builds the page; then add the manifest entry (path, permission, group, order from the spec table) and, for C4 and C5, one non-parameterised staff_web row in contracts/routes.yaml.
Backward compatible? yes
Tenant/security impact: none (pages are permission-gated by their route row; no new permission)
IRD/regulatory impact: none
Alternatives considered: stub pages (rejected by LD-250).
Tests that will prove it: the T0D-NAV-COMPLETE-1 per-feature tests flip from "absent + CR" to "entry present" once page.tsx exists.
