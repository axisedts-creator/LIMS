# T0B-STORAGE-1 dispute (writer)
Test: `s3-config.test.ts:129` `expect(t).not.toMatch(/@aws-sdk|aws4|aws-sdk|minio|@supabase/)` on `core/storage/s3.ts`.
Why wrong: the bare `aws4` alternative matches the credential scope terminator `aws4_request`, which SigV4 REQUIRES in every signature (the published vector the same suite pins cannot be produced without it; the fake `s3.fake.ts:31,47,48` uses it too). Any correct plain node:crypto implementation fails it; hiding the literal (string splitting) would game the check.
Intent (no `aws4` npm package / SDK) is already covered by `s3-config.test.ts:131` (package.json) and could be kept here with an import-scoped pattern, e.g. `/from ['"](?:@aws-sdk\/[^'"]*|aws-sdk|aws4|minio|@supabase\/[^'"]*)['"]/`.
Writer did not edit the test; s3.ts keeps the literal `aws4_request`.
