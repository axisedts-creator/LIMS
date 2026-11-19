TESTS_WRONG — `services/api/src/core/storage/__tests__/s3-config.test.ts:129` forbids the bare substring `aws4`, which every correct SigV4 implementation must contain (`aws4_request`).
Change line 129 to an import-scoped pattern, keeping all other alternatives:
`expect(t).not.toMatch(/from\s+['"](?:@aws-sdk\/[^'"]*|aws-sdk|aws4|minio|@supabase\/[^'"]*)['"]|require\(\s*['"](?:@aws-sdk\/[^'"]*|aws-sdk|aws4|minio|@supabase\/[^'"]*)['"]\s*\)/);`
Reasons:
1. T0B-STORAGE-1 has no row text in `spec/` (grep: no match); the task brief done_when (1) is the binding source: "AWS signature version 4 query signing written in plain TypeScript with the node crypto module and no new dependency" (inbox brief line 20).
2. SigV4 credential scope and key derivation end in the literal `aws4_request`; the same suite pins it: `__tests__/s3.test.ts:35` expects `X-Amz-Credential` = `.../us-east-1/s3/aws4_request`, and the fake verifier requires it (`__tests__/s3.fake.ts:31,47,48`). Line 129 therefore contradicts line 35 of the sibling test; no implementation can pass both.
3. The brief's intent (no SDK, no `aws4` package) is an import/dependency rule, not a substring ban; it stays enforced by `s3-config.test.ts:128` (`from 'node:crypto'`), `:134` (package.json, `^aws4` kept), and the import-scoped regex above.
4. This narrows a wrong assertion to what the brief requires; it does not loosen the no-SDK rule (all forbidden modules stay forbidden in import and require form).
5. Implementation `services/api/src/core/storage/s3.ts:73,87` keeps `aws4_request` unchanged; no string-splitting to evade the check.
