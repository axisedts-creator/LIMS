CHANGES
# T0B-FILES-1 review (reviewer)
Checked: diff 77aee6fa5..HEAD (17 files). Error codes are verbatim from contracts/errors.yaml. No routes or permission codes added (LD-310 d). No PHI, URL or credential reaches logs or metrics (tested). TTL is 1..300 in the adapter. Tenant path and owned-bucket checks run before any signing. Scan gate and access row work as specified. The kit never reads file bytes. Only C0 core and kit paths edited.
Ran: api vitest core/storage + core/uploads + core/__tests__ = 22 files, 484 pass, 2 skipped (live). ui vitest fileupload-queue + fileupload-direct + batch2-fileupload = 64/64. tsc --noEmit clean for api and ui.

1. services/api/src/core/storage/direct.ts:552-554 (confirmUpload): on a size, type or sha256 mismatch the helper deletes whatever object sits at the caller-supplied `objectPath`. CR-C0-FILES-1 (`.orchestra/cr/T0B-FILES-1.nonblocking.md`:42) has the browser send `objectPath` to `uploads:confirm`. Once that route is wired, any user in the tenant who holds the upload permission can delete an already recorded attachment or report: they send its path with a wrong sha256. That is data deletion, which LD-310 keeps with the founder.
   Fix:
   (a) Add `readonly unrecorded: true` to `ConfirmUploadInput`. Call `storage.delete` only when `i.unrecorded === true`; otherwise throw `common.validation_failed` and leave the object alone. Document on the field that the caller sets it only after checking that no row references `objectPath`.
   (b) In direct.test.ts:319-326, pass `unrecorded: true` in the deletion case. Add one case without it that expects `common.validation_failed` with the object still present. This is a new security requirement, not a weaker test.
   (c) Add one line to the CR "Proposed change": confirm accepts only an `objectPath` that the server issued at init and has not yet recorded.

Non-blocking notes:
- `got.sha256 === undefined` skips the checksum check at confirm. That is fine only if the real provider binds sha256 into the signature (SP-1); the CR already says so.
- impl.md points to `.orchestra/cr/T0B-FILES-1.md`, but the file is `T0B-FILES-1.nonblocking.md`.
