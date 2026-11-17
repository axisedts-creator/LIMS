# Units and value sets (SCR-05)

Route: `/catalog/units` (tabs). Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
Units (g/dL, mmol/L and so on) are used by numeric analytes. Value sets are lists of allowed answers for ordinal and coded results (for example Negative, Trace, 1+, 2+).

## Units tab
Columns: Code · Display · Scope (Global/Lab) · Status. Global rows have a lock icon and the tooltip "Provided by the system"; they are read-only. Use "New lab unit" to add your own:
- **Code**: pattern `^[A-Za-z0-9_]{1,32}$`.
- **Display**: up to 32 characters, for example `10^3/µL`.

## Value sets tab
Columns: Code · Display · Ordered (Yes/No) · Values (count) · Scope. The editor has Code, Display, an **Ordered** switch and a values grid: Code (up to 16, pattern `^[A-Z0-9_+\-]{1,16}$`) · Display (up to 40) · Order · Active.
- An ordered set is required for ordinal analytes; the order goes from lowest to highest.
- When a set is in use by a published analyte, the Order column and row delete become read-only and a banner explains why. Add new values instead.

## Keys
`/` focus search, `n` new item, `Ctrl+S` save, `Esc` close, `?` shortcut help.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
