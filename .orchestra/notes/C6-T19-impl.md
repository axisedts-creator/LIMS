# C6-T19 impl (writer)
Files: ports/NotificationPort.impl.ts (steps 1-8), service/delivery.service.ts (outbox insert + event + send job, recordPrintDelivery), domain/messages.ts (param kinds, consent, mask), repository/delivery.repo.ts (SQL; repository.static requires SQL in repository/).
Seed db/seeds/004_reporting__g_message_templates.sql (LD-57 rows verbatim, renamed from 011 per LD-59; class-G, lims_owner, ON CONFLICT DO NOTHING). Result: 64/64 vitest + 15/15 T0B-09 pass.
[CONV] OTP limiter key `p:<sha256hex(E.164)>` (core grammar; TRD says `otp:p:`). Channel switch checked before recipient resolution (step 4 before 5). Concurrent duplicate key → ON CONFLICT DO NOTHING, loser returns winner's row replayed:true.
[CONV] url kind: href-identical parse + prefix `LIMS_ORIGIN_PORTAL/r/` or equal origin; staff_url: same origin, no ?/#, path matches a staff_web route (shared-ts generated ROUTES).
Open: referrer recipient → suppressed_no_contact (CatalogPort.getReferrer + shareWithReferrer not wired); LD-26 training flag → CR-C6-023; LD-49 is C6-T29.
Open: OTP quota is consumed before the insert, so a lost concurrent race on one key can burn one quota unit (ceiling accepted).
Review items 1-2: CR-C6-025 (C0 TRD §4.6 → 001-004) + CR-C6-026 (T-08 deploy.yml/test_t08 prod list += 004) appended to .orchestra/cr/C6-T19.nonblocking.md. No code change. Numbers checked in this lane only.
