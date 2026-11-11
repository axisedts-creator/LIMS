# PG-T05 impl (writer)
Files: services/api/src/modules/payments/__tests__/sim/esewa.sim.ts, khalti.sim.ts (new). No test files edited.
- [CONV] Node http server on 127.0.0.1:0; close() calls closeAllConnections() so hung sockets cannot block it.
- [CONV] Shared SimReply/queue logic duplicated in both files (plan owns only these two paths; no common module).
- esewa complete() is a function reply (reads request transaction_uuid/product_code); totalAmount spliced raw into JSON text, validated against /^-?\d+(\.\d+)?$/.
- khalti: unknown path 404 first, then apiKey check (401 Invalid token.), then script. Empty queue -> 500 "sim: no reply scripted".
- Run: vitest sim dir -> 2 files, 53 tests pass; tsc shows no errors in sim files.
- Open: adapter behaviour against sims is PG-T06+; full-repo suite/lint not run.
