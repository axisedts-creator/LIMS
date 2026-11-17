Title: CR-C4-FD-T13-combobox-first-option: kit Combobox makes the first option active when the list opens
From chunk: C4            To owner: C0-0D
Type: ui-kit
Blocking? no (FD-T13 works around it in apps/web/src/features/frontdesk/hooks/useEnterPicksFirst.ts; remove the hook when this lands)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
C4 04-UI-UX §3.7 keyboard script and §3.2 A ("↑/↓ moves, Enter selects") need Enter to pick the first search result without pressing ↓ (patient, orderable, referrer search on the registration page; US-FD-03.6). packages/ui/src/components/Combobox/Combobox.tsx (react-aria) opens the list with no active option, so Enter only closes the list.
Proposed change (exact):
Combobox gains an optional prop `autoFocusFirst?: boolean` (default false). When true and the list opens with at least one option, option 1 becomes the active descendant (`aria-activedescendant` set), so Enter selects it; ↑/↓ behave as today.
Backward compatible? yes — opt-in prop, default unchanged.
Tenant/security impact: none.
IRD/regulatory impact (billing changes only): n/a
Alternatives considered: page-side keydown handler (current workaround, duplicated per screen; relies on aria attributes of the kit's internals).
Tests that will prove it: kit Combobox test — type, list opens, Enter selects option 1 with `autoFocusFirst`; and without it Enter does not select. FD-T13 keyboard tests (fd-t13.keyboard.test.tsx) keep passing after useEnterPicksFirst is removed.
