# Reports worklist

Address: `/reporting`. Permission to open: `reporting.report.read`.

## Purpose

The worklist shows every report that is waiting for something, ready to go out, held, or already released. Use it to work through the day.

The Critical alerts panel sits above the tabs. It lists critical results from the last 24 hours and who was told. It never shows a result value or a patient name.

## Tabs

Six tabs split the list: Awaiting content, Ready to release, Held (dues), Render failed, Released today, and All. Switch tabs with `Alt+1` to `Alt+6`. The list refreshes itself about every 30 seconds.

## Fields

- **Reg no**: opens the report.
- **Patient**, **Centre**, **Family** (Lab or Narrative).
- **Items**: ready items out of all items, for example 7/9.
- **Status**: the report status. Held reports show the amount due.
- **Version**: the latest version, for example v2.
- **Registered**, **Updated**: order time and last change time.
- **Filters**: centre, family, registered date range (at most 31 days), and review flag.
- **Registration no. or barcode**: type or scan. One match opens the report; several matches filter the table; no match shows "No report found for this barcode". Barcode search needs the lab specimen read permission. Without it the box reads "Registration no." and a scan tells you to enter the registration number instead.

## Steps: release several reports

1. Open Ready to release (or Held (dues)).
2. Tick the rows. The Release button appears with the count, for example Release 12. It only appears if you have the bulk release permission.
3. Press the button or `Alt+R`. A confirmation opens.
4. Confirm. The most reports you can release at once is set on the settings screen (see [settings.md](settings.md)).

Reports with dues stay held unless someone with permission has recorded an override on the report page.

## Shortcuts

- `Alt+1` to `Alt+6`: switch tab.
- `/`: focus the registration no. or barcode search.
- `Alt+R`: bulk release the selected reports (opens a confirmation).

Shortcuts are off while you are typing with an input method editor.
