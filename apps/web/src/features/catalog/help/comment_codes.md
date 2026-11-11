# Comment codes (SCR-10)

Route: `/catalog/comment-codes`. Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
Comment codes are short codes for standard result comments, so technologists do not type the same sentence many times a day.

## How technologists use them
Technologists type :CODE followed by a space in the result comment to insert this text. Changing the text later does not change results already saved.

## Table and filters
Columns: Code · Department ("All departments" when blank) · Text (first 80 characters) · Status · Version. Filter by Department or search by code prefix.

## Fields
- **Code**: required, pattern `^[A-Z0-9_]{1,16}$`. Shown upper-case as you type.
- **Department**: optional. Leave blank to make the code available in all departments.
- **Text**: required, 1–2000 characters.
- **Active**: on by default. Inactive codes no longer expand.

## Keys
`/` focus search, `n` new code, `Ctrl+S` save, `Esc` close, `?` shortcut help.
