APPROVE

Round 2. Re-ran `pnpm --dir packages/ui exec vitest run scripts/__tests__/no-raw-style-literals.test.ts`: 42/42 pass (real tree clean outside pending list).
- Round-1 defect fixed: test:211 regex now allows `(group)`/`[param]` segments; `..`, ROOTS and is-directory checks kept. Pending entry narrowed to `apps/web/src/app/(staff)/catalog`, so other web routes are now linted.
- Paths owned (packages/ui/scripts + own notes), no secrets/PHI, nothing invented, planted-literal scratch-tree case fails as required, generated token files excluded. done_when and 10-DESIGN-SYSTEM s7/s8 covered.
- Note (not a defect): `apps/portal/src/app` stays whole because its only hit is `portal.css` at the app root and entries must be directories. This also exempts `phlebo/`, `r/`, `v/`; the lead should drop the line once the portal restyle fixes portal.css.
