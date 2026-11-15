# Micro instrument data

## Purpose

Review identification and AST results sent by microbiology instruments, match each record to the right culture and isolate, and apply or ignore it. The page is at /micro/instrument-records.

## Steps

1. Filter by status (Waiting for match, Needs mapping, Conflict, After final, Applied, Ignored), instrument or received date. The first four statuses are shown by default.
2. For a record that did not match automatically, use Assign to culture: scan the specimen barcode, choose the culture, enter the isolate number, then Assign.
3. Use Apply to write the record into the isolate. The value is stored as received, with the interpretation and standard the instrument sent.
4. If the isolate already has a different value, use Resolve conflict and choose Use instrument value or Keep current value.
5. If a record must not be used, choose Ignore and pick a reason. A comment is optional.

## Notes

- A record that arrives after the final report is marked After final. Reopen the culture for amendment before applying it.
- A code the lab has not mapped shows Needs mapping. Add the mapping in Micro settings, then apply again.
- An ignored record stays in the list for audit; it is never deleted.

## Error messages

- "You don't have access to this screen." — your role does not include microbiology. Ask your administrator.
