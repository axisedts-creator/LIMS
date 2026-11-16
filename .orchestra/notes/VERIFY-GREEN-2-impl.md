# VERIFY-GREEN-2 impl (writer)
- Files: services/api/src/modules/catalog/ports/CatalogPort.impl.ts, services/api/src/modules/partners/service/conversion.service.ts. No test, mapper, tsconfig or contract edits.
- Types only (LD-268): `asCtx()` helper (RequestContext -> Ctx, identity) replaces 17 `x as Ctx`; Uuidv7/DecimalString/IsoDate brand casts at definitionOf, panelDef, canonical, unitConversion.factor, birthOn, referrerId; `as unknown as` on resolveOrderables arrays and Reference/CriticalLimits matches. [CONV]
- No emitted value, rounding, status, SQL or object identity changed (asCtx returns the same object, so the revisions WeakMap key is unchanged). No money/order code touched. No new mapper edit, so no new equivalence test; existing pins (vg2.buildBookingOrderInput, contract tests) cover the lines.
- api tsc: 66 before -> 38 after (28 fewer = 26 catalog + 2 partners); 0 errors in modules/catalog and modules/partners. Log: .orchestra/notes/vg2-tsc-after.log not written (tee blocked); counts from `tsc --noEmit -p services/api/tsconfig.json`.
- Tests: vitest src/modules/catalog + src/modules/partners: 121 files passed, 7324 passed, 2 skipped (incl. vg2 typecheck gate).
- Open: `turbo run typecheck --continue` for worker/web not re-run (out of this task); no runtime-shape questions found, so no CR.
