# FD-T14 tests (apps/web/src/features/frontdesk/__tests__/)
Files: fd-t14.order / .screens / .pages (.tsx), fd-t14.static.test.ts, fd-t14.route.test.ts (new), fd-t14.fixtures.ts, vitest.fd-t14.config.ts.
Run: `.orchestra\notes\FD-T14-verify.cmd` (one line, repo root; vitest via the tester config).
Review round: ruling items (ME import, header regex) already applied earlier. Added for review items:
- #1 fd-t14.route.test.ts: needs apps/web/src/app/(staff)/frontdesk/trf-attachments/[attachment_id]/content/route.ts (GET; UUID check, bearer, attachment+nosniff+no-store, 404/422 non-200).
- #2 order.test: upload posts `order_id` + `centre_id` (fetch captured; jsdom FormData is not undici's).
- #3 order.test: "Confirm & bill" button gone, banner kept, no POST /confirm.
Expected now: 6 failing (4 route, upload order_id, confirm button) until writer fixes; 92 pass.
