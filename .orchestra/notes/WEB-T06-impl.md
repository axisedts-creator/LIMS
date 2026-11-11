# WEB-T06 impl (SCR-11 settings)
- New: components/InstrumentSettingsForm.tsx, app/(staff)/instruments/settings/page.tsx, forms/settings.ts (shared validation), server/{getInstrumentSettings,updateInstrumentSettings}.server.ts.
- Edited: server/actions.ts (+updateInstrumentSettingsAction), server/types.ts (+InstrumentSettings[Body]).
- [CONV] "Saved." toast for a save without window change; 400 pointer errors on unknown paths → "Could not save the settings (<code>)"; range text "Enter a whole number from N to M."
- Conflict (409) → banner, edits kept, no retry; version ref updated from each PUT response. No retention field (help text only, from help/instruments.settings.ts).
- Tests: web-t06 config 85/85 pass (2 files). tsc: 0 errors in T06 files; existing errors elsewhere (layout.tsx css, InstrumentForm/Detail, test files). Full suite/lint NOT run.
- Review fix: removed stray root t06.out (not C7-owned); re-ran web-t06 suite 85/85 pass.
- Open: no Reload button on banner (spec silent); nav manifest entry for /instruments/settings not touched.
