TESTS_WRONG — `TestTamperSwapCiphertextBetweenRows` (apps/bridge-agent/internal/queue/queue_test.go:169-178) does not actually swap the two rows' nonce/ct, so it asserts ErrTampered on a row B that was never tampered.
Reasons:
- Spec requires AAD = `table || ":" || row id || ":" || seq` per payload (spec/chunks/C7-instrument-integration/02-TRD.md:351), and AAD tamper detection is a done_when item (06-IMPLEMENTATION-PLAN.md:28; 02-TRD.md:930). A ciphertext moved to another row must fail; a row holding its own ciphertext must decrypt.
- The single-statement UPDATE reads `items` in its subselects; once row A is rewritten, B's subselect returns A's new value (= B's original), so B is rewritten with its own bytes. Reproduced by the arbiter on SQLite 3.50.4 in-memory: result A=(nb,cb), B=(nb,cb). B is untouched, so nil from GetItem("B") is correct behaviour.
- errA assertion (line 176) is valid and stays.
Change in the test (tester): read both rows' `nonce` and `ct` first (e.g. via the existing `rawBlob` helper), then run two parameterised updates: `UPDATE items SET nonce=?, ct=? WHERE id='A'` with B's saved values and `... WHERE id='B'` with A's saved values. Keep both `mustTamper(t, errA)` and `mustTamper(t, errB)`. Optionally assert before GetItem that the stored blobs really were exchanged.
No implementation change required for this test.
