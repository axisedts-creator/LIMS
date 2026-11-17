# WEB-T05 impl
- Files: server/{messages.ts, listInstrumentMessages, searchInstrumentMessages, getInstrumentMessage, getInstrumentMessageRaw, reprocessInstrumentMessage, rematchInstrumentRecord, listMessageRejections}.server.ts + 5 actions in actions.ts; components/{MessagesList, MessageDetail, MessageLabels, RawMessageDrawer, ReprocessDialog, RematchDialog}.tsx; app/(staff)/instruments/messages/{page.tsx,[instrument_message_id]/page.tsx,[instrument_message_id]/attachment/route.ts}.
- Verified 2026-11-11 (after ruling + tester revision ca39433b): WEB-T05-verify config 2 files, 171/171 pass (server + components). tsc: no errors in these files (filtered output).
- [CONV] E37 route: allowlist pdf/png/jpeg/gif/tiff else octet-stream; filename sanitised; 422 → text "This file is not available."; 403/404 mapped; rest 502; redirect:'error'.
- [CONV] Idempotency-Key minted per request content in the dialogs (same content = same key on retry; edited content = new key). Re-match reads the new barcode from the field at confirm.
- [CONV] Texts not in spec: emit labels (Sent/Skipped), scan chips, API error texts (code always shown), "Has unmapped codes", "Enter the new barcode.".
- Open: no Centre filter (no centres source), no cursor paging (first 50), DateRangePicker uses local-day bounds, no Playwright E2E.
