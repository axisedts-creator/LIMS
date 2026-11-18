APPROVE

Scope reviewed: the given range a92a70ff4..HEAD (LD-377 test fix only: adminpage-eng-1.static.test.ts:106-107, lookahead form, no 0x08 byte left in features/engagement/__tests__) plus the full task (commits 1d77991c2..HEAD tagged T0D-CONTENT-1, 23 files outside .orchestra; 21 non-test files).

Checked:
- Names verbatim: paths and operationIds match contracts/openapi/engagement.yaml (listPortalContent, createPortalContent, updatePortalContent, deactivatePortalContent, reorderPortalContent, listProfileImages, setProfileImage, clearProfileImage), identity.yaml (uploadBrandingAsset, branding-assets/{asset_id}/content, users/search, centres), catalog.yaml (doctors/search). Body fields whitelist = PortalContentCreate/Update (additionalProperties false respected; sort_order only via reorder). Permissions engagement.content.read/manage exist per LD-313 c. Route row staff.engagement.content + nav entry are what done_when (1) requires.
- Idempotency: create and upload send Idempotency-Key (x-idempotency required); PATCH/deactivate send If-Match = row version; 409 keeps the form open.
- Safety: only HTML injection is MarkdownPreview.tsx, fed by safeMarkdown.ts, which is byte-identical to services/api/.../safeMarkdown.ts after the 2-line header. Thumbnail proxy validates uuid, keeps the token server side, passes only PNG/JPEG, nosniff, no-store, redirect error. No logging, no PHI, no secrets. No files under features/admin, features/platform, app/(auth), app/(platform). No tenant/RLS surface (web only).
- Tests run 2026-11-18: content1 96/96, adminpage-eng-1 81/81, t-q4 82/82, t-b6 104/104, t-l1 35/35, rs-c2 74/74 (route pin intact).

Not defects of this task (for the lead):
- elabmenu3.walk (e) fails: the nav entry set grew 139 -> 140 because of engagement.content, which done_when (1) requires; core/nav baseline is not owned by this task, lead must re-record. The other 7 elabmenu3 failures are in lab, billing and inventory screens (other tasks).
- Known gaps in impl notes: thumbnails need identity.settings.manage (read-only users see empty thumbnails); doctor and staff names not shown in the Profile Images list.
- Minor: reorderContentAction allows 1000 ids, contract maxItems is 500; the API refuses beyond 500 (validation_failed), no data risk.
