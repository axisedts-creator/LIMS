# Panels and packages (SCR-09)

Route: `/catalog/panels` and `/catalog/panels/{panel_id}`. Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
A clinical panel groups tests that are ordered together (for example a lipid profile). A package is a priced bundle (for example a health check-up).

## List
Columns: Code · Name · Kind (Clinical panel / Package) · Sex restriction · Members (count) · Status. Filter by Kind and Status.

## General
Code, Name (up to 200), Kind, Sex restriction (None/Male/Female), Department (optional), Active. The Kind is set on create only and cannot be changed later.

## Members
A grid: Order · Kind (Test/Panel) · Orderable · Name · Status. Max 100 rows. Search the orderable by code or name.
The "Expanded tests" panel shows a live preview of all tests the panel resolves to and how they group by specimen.

## Packages and price
Packages are priced as one item. Component prices are not added up. Set the package price in the price list like any other orderable.

## Keys
`/` focus search, `n` new panel, `Ctrl+S` save, `Esc` close, `?` shortcut help.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
