# T0D-MSERIES-4 survey (LD-266): .lims-input / .lims-select in column flex parents (notes only, no edits outside shell)
Rule: `.lims-input { flex: 1 }` (kit.css) grows only when its column-flex parent has a definite height with free space. `.lims-select` is not a separate class in kit (`.lims-select-trigger` is row flex, no flex: 1); selects in apps/web reuse `.lims-input`.
- FIXED: apps/web/src/core/shell/shell.css `.lims-rail` > `.lims-rail-search` (rail fills the 100dvh sidebar) -> `flex: none`.
- At risk (definite height, none found holding a field today): apps/web/src/core/shell/shell.css `.lims-shell-nav` (100dvh column; holds only `.lims-rail`).
- Column flex, auto height, no stretch today (would stretch if someone later gives the parent a fixed/100% height):
  - apps/web/src/core/shell/shell.css `.lims-auth-card`, `.lims-auth-card form` (LoginForm.tsx, ForgotPasswordForm.tsx, MfaEnrolment.tsx, PasswordField.tsx).
  - apps/web/src/features/frontdesk/components/frontdesk.css `.lims-reg-main`, `.lims-reg-section`, `.lims-reg-fieldset`, `.lims-reg-pay-row`, `.lims-reg-summary` (sticky, auto height).
  - packages/ui kit.css (not apps/web, for reference) `.lims-field`, `.lims-form`, `.lims-stack`, `.lims-dialog-body`, `.lims-drawer-section`: every apps/web field sits in these; drawers/dialogs use max-height + overflow, not a definite height.
- Recommendation (open): if a fixed-height column panel ever holds a field, add `flex: none` on that field locally, as here.
