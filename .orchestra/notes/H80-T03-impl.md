# H80-T03 impl (writer)
- New `drivers/truth_h80e/hostQuery.ts` (extractHostQueryBarcodes, buildHostQueryReply); `drivers/truth_h80e/index.ts`: parse() of QRY returns one host_query record (QRD-8.1), wires both functions. Status stays `generic` (LD-139).
- [CONV] parse() rejects empty/>40 barcode as message_malformed; extract throws LimsError message_malformed if no host_query record. Reasons constant, no barcode.
- [CONV] OK only when answers[0] is `found` with tests.length > 0; every other case NF (QCK only). DSR has no test list.
- [CONV] DSP-1..4, 6, 13 empty (HostQueryAnswer has no such fields): needs a CR to extend it. DSP-22 from option host_query_detection_mode (0/1/2, else 0).
- [CONV] MSH-7 = ctx.receivedAt via Intl in instrument tz (UTC fallback if the zone is unknown).
- Run: hostQuery.truth_h80e.test.ts 34/34 pass. Full instruments suite: 6 fail, none in my files: 3 perf timing, ci-scripts driver-registry (truth_h80e has no g_drivers row, migration pending) and synthetic-scan (bridge-agent testdata PID.5), signing Go fixture copy.
- Open: tsc output for truth_h80e files clean; ESLint not run.
