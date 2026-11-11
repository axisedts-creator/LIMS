# BL-T22 dispute (debugger, 2026-11-11)
- uploads.handlers.test.ts:4-5 (its own comment says "dispute if wrong") assumes uploadTrf calls ctx.uploads.accept BEFORE any port/DB call. probe.kit.ts ctxFor gives only `uploads`, `files`, `storage.put`; every port is a notFound proxy.
- Real order in trf.service.ts:76-98 is assertRole -> centre scope -> order lookup -> accept. So the ports answer common.not_found, and the missing ctx.download/storage.delete hits common.internal (trf.service.ts:35).
- Spec: 07-SECURITY.md:94 (A11) requires "404 common.not_found, no side effects" for foreign ids; REQ-SEC-017 (line 15) requires centre scoping. accept() stores the object, so accepting first writes bytes for an unauthorised centre/order. The test order contradicts these.
- Ruling asked: TESTS_WRONG for uploads.handlers.test.ts (10 tests): give ctx a working IdentityPort (assertRole/getActor with centre scope), download.stream and storage.delete, so hostile files reach accept().
