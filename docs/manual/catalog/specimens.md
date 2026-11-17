# Specimen types and containers (SCR-03)

Route: `/catalog/specimens` (tabs). Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
Specimen types (blood, urine, serum and so on) and containers (tubes and cups) that tests need. Registration uses them to tell staff which tube to draw.

## Specimen types tab
- **Code**: pattern `^[A-Z0-9][A-Z0-9_]{0,31}$`, create only; read-only after create.
- **Name**: required, up to 100 characters.
- **Report label**: required, up to 100 characters. It is printed on the report as "Specimen: …". Default is the name in upper case.
- **Active**: on by default.

## Containers tab
- **Code** and **Name** as above.
- **Additive**: optional, up to 60 characters (for example EDTA).
- **Default specimen type**: optional, chosen from active specimen types.
- **Cap colour**: optional free text, display only (up to 40 characters). It does not drive any logic.

## Messages and keys
- "This code is already used." means the code exists already.
- `/` focus search, `n` new item, `Ctrl+S` save, `Esc` close the drawer, `?` shortcut help.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
