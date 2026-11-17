# Urgent surcharge rules (SCR-16)

Route: `/catalog/surcharges`. Permission to view: `catalog.price_list.read`; editing needs `catalog.price_list.manage`.

## Purpose
Extra charges added when a test is ordered as Urgent.

## How rules apply
The most specific rule wins: orderable, then department, then all tests. Applies only when the order item is marked Urgent.

## Form
- **Applies to**: All tests, a department or one orderable.
- **Price list**: optional; blank means all price lists.
- **Amount type**: Flat or Percent. Flat is in NPR; Percent is 0.01–1000 %.
- **Effective from**: default now.

## Table
Applies to (All tests / Department / Orderable) · Price list (All or a name) · Amount (for example NPR 200.00 or 50 %) · Effective from · Effective to · Status.

## Ending a rule
Use the "End rule" action and choose the end date. Past orders keep the surcharge they were priced with.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
