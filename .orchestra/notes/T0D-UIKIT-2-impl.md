Files: ActionList/{ActionList,ActionList.stories}.tsx (new), _shared/StateArt.tsx (new), Card/{Card,Card.stories}.tsx, StatusStepper/{StatusStepper,StatusStepper.stories}.tsx, EmptyState, ErrorState, NotAvailable, Icon (chevron-right added), kit.css, apps/web/src/core/shell/shell.css.
[CONV] ActionList hrefs pass the PageHeader safeHref rule (relative / # / ? / http(s)); a javascript: href renders an <a> with no href. Chip and count Badge use the existing lims-tone-* classes.
[CONV] Marker ring = outline (ui-r03 bars box-shadow rings); reduced motion uses transition-duration: 0 (m-series bars `transition: none` and literal 0s).
[CONV] Chip size calc(space-6 + space-1) = 28px (no space-7 token; tokens.json unchanged). EmptyState `icon` prop kept, deprecated, ignored (art replaces it).
shell.css: lims-card border/radius md/elevation.1 !important after the padding rule (LD-436 R8, LD-438) + `.lims-card-head .lims-card-title { margin: 0 !important }`.
Runs (21:38, after test revision): verify set ui 230/230, web 59/59, green. web-style-3 config 3 red (1px card border vs no-px pins) — see T0D-UIKIT-2-dispute.md.
Full packages/ui suite: other failures predate this task (fonts licence/TTF, no-raw-style-literals in apps/web tests, density NaN seen since Nov 18).
Open: stepper done stage keeps the `success` icon (ui-r03 snapshot pin); web feature tests and visual match to the mock not run.
