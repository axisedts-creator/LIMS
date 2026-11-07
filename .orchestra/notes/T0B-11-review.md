CHANGES

Round 2. Reviewed `git diff 3cf969a..HEAD`. Round-1 items 1-3 are fixed:
- #1: the generated script starts with `SET session_replication_role = replica;`, and the header documents that restore needs a superuser.
- #2: PGOPTIONS carries `-c row_security=off`, and a node test asserts it.
- #3: the live script restores into a second, really-migrated database. It seeds 9 tables, including the invoices/lines/credit-note/ledger chain and a reversal that sorts before its payment. It also asserts that a role under RLS gets an error, not a short export.
No identity or sequence columns exist in billing (D16 OK). Names, owned paths, UUID validation, URL masking, and the no-PHI/no-secret checks are OK. Reviewer re-ran `node --test tests/db/T0B-11.billing-export.test.mjs`: 19/19 pass.

1. done_when is still not met (round-1 #4 is open). `db/tests/billing_isolatable/T0B-11_billing_isolatable.sh` has never been run live, so AC-0B-6.4 is unproven. The seed columns and CHECKs against the real DDL are unproven too. The reviewer session was also denied permission to run it. Fix: on a session allowed to use docker, run `PATH="$PWD/coverage/t0b11live/bin:$PATH" NODE_OPTIONS=--import=./coverage/t0b11live/shim.mjs bash db/tests/billing_isolatable/T0B-11_billing_isolatable.sh` (or plain `bash …` on a host with psql). Fix any seed or DDL mismatch it reports, then paste the `ok - AC-0B-6.4: …` line into .orchestra/notes/T0B-11-impl.md. No code change is requested otherwise. If the run prints `ok`, this review becomes APPROVE.
