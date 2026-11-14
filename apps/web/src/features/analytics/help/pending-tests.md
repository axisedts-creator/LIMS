# Pending tests

## Purpose
A live list of work that is not finished, so you can chase delays. It has no period selector because it shows the situation right now.

## Metrics
- **Pending tests (M50)**: tests that are awaiting collection, awaiting receipt, in process, resulted or verified.
- **Overdue (M51)**: pending tests older than their turnaround target. Tests with no target are counted separately as "No TAT target".
- **Reports pending (M52)**: a snapshot, up to 10 minutes old, of registered orders with no report released.
- **Age**: age since receipt at the lab, or since registration if not yet received.

The list shows department, test, priority, status, centre, age and target. It has no patient name, number or barcode. "Open" appears only where you may open the item. Filters: department, priority, status, overdue only, processing branch. Newest or oldest age first.

## Freshness
Pending tests are live. Reports pending is a snapshot and shows "Updated {time}". If it says "Data may be out of date", the snapshot is behind.

## Centre scope
You only see items from centres you have access to. Users with access to all centres see all pending items.

## Time zone
Ages are exact durations and do not depend on the calendar. Times shown are in Nepal time (UTC+05:45).
