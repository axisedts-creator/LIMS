CR_NEEDED — the spec and the task brief contradict each other on the Card surface; no test edit or implementation can satisfy all of them.
- spec/program/13-M-SERIES.md:55: "Cards, panels, dialogs, drawers | radius 24, white, no border, on neutral.50". m-series-kit.test.tsx:184-200 and ui-r03-kit-pass.test.tsx:133 encode this rule correctly.
- spec/program/10-DESIGN-SYSTEM.md:62: "cards use a hairline **or** elevation 1, never both".
- The brief's done_when 2 (LD-436) asks for a 1px neutral.200 hairline AND elevation.1 AND radius 12 (md). That breaks 13:55 (radius, border) and 10:62 (both together). uikit2.kit.test.tsx:70-75 encodes the brief.
- The same brief's done_when 6 pins m-series-kit green, so the brief contradicts itself.
- An LD can override spec text, but the LD-436/LD-437 text in the inbox is cut off, and the look spec (C:/LIMS-state/ui-plan/LD-436-look.md) is outside the worktree. The arbiter cannot confirm that LD-436 overrides 13:55 and 10:62, or that it retires the m-series-kit pin.
- No ruling on the other contracts (caption, StatusStepper mostWaitingId, state art, ActionList, chevron icon). The dispute does not contest them and they agree with done_when 1, 3 and 4. The writer may implement them now.
- Card surface CSS stays as it is until the lead answers .orchestra/cr/T0D-UIKIT-2.md.

=== LEAD ITEM, LD-438 (2026-11-21 21:23 NPT) ===
CR-C0-0D-UIKIT2 decided: option C, scoped to the staff web. The kit base
card does not change.

WHY: the founder picked the M series for the kit (LD-246: card radius
24, no border, no shadow) and later approved the compact staff web look
of LD-436 (card: white, 1px neutral.200 hairline, radius md 12,
elevation.1). Both stand. The kit keeps the M series card and the staff
web shell restyles it, the same way LD-344 and LD-352 already restyle
card padding and title size in apps/web/src/core/shell/shell.css (lines
259 and 260). LD-436 overrides 10-DESIGN-SYSTEM.md line 62 (hairline or
elevation, never both) and 13-M-SERIES.md line 55 for the staff web
only. You make no spec edit.

READ FIRST: the look spec and the two mock sources are copied to
.orchestra/notes/LD-436-look.md, LD-436-mock-today.dc.html and
LD-436-mock-worklist.dc.html (the C:/LIMS-state path in the brief is
closed to you). The mock is the exact visual target.

FILES: apps/web/src/core/shell/shell.css and one new web test under
apps/web/src/core/shell/__tests__/ are added to the files of this task.
The cap of 20 files stays.

TESTER: (1) Do NOT edit m-series-kit.test.tsx or ui-r03-kit-pass.test.tsx.
They stay green and keep pinning the kit base card (radius xl, no border,
no shadow). (2) In uikit2.kit.test.tsx remove the assertions at lines 70
to 75 that expect the hairline, radius md and elevation.1 on the kit.css
lims-card rule, and add a guard that the kit.css lims-card rule is
unchanged (radius xl, no border, no box-shadow). (3) Add
apps/web/src/core/shell/__tests__/uikit2.shell.test.ts, built like
r04.source.test.ts (it reads shell.css as text): a lims-card rule that
sets border 1px solid var(--lims-neutral-200), border-radius
var(--lims-radius-md) and box-shadow var(--lims-elevation-1), each with
the important flag the padding rule on line 259 has; tokens only (no
hex, no px except the 1px border width); no rule that changes
lims-dialog or lims-drawer. (4) Keep every other test as it is: Card
title row and caption, StatusStepper marker, state illustrations,
ActionList, chevron icon, tokens.json hash pin. (5) Read the look spec
and the two mock sources first; where the mock fixes a label, an order
or a class contract that a text test can check, make sure a test covers
it.

WRITER: (1) Implement every contract in the tests: ActionList, Card
title row and caption, StatusStepper marker, the state illustrations and
the chevron-right icon. (2) Card surface: add the rule to shell.css right
after the lims-card padding and title rules, tokens only, with a comment
citing LD-436 R8 and LD-438. Do not change the lims-card rule in kit.css
and leave dialog and drawer as they are. (3) Run the two uikit2 files in
packages/ui, m-series-kit and ui-r03-kit-pass (all must be green) and the
web source tests in apps/web/src/core/shell/__tests__ (m2, m4, r04 and
the new one). (4) Match the mock exactly for the new parts (look spec,
section What each part of the mock is in the kit).
