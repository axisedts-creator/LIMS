APPROVE
Scope 76e73aa1..HEAD: test revisions per the ruling (behaviour.test.tsx, fixtures.tsx) plus notes. No impl, API, route, permission or server change; all paths owned (apps/web/src/features/payments/**).
- chipsAreComplete skips `.lims-chip[role="option"]`: matches FilterBar.tsx:42 (react-aria ListBoxItem). Per-row Status chip assertions kept.
- A3 uses aria-checked instead of the unregistered toBeChecked matcher. Same intent.
- Keyboard tests: Tab into the grid, then arrow keys, as C0 04-UI-UX:214 requires. Mouse never used; the U(101) href is still pinned.
- Ruling said "Escape closes"; test closes via keyboard Cancel because ConfirmDialog.tsx:60 is isDismissable={false} (kit overlays.test.tsx:73 confirms). Justified, keyboard-only path intact.
- No PHI/secrets; no RLS/DB surface in this task (UI restyle, LD-140).
Verified: CI=true vitest rs-c15 config 41/41 pass (reviewer run). Not run: tsc/lint, pg-t18/pg-t19 (writer reports green), real-browser contrast.
