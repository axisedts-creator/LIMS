# RS-C3 impl (LD-140; appearance and arrangement only)
- master-ui.tsx: `EditorDialog` now opens a kit `Drawer`; `SaveForm` (non in-page) wraps fields in `FormSection` (kit drawer-section markup, plain "Save" button submits the form; Ctrl+S unchanged). Covers departments, specimens, containers, units, value sets, methods, comment codes, credit parties, doctors, New panel. [CONV] local FormSection, not kit `DrawerSection`: its Save is named "Save <title>", chunk tests t31/t33/t34 need `/^save$/`.
- pricing-ui.tsx: `ActionDialog` gets `drawer` prop (New price list uses it); other ActionDialogs (end rule, tax, surcharge) stay dialogs.
- SpecimensScreen: cap colour = `.catalog-swatch` + name; UnitsScreen/RangesTab/PublishDialog/PriceVersionEditor: emoji removed (units: role=img "Provided by the system" + "System" Badge).
- New `components/catalog.css` (tokens only) replaces all 25 inline styles; route pages use kit `Stack`.
- Ran: rs-c3 24/25 pass; chunk t31 125, t32 107, t33 103, t34 116, t35 96, t38 216 all green; no new tsc errors (pre-existing ones in untouched lines).
- Open: 1 test disputed (RS-C3-dispute.md). Kit has no tube-colour tokens: only red/green/blue/grey/black are painted, other names get a neutral outline (CR candidate). Test-detail 5-tab page (TestTabs) NOT restyled: needs lead ruling vs chunk test t32. Visual snapshots / axe colour-contrast not run.
