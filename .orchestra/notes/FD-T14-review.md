APPROVE
Re-review of `1e851fe7..HEAD` (FD-T14) after review round 1. Ran FD-T14-verify config: 98/98 pass (5 files).
- #1 fixed: `app/(staff)/frontdesk/trf-attachments/[attachment_id]/content/route.ts` proxies `getTrfAttachmentContent` (frontdesk.yaml:2922): UUID check, bearer, redirect:'error', attachment + nosniff + no-store; 403/404/422 empty non-200, else 502. Path matches OrderView.tsx:117 link. Inside C4 web `frontdesk` ownership. Covered by fd-t14.route.test.ts.
- #2 fixed: uploadTrf/uploadTrfAction send `order_id` (TrfUploadForm optional field, frontdesk.yaml:5302); OrderView passes `order.id`. Test asserts `order_id` in request.
- #3 fixed: "Confirm & bill", confirmPreRegisteredOrder, confirmOrderAction removed (no remaining refs); banner kept; open item recorded in FD-T14-impl.md.
No DB/RLS, no PHI in logs, no secrets, no invented names in the fix diff. Not run: lint, full suite; writer reports tsc errors only in tester-owned test files (msw `onUnhandledRequest` typing) — non-blocking, tester to tidy.
