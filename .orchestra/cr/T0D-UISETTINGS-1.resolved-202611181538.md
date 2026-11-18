Title: CR-C0-0D-UISETTINGS1: raise the 40 file cap of T0D-UISETTINGS-1 to 55 (review item 1)
From chunk: C0-foundation-contracts (lane C0-0D)   To owner: lead
Type: bug (task scope; no schema/api/event change)
Blocking? yes: T0D-UISETTINGS-1 review item 1.
Problem: brief caps the task at 40 files; `git diff --name-only 322ce26e6..HEAD` lists 54 outside .orchestra (26 source for 11 settings screens plus kit SettingsForm/Form/kit.css, 28 tests and the rs-c15 snapshot). The tests were updated by the TESTER per the TESTS_WRONG ruling (old tests pinning pre-LD-353 markup); the writer may not revert them, and reverting screens would leave template 4 (LD-353) undone.
Proposed change (pick one): (a) raise the cap for this task to 55 (same as LD-360 precedent for T0D-UNSLOP-1); or (b) split: keep the kit + frontdesk/engagement/homecollection/quality/inventory/instruments in this task, move lab/micro/partners/payments/anatomic to a follow-up task (requires reverting their source and tests, needs a ruling).
Backward compatible? yes (display only).
Tenant/security impact: none (no route, permission, contract or API change; payments secrets stay write-only).
Alternatives considered: revert screens past the cap (breaks the tester's updated tests, which the writer may not edit).
Tests that will prove it: .orchestra/notes/T0D-UISETTINGS-1-verify.cmd stays green; web-style-3 101/101.
