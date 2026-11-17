Title: CR-C8-AN-T15b: contracts/render/analytics.report.schema.json is absent (C0-0C deliverable)
From chunk: C8            To owner: C0-0C
Type: schema
Blocking? yes — AN-T15b "done when"/tests: schema.test.ts (C6 contract case 2) reads this file; 34 cases fail with ENOENT. The template itself (report.test.ts, 32 cases) passes.
Problem: 02-TRD §10.2 step 6a says C0-0C transcribes the analytics.report render data to `contracts/render/analytics.report.schema.json`. The file does not exist in the repo, so RenderPort cannot validate against it and the contract test cannot pass. C8 does not own `contracts/`, so it is not hand-written here.
Proposed change (exact): add `contracts/render/analytics.report.schema.json` = JSON Schema 2020-12 transcription of TRD §10.2 step 6a: all objects `additionalProperties:false` (top level and column items; row objects take string|integer cells); every string maxLength 200; required = the 10 header strings + `columns` + `rows`; `exportId` uuid; `columns` 1–40 items {key ^[a-z0-9_]{1,40}$, label, kind enum text|count|paisa|seconds|bp}; `rows` 0–5000 objects with additionalProperties anyOf [string<=200, integer]. The inline TRD_SCHEMA in `services/renderer/templates/analytics/report/__tests__/schema.test.ts` is a working transcription (33/33 fixture cases pass against it).
Backward compatible? yes — new file.
Tenant/security impact: none new; closes the RenderPort input-validation gap (REQ-SEC-086 data-only render).
IRD/regulatory impact: n/a.
Alternatives considered: C8 writing the file itself (rejected: not an owned path, CLAUDE.md).
Tests that will prove it: `.orchestra\notes\AN-T15b-verify.cmd` — schema.test.ts "contracts/render/..." block (exists, accepts 5 valid, rejects 28 invalid).
