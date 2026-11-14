# Catalog home and health report (SCR-01)

Route: `/catalog`. Permission: `catalog.test.read` or `catalog.price_list.read`.

## Purpose
The starting page of the catalog. It shows counts of what is set up and lists the problems that stop tests from being ordered, priced or reported correctly. Use it every morning during setup and after every Excel import.

## What you see
- Tiles: Tests (active), Panels & packages, Doctors (the unverified count is highlighted), Price lists, Catalog revision.
- The **Needs attention** section is the health report. Each line is a link to a filtered list:
  - Active orderables without a default price (n)
  - Analytes without a reference range (n)
  - Tests without a specimen type (n)
  - Tests missing their narrative/attachment analyte (n)
  - Tax default configured: Yes/No
  - Formulas referring to inactive analytes (n)
- Buttons "Import from Excel" and "New test" appear only when you hold the matching permission.

## Tips
- If "Tax default configured" says No, prices cannot be quoted. Open Pricing › Tax and add a lab default tax rule first.
- Work the list from top to bottom; every count should reach 0 before go-live.
- Press `?` to open the keyboard shortcut list.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
