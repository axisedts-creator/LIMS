# Catalog and pricing — user manual

This manual covers every screen of the Catalog and Pricing areas. Each screen also has an in-app help button in its page header that opens the same text.

## Catalog screens
- [Catalog home and health report (SCR-01)](home.md)
- [Departments (SCR-02)](departments.md)
- [Specimen types and containers (SCR-03)](specimens.md)
- [Methods (SCR-04)](methods.md)
- [Units and value sets (SCR-05)](units.md)
- [Tests list and test detail (SCR-06)](tests.md)
- [Analyte editor (SCR-07)](analyte.md)
- [Reference ranges and critical limits (SCR-08)](ranges.md)
- [Panels and packages (SCR-09)](panels.md)
- [Comment codes (SCR-10)](comment_codes.md)
- [Doctors (SCR-11)](doctors.md)
- [Excel import/export and import detail (SCR-18, SCR-19)](imports.md)

## Pricing screens
- [Credit parties and affiliations (SCR-12)](credit_parties.md)
- [Price lists (SCR-13)](price_lists.md)
- [Price list detail (SCR-13)](price_list.md)
- [Price-list version editor (SCR-14)](price_list_version.md)
- [Price simulator (SCR-15)](price_simulator.md)
- [Urgent surcharge rules (SCR-16)](surcharges.md)
- [Tax rules and tax types (SCR-17)](tax.md)

## For operators and developers
- [Integration guide for consumer modules](integration.md)
- [Runbook: catalog alerts](runbook.md)

## Onboarding checklist (before go-live)
1. Configure a lab default tax rule before go-live, with the VAT treatment your auditor confirms (Pricing › Tax). Until it exists, prices cannot be quoted (`catalog.tax_config_missing`) and the home page shows "Tax default configured: No".
2. Create departments, specimen types, containers, methods and units.
3. Import or create tests, analytes, reference ranges and panels.
4. Publish the default price list and check it in the price simulator.
5. Open the catalog home: every Needs attention count should be 0.

## Keyboard
Press `?` on any catalog screen to open the shortcut list. Common keys: `/` focus search, `n` new item, `j`/`k` move rows, `Enter` open, `Ctrl+S` save, `Ctrl+Enter` confirm a dialog, `Esc` close.
