# W3a — C3 (apps/web catalog) TypeScript fixes
- 49 TS errors -> 0 in `features/catalog/**` and `(staff)/catalog/**`; types only, test-only files, no assertion/input/runtime change.
- web-t32.server.test.ts: `load()` default type now `Record<string, Fn> & Record<KnownServerFnName, Fn>` (named exports non-optional); `mod[fn]!` for 3 string-keyed calls.
- testmgmt1.setup.ts: router mocks typed `Mock<(...a: any[]) => any>` (was bare `ReturnType<typeof vi.fn>`, not callable).
- web-t32.components: `previewOk(res: JsonBodyType)`. web-t33/t34: filter param typed `Record<string, unknown>`.
- web-t35 (components/multipart/server): `form?`/`filename?` widened with `| undefined` (exactOptionalPropertyTypes); fetchSpy given an optional param.
- vitest: rs-c3 3 failed/22 passed, web-t33 1 failed/102 passed (unchanged baseline); all other catalog configs green.
