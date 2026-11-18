# T0B-SYNC-4 writer dispute (implementation done; test files untouched)
1. services/api/src/core/sync/__tests__/adapters/part2.static.test.ts:31 can never pass. It asserts the verify adapter text does NOT match
   /verification_policy|.../, while line 35 of the same file asserts the text CONTAINS 'sync.verification_policy_failed' (required by done_when 2 and the
   SyncErrorCode list). The substring `verification_policy` is inside `sync.verification_policy_failed`, so the two assertions contradict each other.
   PROPOSED FIX (keeps the property "no copy of the policy tables"): match table / column names only, e.g.
   /lab\.verification_polic|verification_policies|signoff_required|signoff_count|signoffs\.state|allowEntererVerify|required_verifiers/
   or strip the quoted sync / lab codes before the check.
2. resultEnter.live.test.ts:31-36 (downtime back-entry accepted). The payload carries entry_mode / occurred_at / downtime_ref, but the wrapped schema
   contracts/openapi/lab.yaml BulkEnterResultsRequest (additionalProperties: false, line 5773) has only `entries`; the doubles4 header pins validate =
   "top level shape of BulkEnterResultsRequest", and part2.static requires an unknown key to be refused. The test cannot pass without inventing keys the
   contract lacks (online, the pipeline schema check refuses them too). The adapter already maps the LD-25 block if the keys reach it.
   PROPOSED: CR to C0 owner to add entry_mode / occurred_at / downtime_ref to BulkEnterResultsRequest (LD-25), or drop this case until then.
3. resultEnter.live.test.ts:61 `expect(await effectTags(['enter'])).toHaveLength(0)` counts ALL 'enter' rows in sync2_test.effect, which no test
   truncates (clearAll truncates alerts / markers / verifies only), so the earlier accepted tests of the same file leave 3 rows. calls.enter = 0 on the
   line before already passes. PROPOSED: truncate sync2_test.effect in clearAll, or filter effectTags by the op's result id.
Run (throwaway PG17, tests/core/T0B-SYNC-4.pg.sh): 198 passed, 3 failed = items 1, 2, 3.
