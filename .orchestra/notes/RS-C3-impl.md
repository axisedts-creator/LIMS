# RS-C3 impl (LD-140; appearance and arrangement only)
- master-ui.tsx: `EditorDialog` now opens a kit `Drawer`; `SaveForm` (non in-page) wraps fields in `FormSection` (kit drawer-section markup, plain "Save" button; Ctrl+S unchanged). Covers departments, specimens, containers, units, value sets, methods, comment codes, credit parties, doctors, New panel. [CONV] local FormSection, not kit `DrawerSection`: its Save is named "Save <title>", chunk tests t31/t33/t34 need `/^save$/`.
- pricing-ui.tsx: `ActionDialog` gets `drawer` prop (New price list uses it); end rule, tax, surcharge stay dialogs.
- SpecimensScreen: cap colour = `.catalog-swatch` (aria-hidden) + name in `.catalog-colour-cell` (wrapper renamed so the first `[class*=swatch]` is the swatch). Emoji removed in Units/Ranges/Publish/PriceVersionEditor.
- New `components/catalog.css` (tokens only) replaces inline styles; route pages tests/ and tests/[test_id] now use kit `Stack` (were still inline).
- Ran (after ruling): rs-c3 25/25; chunk t31 125, t32 107, t33 103, t34 116, t35 96, t38 216 all green; no tsc errors in touched files.
- Open: kit has no tube-colour tokens (only red/green/blue/grey/black painted; others neutral outline, CR candidate). Test-detail 5-tab page (TestTabs) not restyled: needs lead ruling vs t32. Visual snapshots / real-browser axe contrast not run.
