Title: CR-C0-T0D-MSERIES-1: allow one-line contrast fix in apps/web/src/core/shell/shell.css (active nav item text colour)
From chunk: C0 (lane C0-0D, task T0D-MSERIES-1)            To owner: C0-0D (lead)
Type: ui-kit
Blocking? yes — T0D-MSERIES-1 review item 1 (.orchestra/notes/T0D-MSERIES-1-review.md) cannot be closed inside the task file list.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  apps/web/src/core/shell/shell.css:19 renders the active nav item `a[aria-current='page']` as `color: var(--lims-accent)` on `background: var(--lims-accent-highlight)`.
  With the M series values from this task (13-M-SERIES s2.1, LD-251) that is #005A52 on #A0C032 = 3.90:1, below WCAG AA 4.5:1 for text
  (10-DESIGN-SYSTEM s2.6 contrast gate; 13 s2.1 "Text on it #00362F"; LD-251 "the contrast gate wins over a board").
  The pair accent.default on accent.highlight was removed from contrast-pairs.json in this task, so the gate no longer catches this consumer.
  shell.css is not in the T0D-MSERIES-1 file list, so the writer may not edit it.
Proposed change (exact):
  apps/web/src/core/shell/shell.css:19
  - .lims-shell-nav a[aria-current='page'] { background: var(--lims-accent-highlight); color: var(--lims-accent); border-radius: var(--lims-radius-full); font-weight: var(--lims-font-weight-semibold); }
  + .lims-shell-nav a[aria-current='page'] { background: var(--lims-accent-highlight); color: var(--lims-neutral-900); border-radius: var(--lims-radius-full); font-weight: var(--lims-font-weight-semibold); }
  neutral.900 on accent.highlight = 8.59:1, already declared in packages/ui/tokens/contrast-pairs.json (line 30: color.neutral.900 on color.accent.highlight, kind text).
  Alternative acceptable to the writer: lead confirms T0D-MSERIES-2 (staff shell, lane C0-0E) lands this before staging, and this CR closes as "deferred to MSERIES-2".
Backward compatible? yes — CSS colour only; token reference, no raw colour; no contract, action, session, MFA, authorisation or BFF change.
Tenant/security impact: none. No RLS change, no PHI field, no new public surface.
IRD/regulatory impact (billing changes only): n/a
Alternatives considered:
  1. Re-add accent.default on accent.highlight to contrast-pairs.json: it would fail the gate (3.90:1), so no.
  2. Change accent.highlight value: forbidden, 13 s2.1 values are fixed by this task.
  3. Defer to MSERIES-2: leaves staging with an AA failure until MSERIES-2 merges.
Tests that will prove it:
  apps/web rs-c6.static test (or a new static check) asserting the active nav item colour references --lims-neutral-900; packages/ui contrast test already covers neutral.900 on the highlight background.
