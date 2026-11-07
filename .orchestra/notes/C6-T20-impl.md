# C6-T20 impl (writer)
Files: api `auth/portal.resolver.ts`, `service/portal.service.ts`, `handlers/portal.handlers.ts`, `index.ts` (wired); worker `tasks/send_portal_otp.ts`, `index.ts` (send_portal_otp + reissue_portal_link registered, maxAttempts 8).
Tests: api 84/86, worker 13/13; 2 failures disputed in C6-T20-dispute.md (test defects). tsc clean for touched files; eslint not runnable here (not installed at root).
[CONV] P1 3/hour/link counted from otp_challenges under the link row lock (core limiter has no per-link otp_request key); P2 uses limiter `otp_verify` `o:<challenge>`, P4 `report_download` `l:<link>`; status_label map; no purpose claim (read from DB).
[CONV] `reporting.reissue_portal_link` is a logged no-op stub (body = another task); P5 only enqueues it.
Open: resolver's session-stage `portal_links` re-check runs before claims are set (RLS `portal_links__select__portal` may hide the row in real PG -> verify in db test); `reporting.portal_otp` template not in seed 004; referrer/centre OTP destinations -> failed/no_contact; audit.access after send (a throw there retries with a replayed send).
