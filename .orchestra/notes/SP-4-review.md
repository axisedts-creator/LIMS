APPROVE

Re-review of diff 4e04247..HEAD (7 files) after the review-fix commits b3c4bbc and 593571c. `node --test db/tests/spikes/SP-4.decision.test.mjs` → 10/10 pass.
- Item 1 fixed: `.orchestra/cr/SP-4.nonblocking.md` is filed in the 04-CHANGE-REQUESTS template, addressed to the C4 owner. It quotes C4 07-SECURITY.md:19 "(CHECK + storage policy)" verbatim, and the replacement it proposes is exact. Record :22 and :97 now cite the CR file.
- Item 2 fixed: the api-proxied test now requires the CR path or the CR-C2-011 cite, and checks that the CR file exists. "No new CR is raised" no longer passes the test.
- No regressions: names verbatim (`ctx.storage`, `reports`, `app.current_tenant_id()`, §8 policy, R10/R12b, T0B-12/T0B-14). The probe-only policy was dropped. No secrets, JWTs, signed URLs or real data. Edits stay in owned/allowed paths (db/meta/decisions, db/tests, .orchestra notes/cr). done_when is met: api-proxied decided, every cross-tenant attempt denied, same-tenant read works.
- Non-blocking: the CR title keeps the `CR-C0-<nnn>` placeholder. The number gets assigned when the CR is registered.
