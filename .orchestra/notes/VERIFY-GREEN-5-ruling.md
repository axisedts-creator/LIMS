CR_NEEDED — the spec itself is contradictory/missing
Reasons:
1. The 9 errors sit in apps/portal/src/app/r/[token]/{page,report/page}.tsx. apps/portal is owned by C6 (spec/program/01-CHUNK-MAP.md:143), not C1. The brief's `files` is apps/web/src/** only, so C1 cannot "fix the import" there.
2. The only web-side fix, a `paths` fallback, is in apps/web/tsconfig.json. That file is owned by C0-0D (spec/program/01-CHUNK-MAP.md:132).
3. The errors exist only because a C6 test (apps/web/src/features/reporting/__tests__/rs-c6.portal.test.tsx) pulls the portal pages into the web tsc program. The rs-c6 baseline pins the `@/features/portal/*#sym` and `@/server/*#sym` import keys (rs-c6.baseline.json:126-153). A relative-specifier fix would break those pins, which the brief requires to stay green ("existing tests stay green").
4. vg5.typecheck.test.ts:45 matches the brief text "alias or path wrong -> fix the import", so the test is not wrong on its own terms. But the brief and test require a fix that no file C1 owns can deliver, and CLAUDE.md says "edit only paths your chunk owns". That contradiction is in the spec/brief and needs a CR (spec/program/04-CHANGE-REQUESTS.md:24-38).
5. CR text: .orchestra/cr/VERIFY-GREEN-5.md (options a/b/c). The lead picks one; if the lead accepts deferral, vg5 line 45 must be relaxed by the lead, not by the lane.
6. The writer did not breach any rule: no stub, no tsconfig edit kept, no test edited.
