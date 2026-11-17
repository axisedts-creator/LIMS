# Tests list and test detail (SCR-06)

Route: `/catalog/tests` and `/catalog/tests/{test_id}`. Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
A test is something a patient can order (alone or inside a panel). It owns its analytes, specimens and turnaround targets.

## List
Columns: Code · Name · Department · Workflow · Orderable alone · Analytes (count) · Status · Revision. Filter by Department, Workflow type and Status, or type in the search box.

## General tab
- **Code**: create only, pattern `^[A-Z0-9][A-Z0-9_\-+.]{0,31}$`, unique across tests and panels.
- **Name** (up to 200), **Department**, **Report order** (0–9999, default 100), **Can be ordered alone** (on by default).
- **Workflow type**: Standard · Narrative report · Microbiology · Anatomic pathology · Molecular · Attachment · Outsourced. Standard is for routine results from analysers; Narrative report is free text with images; Microbiology, Anatomic pathology and Molecular are handled by the specialist module; Attachment means the result is a file; Outsourced means another lab performs it and their PDF is merged into the report. The workflow change is blocked after the first published analyte version.

## Other tabs
- **Specimens**: specimen type, optional container, one preferred row, optional minimum volume in µL. Max 10 rows.
- **Analytes**: rows grouped by sub-heading as on the report. "Add analyte", or Open a row to edit it. Reorder with drag or `Alt+↑/↓`.
- **TAT targets**: Routine and Urgent targets (1 min to 30 days). Segment is "Within lab (received → first verified)" or "Total (registration → report released)". Targets are stored here. Alerts on late tests arrive with the Quality module.
- **Tax**: read-only view of the effective tax rule with a link to Pricing › Tax.
- **Instrument codes**: read-only list, shown only when you hold `catalog.instrument_code_map.manage`. It is privileged, so the system may ask for two-step verification first. Edit mappings in Instruments.

## Keyboard shortcuts
`/` to focus the search, `n` for a new test, `j` / `k` to move between rows, `Enter` to open, `Ctrl+S` to save, `Esc` to close, `?` for the shortcut list.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
