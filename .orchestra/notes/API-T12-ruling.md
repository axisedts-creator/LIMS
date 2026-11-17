TESTS_WRONG — the test asserts something the spec does not require
Reasons:
- spec/chunks/C7-instrument-integration/02-TRD.md:732 — MessageDetail carries `message_key_kind` (required) and `attachment?` = `{ attachment_id, scan_state, mime_type, size_bytes, original_file_name }`.
- spec/chunks/C7-instrument-integration/05-SCHEMA.md:130 and 02-TRD.md:610 — `message_key_kind` enum includes `sha256` / `sha256_repeat`; file-drop attachments key on `file_sha256` with kind `sha256` (TRD:610), so an attachment message's E35 body legitimately contains the substring `sha256`.
- contracts/openapi/instruments.yaml:6047,6094-6101 — same field required, same enum; the test's own fixture asserts `message_key_kind: 'sha256'` (messages.service.test.ts:151).
- The bare-substring check at messages.service.test.ts:173 therefore fails for every spec-conformant implementation; it does not test the A13 P-2 intent (no storage locator/hash/URL on the attachment).
Change to the test (line 173), keep everything else:
- Run the leak list `['bucket','object_path','instruments-attachments','sha256','http','token=']` against `JSON.stringify(r.body.attachment)` (not the whole body).
- Against the whole body, check key-shaped leaks instead of the bare word: `'"bucket"'`, `'"object_path"'`, `'"file_sha256"'`, `'"raw_sha256"'`, `'instruments-attachments'`, `'http'`, `'token='`.
- Line 172's exact `toEqual` on the attachment object stays as is.
