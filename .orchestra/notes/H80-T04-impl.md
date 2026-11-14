# H80-T04 impl (writer) — CR-C7-015, LD-139
- Files: `drivers/types.ts` (+`ParsedRecord.inlineAttachment`), `service/ingest.service.ts` (accept() call, attachment in the existing result event, rejection mapping, `uploads`/`storage` on IngestCtx).
- Tests: attachments.inline.test.ts 25/25 pass. Full `src/modules/instruments`: 1850 pass, 5 fail, none touch ingest/types (boot: identity `listRolePacks` handler; ci-scripts registry + synthetic-scan; signing Go copy) — not run on a clean HEAD to confirm pre-existing.
- [CONV] object path `<tenant>/<yyyy>/<mm>/<uuid>.<ext>` (not `q/`: already scanned clean by accept). Not uploaded for shadow instruments. Rejected -> skipped_invalid / quarantined_attachment, core code in row.warnings, message stays accepted. Scanner unavailable or no ctx.uploads -> throw common.internal (retry, object deleted best-effort).
- Open 1 (S7): core accept() cannot re-encode JPEG -> real chromatogram is rejected until C0-0C fixes it. Filed `.orchestra/cr/H80-T04.md` (CR-C7-018).
- Open 2 (S6): driver `truth_h80e` does not yet fill `inlineAttachment` from OBX-5 (outside T04 file list); needs an owner/follow-up task.
- Open 3: object orphaned if a later step in the savepoint fails after accept() (only the unavailable and duplicate_event cases are cleaned). tsc not run clean-checked: no errors reported for touched files.
