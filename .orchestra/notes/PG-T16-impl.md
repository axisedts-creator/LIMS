# PG-T16 impl (writer)
- Added `service/staticqr.service.ts`: `createStaticQrService({newId?})` -> list (P17) / preview (P18) / create (P19) per the tester seam.
- Edited `service/reconciliation.service.ts`: only added `export` to dateText, isDate, moneyDto, pageLimit, decodeCursor, page, Key (reuse, no logic change).
- [CONV] system figures = `SELECT COALESCE(SUM(..),0)` from billing.v_pub_payment_collection, re-read at save; INSERT ... ON CONFLICT DO NOTHING RETURNING * -> empty = `payments.static_qr_already_reconciled`; FK 23503 -> validation_failed(centre_id).
- [CONV] list: whole filtered set read, keyset in JS (cursor = [business_date, id], newest first); whitespace-only note = no note, stored trimmed; guardActor first.
- Run: staticqr + staticQrDb suites green; full `src/modules/payments` 1147 pass, 1 fail = `manifest.test.ts` PHASE_STUBS (SmartReportPort missing) — unrelated to T16, untouched.
- Open: real-PG/RLS/race not covered by the fake; tsc shows only pre-existing errors in contracts/ and shared-ts, none in my files.
