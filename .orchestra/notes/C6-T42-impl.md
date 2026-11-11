C6-T42 impl. GREEN after tester timeout-only revision per LD-91 (eb51ea17); no code change this pass (LD-91: implementation does not change).
- Verified 2026-11-11 (C6-T42-verify.cmd parts): api portal.payment 31/31, worker portal_payment.tasks 23/23, static 5/5, Playwright pay 12/12.
- API: repository/portal-payment.repo.ts, service/portal.service.ts (PP1 createPaymentRequest, PP2 getPaymentRequest, P3 dues.open_request), handlers/portal.handlers.ts.
- Worker: tasks/create_portal_payment_intent.ts, tasks/refresh_portal_payment_request.ts, cron.ts (expire */10, purge_ephemeral payment rows), index.ts.
- Portal: r/[token]/pay/route.ts, r/[token]/payments/[id]/page.tsx, r/payments/[id]/done/page.tsx, report-page dues card, features/portal/PaymentStatus.tsx, server/api.ts, server/session.ts + actions.ts.
- [CONV] link-token cookie `__Host-lims_portal_lk` for "Back to your report"; no auto-refresh once "Continue to" shows; refresh counter `?n=` up to 30 s; link revoked -> failed `link_revoked`; PP2 does not slide the session.
- Open: no reporting probes/pending.json (LD-70: nothing to remove); tester to add createPortalPaymentRequest/getPortalPaymentRequest to __tests__/implemented-ops.ts; repository.static "no inline SQL in service" failed before T42.
