# SEC-AUTHZ-1 tests (tester)
File: `tests/security/authz-classification.test.mjs` (node:test, 19 tests). Run: `.orchestra/notes/SEC-AUTHZ-1-verify.cmd` (= `node --test tests/security/authz-classification.test.mjs`).
Now: 2 pass (oracle: 1018 unique operationIds, 993 x-permission, 25 x-public; git scope), 17 fail because classify-authz.mjs, authz-classification.json and `.orchestra/cr/SEC-AUTHZ-1.1.nonblocking.md` do not exist.
Writer contract (header of the test file): `node tests/security/classify-authz.mjs` prints deterministic JSON `{total, counts, operations:{id:{class,x_permission,permission?,reason?}}}`, writes nothing; snapshot = that output.
Classes pinned (names not in spec): public, identity-session-flow, scheme-callback-token|device|portal|patient-pre-auth, platform, guarded-exact, guarded-other, unguarded, stub, inconclusive (needs reason).
Anchors: getLiveness/getReadiness/getPaymentResultPage public; 6 session ops identity-session-flow; 4 payment callbacks scheme-callback-token; inviteUser + approve/deny/revokeSupportSession unguarded; openSupportSession platform.
CR checks: eight `##` headings in order, plus required terms per section, snapshot counts reconciled with verifier A (607/108/148/97/33/25), tasks with files + done_when behind SEC-GATE-2.
Scope test diffs against base 879cbcb9 (env SEC_AUTHZ_BASE overrides); it will flag later lane tasks if re-run after them.
Not tested: whether a class is semantically right for the 900+ non-anchor operations (no independent oracle without running handlers).
