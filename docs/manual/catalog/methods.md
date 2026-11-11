# Methods (SCR-04)

Route: `/catalog/methods`. Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
Methods describe how an analyte is measured (for example Photometry, ELISA). When an analyte has a method, the report prints it as `METHOD : <name>` under the result.

## Table
Columns: Code · Name · Status · Updated. Filter by status and search by code or name. Use Edit to open the drawer.

## Fields
- **Code**: required, pattern `^[A-Z0-9][A-Z0-9_]{0,31}$`, set on create only and read-only after create.
- **Name**: required, up to 120 characters. This is the text printed after "METHOD :".
- **Active**: on by default. An inactive method cannot be chosen for new analyte versions; published versions keep it.

## Messages and keys
- "This code is already used." means another method has that code.
- If someone else saved first you see "Someone else changed this item. Reload to see their changes."
- `/` focus search, `n` new method, `Ctrl+S` save, `Esc` close, `?` shortcut help.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
