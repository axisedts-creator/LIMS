# H80-T03 impl (writer)
- `drivers/truth_h80e/hostQuery.ts` (extractHostQueryBarcodes, buildHostQueryReply); `index.ts`: parse() of QRY returns one host_query record (QRD-8.1). Status stays `generic` (LD-139).
- [CONV] Empty/>40 barcode => message_malformed; OK only when answers[0] is `found` with tests > 0, else NF (QCK only). DSR has no test list.
- Review fix 2: MSH-3/MSH-4 of QCK and DSR now `LIS` / `LIMS` (§6 defaults); `Truth`/`Truth-H80E` removed.
- Review fix 1: CR-C7-018 filed as `.orchestra/cr/H80-T03.nonblocking.md` (optional DSP-1/2/3/4/13 + Latin name on HostQueryAnswer; ack_sending_* not reachable via DriverContext). Interim empty DSPs cited in hostQuery.ts header. Named `.nonblocking` per cr/ convention (review asked for H80-T03.md).
- [CONV] DSP-22 from option host_query_detection_mode (0/1/2, else 0); MSH-7 = ctx.receivedAt in instrument tz (UTC fallback).
- Run: hostQuery.truth_h80e.test.ts 34/34 pass; tsc clean for truth_h80e; ESLint config matches no file here (not linted).
- Open: review item 3 (move fixtures to drivers/truth_h80e/testdata/) is tester-owned, not done yet.
