APPROVE
Re-review after a5d7aba0/a0925293. Prior items resolved:
1. Cross-centre contact: findCentreContact returns centre_id; D3 throws common.not_found on centre mismatch (delivery.staff.service.ts:107); resolveRecipient `centre` checks centre_id (delivery.flow.service.ts:56); centreId passed by every startDelivery caller (dispatch, D3, D4, fallback) and by send_delivery.ts:63. New D3 test (other centre -> 404, no row/job) green.
2. Five non-spec failure codes marked [CONV] in send_delivery.ts header + C6-T23-impl.md; CR-C6-027 written at .orchestra/cr/C6-T23.md (non-blocking).
Earlier "Checked, OK" list still holds (no other code changed). Ran: worker 113/113, api delivery.handlers + static 58/58 green.
Not verified: real PG/RLS, repo-wide lint/tsc (pre-existing config issues).
