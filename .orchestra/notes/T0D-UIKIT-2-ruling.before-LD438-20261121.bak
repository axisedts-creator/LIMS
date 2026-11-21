CR_NEEDED — the spec and the task brief contradict each other on the Card surface; no test edit or implementation can satisfy all of them.
- spec/program/13-M-SERIES.md:55: "Cards, panels, dialogs, drawers | radius 24, white, no border, on neutral.50". m-series-kit.test.tsx:184-200 and ui-r03-kit-pass.test.tsx:133 encode this rule correctly.
- spec/program/10-DESIGN-SYSTEM.md:62: "cards use a hairline **or** elevation 1, never both".
- The brief's done_when 2 (LD-436) asks for a 1px neutral.200 hairline AND elevation.1 AND radius 12 (md). That breaks 13:55 (radius, border) and 10:62 (both together). uikit2.kit.test.tsx:70-75 encodes the brief.
- The same brief's done_when 6 pins m-series-kit green, so the brief contradicts itself.
- An LD can override spec text, but the LD-436/LD-437 text in the inbox is cut off, and the look spec (C:/LIMS-state/ui-plan/LD-436-look.md) is outside the worktree. The arbiter cannot confirm that LD-436 overrides 13:55 and 10:62, or that it retires the m-series-kit pin.
- No ruling on the other contracts (caption, StatusStepper mostWaitingId, state art, ActionList, chevron icon). The dispute does not contest them and they agree with done_when 1, 3 and 4. The writer may implement them now.
- Card surface CSS stays as it is until the lead answers .orchestra/cr/T0D-UIKIT-2.md.
