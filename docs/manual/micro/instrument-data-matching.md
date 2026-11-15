# Instrument data matching

Microbiology instruments send organism identification and AST records. They arrive at /micro/instrument-records and are matched to a culture and isolate.

## How a record is matched

The system looks up the specimen from the barcode on the record and the isolate number. When both are found, the record is matched and applied. Applied values keep the raw value and the interpretation the instrument sent, with its standard and version.

## Statuses

- Waiting for match: no culture found yet. This often clears when the culture is set up.
- Needs mapping: the instrument organism or antibiotic code is not mapped. Add the mapping in Micro settings.
- Conflict: the isolate already holds a different value.
- After final: the record arrived after the final report.
- Applied and Ignored: finished.

## Matching by hand

An unmatched record stays in the list until someone assigns it or ignores it. Choose Assign to culture, scan the specimen barcode, choose the culture, enter the isolate number and press Assign. Then choose Apply.

## Resolving a conflict

The dialog shows the instrument value and the current value side by side. Choose Use instrument value or Keep current value. The choice is recorded.

## Ignoring a record

Choose Ignore, pick a reason (for example duplicate, wrong sample or a QC or test run), and add a comment if useful. An ignored record is kept for audit and can be seen by selecting the Ignored status.

## After the final report

A record marked After final cannot change a sent report. Reopen the culture for amendment first; see [Amendments](amendments.md). Then apply the record.
