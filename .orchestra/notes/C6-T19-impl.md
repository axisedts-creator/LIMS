# C6-T19 impl (writer)
Files: ports/NotificationPort.impl.ts (steps 1-8), service/delivery.service.ts (outbox insert + event + send job, recordPrintDelivery), domain/messages.ts (param kinds, consent, mask), repository/delivery.repo.ts (SQL; repository.static requires SQL in repository/).
Result: 60/63 pass (contract 1-12 + port suite + static sources). 3 FAIL = seed tests: db/seeds is C0-0B only → CR-C6-022 in .orchestra/cr/C6-T19.md (exact SQL).
[CONV] OTP limiter key `p:<sha256hex(E.164)>` (core grammar; TRD says `otp:p:`). Channel switch checked before recipient resolution (step 4 before 5). Concurrent duplicate key → ON CONFLICT DO NOTHING, loser returns winner's row replayed:true.
[CONV] url kind: href-identical parse + prefix `LIMS_ORIGIN_PORTAL/r/` or equal origin; staff_url: same origin, no ?/#, path matches a staff_web route (shared-ts generated ROUTES).
Open: referrer recipient → suppressed_no_contact (CatalogPort.getReferrer + shareWithReferrer not wired); LD-26 training flag → CR-C6-023; LD-49 is C6-T29.
Open: OTP quota is consumed before the insert, so a lost concurrent race on one key can burn one quota unit (ceiling accepted).
