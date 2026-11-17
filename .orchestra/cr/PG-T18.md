Title: CR-C15-PG-T18: kit FilterBar `MultiSelect` needs per-option `isDisabled`
From chunk: C15           To owner: C0 (packages/ui, FilterBar)
Type: port
Blocking? no — gateway filter ships as a single select meanwhile
Problem: C15 04-UI-UX.md:31 makes the review-queue `gateway` filter "select multiple" and requires a disabled "Fonepay — not available yet" entry. packages/ui/src/components/FilterBar/FilterBar.tsx:11 types select options as `{ value; label }` only, and `MultiSelect` (:26) cannot render a disabled option. So gateway cannot be multi-select with the required disabled entry.
Proposed change (exact): select FilterDef options become `readonly { value: string; label: string; isDisabled?: boolean }[]`; `MultiSelect` passes the disabled keys to the react-aria ListBox (`disabledKeys`), single `Select` keeps honouring `isDisabled`.
Backward compatible? yes — optional field.
Tenant/security impact: none.
IRD/regulatory impact: none.
Alternatives considered: drop the Fonepay entry (violates 04-UI-UX:31); keep single select (current, loses multi-gateway filtering).
Tests that will prove it: FilterBar test — multiple select with one `isDisabled` option renders it `aria-disabled="true"` and it cannot be selected. C15: switch gateway to `multiple: true` in ReviewQueue.tsx and revise pg-t18.review.test gateway assertions.
