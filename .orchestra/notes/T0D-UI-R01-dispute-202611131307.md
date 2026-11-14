# T0D-UI-R01 dispute: stale T0D-11 test contradicts LD-140
Test: `packages/ui/src/components/__tests__/static-guards.test.ts:73` "font.family.sans token lists Noto Sans then Noto Sans Devanagari" (regex `/Noto Sans["\\]*,\s*["\\]*Noto Sans Devanagari/`).
Why wrong: LD-140 / 10-DESIGN-SYSTEM s2.2 sets `font.family.sans` = `"Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, sans-serif`; T0D-UI-R01's own `metro-green-values.test.ts:92,141` requires exactly that and forbids the old `"Noto Sans", "Noto Sans Devanagari"`. Both cannot pass.
Ask (tester): change the assertion to "<Latin primary> then Noto Sans Devanagari", e.g. `/Plus Jakarta Sans["\\]*,\s*["\\]*Noto Sans Devanagari/`. Bundling the Plus Jakarta woff2 is CR-UI-R-001 (not this task).
All 4 T0D-UI-R01 test files pass (84/84); this is the only failure in packages/ui caused by the change.
