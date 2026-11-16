CHANGES

Scope: `git diff 72e037a8b..HEAD` (T0D-MSERIES-1). Re-ran `.orchestra/notes/T0D-MSERIES-1-verify.cmd` parts: packages/ui 9 files 315/315 pass; apps/web rs-c6.static 26/26 pass.

Verified OK: tokens.json values match 13 s2.1 verbatim (accent.pop the only new name; neutral.300 unchanged), font stack s2.2, radius.xl 24 / full, button 48, field 46, compact 40, motion 150/450 + cubic-bezier(.2,.7,.2,1), reduced-motion zeroes duration tokens in tokens.css; Poppins 5.3.0 woff2 400-700 + OFL, Jakarta woff2/licence/fonts.css rules gone, no CDN; dialog/drawer/card radius xl; tabs/chips/btn/input pill, textarea/RTE/grid cells md; `.num` -> Noto Sans after digit-width test; 4 logos added; accent.ts default #005A52. No secrets, no PHI, no RLS/API surface touched.

1. apps/web/src/core/shell/shell.css:19 — active nav item `a[aria-current='page']` still renders `color: var(--lims-accent)` on `background: var(--lims-accent-highlight)`. With this change's values that is #005A52 on #A0C032 = 3.90:1, below WCAG AA 4.5 for text (13 s2.1: "Text on it #00362F"; LD-251 "the contrast gate wins over a board"). The diff removed exactly this pair from contrast-pairs.json, so the gate no longer catches a live consumer this task made fail. Fix: change shell.css:19 `color: var(--lims-accent);` to `color: var(--lims-neutral-900);` (8.59:1, the pair already declared in contrast-pairs.json). shell.css is not in this task's file list, so per the brief write `.orchestra/cr/T0D-MSERIES-1.md` (CR template, spec/program/04-CHANGE-REQUESTS.md) asking the lead to allow this one-line edit in this task, then apply it once approved (or have the lead confirm MSERIES-2 lands it before staging).

Non-blocking, for the lead:
- packages/ui-flutter/test/restyle_r05_test.dart:123-143 (and tokens_theme_test.dart) pin #0E4B3B / Plus Jakarta Sans and will fail against the regenerated tokens.g.dart; MSERIES-3 (C0-0F) must merge with or right after this.
- `pnpm -s verify` red on pre-existing typecheck errors in @lims/api, @lims/worker, @lims/web (not in touched files); not re-run by reviewer.
- Display 40 / section 20 sizes have no token (names fixed, so not added) — acceptable.
- Poppins publish date (2026-07-19) not independently checked against the registry.
