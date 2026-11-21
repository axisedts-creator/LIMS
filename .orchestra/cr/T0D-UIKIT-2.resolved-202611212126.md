Title: CR-C0-0D-UIKIT2: Card surface — LD-436 hairline + elevation.1 + radius 12 vs M-series radius 24, no border, no shadow
From chunk: C0-0D            To owner: C0-0D (lead / founder as doc owner)
Type: ui-kit
Blocking? yes — T0D-UIKIT-2 done_when 2 vs done_when 6 (m-series-kit pin); task has no row in spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md
Problem: done_when 2 (LD-436) needs `.lims-card` { border: 1px solid neutral.200; border-radius: radius.md (12); box-shadow: elevation.1 }. The spec says otherwise:
  - spec/program/13-M-SERIES.md:55 — cards radius 24, no border.
  - spec/program/10-DESIGN-SYSTEM.md:62 — a card has a hairline or elevation 1, never both.
  Pinned tests that encode the spec: packages/ui/src/components/__tests__/m-series-kit.test.tsx:184-200, ui-r03-kit-pass.test.tsx:133. done_when 6 requires m-series-kit to stay green.
  New test that encodes the brief: uikit2.kit.test.tsx:70-75. No CSS passes both.
  The LD-436/LD-437 text in the inbox is truncated, and the look spec C:/LIMS-state/ui-plan/LD-436-look.md cannot be read from the lane.
Proposed change (exact), pick one:
  (A) LD-436 wins. Amend 13-M-SERIES.md:55 for cards to "radius 12 (md), 1px neutral.200 hairline, elevation.1". Amend 10-DESIGN-SYSTEM.md:62 to allow hairline + elevation 1 on cards. Dialogs and drawers keep radius 24 and elevation.3. Tester updates m-series-kit:184-200 (card part only) and ui-r03:133 ('.lims-card','md'). uikit2.kit:70-75 stays.
  (B) The spec wins. The tester drops the border/radius/shadow asserts in uikit2.kit:70-75. Card stays radius 24, borderless, unshadowed. done_when 2 is read as the title row only.
  (C) Additive modifier `.lims-card--hairline` (radius md, hairline, elevation.1) for mock screens. Base `.lims-card` unchanged. The pins stay green. uikit2.kit:70-75 retargets to the modifier. This still needs 10:62 amended if it keeps both hairline and elevation.
Backward compatible? (A) no: every screen that uses Card changes look, and the shell pins m-series-kit and ui-r03 change. (B) yes. (C) yes.
Tenant/security impact: none (display only; no RLS, PHI or public surface).
IRD/regulatory impact: n/a.
Alternatives considered: the arbiter picking a side. Rejected: the full LD-436 text and the look spec are unavailable, and both sides cite binding sources.
Tests that will prove it: m-series-kit.test.tsx, ui-r03-kit-pass.test.tsx and uikit2.kit.test.tsx all green on the chosen option. Card snapshot on the kit docs page.
