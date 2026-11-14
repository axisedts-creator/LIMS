# Departments (SCR-02)

Route: `/catalog/departments`. Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
Departments group tests on the report (for example Haematology, Biochemistry). The report order and heading decide where each department prints.

## Table and filters
Columns: Code · Name · Report order · Report heading · Status · Updated. Filter by Status (Active/Inactive/All) or search code and name. Use the row action Edit to open the drawer.

## Fields
- **Code**: required, letters A–Z, digits and underscore, pattern `^[A-Z0-9][A-Z0-9_]{0,31}$` (max 32). You set the code on create only; it is read-only after create. Codes are shown upper-case as you type.
- **Name**: required, up to 100 characters.
- **Report order**: whole number 0–9999, default 100. Lower numbers print first.
- **Report heading**: optional, up to 100 characters.
- **Active**: switch, on by default.

## Messages
- Create button: "New department". After saving: "Department saved."
- "This code is already used." means another department has the same code. Choose another code.
- "Someone else changed this item. Reload to see their changes." Press Reload; your input stays until you reload.

## Keyboard shortcuts
- `/` to focus the search box.
- `n` to create a new item (when permitted).
- `j` / `k` move the row focus; `Enter` opens the focused row.
- `Ctrl+S` saves the open form; `Esc` closes the drawer.
- `?` opens the shortcut help.
