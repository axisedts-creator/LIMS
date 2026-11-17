# T0B-MSGDESK-1 dispute 2 (writer). TESTS_WRONG, 1 item (flaky). Revised tests otherwise green: PG17 msgdesk runs wrun3 137/137, wrun4 137/137, wrun5 136/137.
1. engagement/__tests__/msgdesk/templates.test.ts:134-136 ("%s without %s: 403 auth.forbidden and nothing written") counts EVERY tenant A row of
   engagement.broadcast_template before/after the refused call. vitest runs files in parallel and broadcast.test.ts:33/482/503 creates tenant A templates
   at the same time, so the count can grow by 1 regardless of the handler (wrun5: "expected 31 to be 30", updateBroadcastTemplate case; the 403 assertion
   on line 135 and the version check on line 137 passed). Fix: scope the count to rows this test can create, e.g. `tenant_id = $1 AND created_at >= <before ts>
   AND created_by = <test sub>` or compare the exact row (`id = $1` version/updated_at, already on line 137) plus `name = 'x'` count 0 for update.
Static part (probes/boot/contract) 614/616 x3: the 2 reds are the pre-existing items already ruled out of scope (engagement boot PHASE_STUBS QualityPort;
partners contract/msgdesk1.pending.test.ts:28). tsc clean.
