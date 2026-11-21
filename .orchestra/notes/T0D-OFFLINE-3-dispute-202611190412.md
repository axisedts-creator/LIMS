# T0D-OFFLINE-3 dispute (writer, 2026-11-19 03:40, after tester 62ed67017 / LD-403)
LD-403 landed and works: server_symbols check now green. Next assertion in the same test trips.
Test: rs-c4.static.test.ts:79 (frontdesk_feature route_strings_added filter), file not in OFFLINE-3 diff.
Added frontdesk route strings, all already-landed T0D-REGSCREEN-2 (drafts, custom fields, favourites, ICD, number preview; same module as LD-403 regscreen2_symbols):
  /v1/catalog/${kind}
  /v1/frontdesk/custom-field-definitions
  /v1/frontdesk/favourite-tests
  /v1/frontdesk/favourite-tests/${uuid
  /v1/frontdesk/icd-codes
  /v1/frontdesk/registration-drafts
  /v1/frontdesk/registration-drafts/${id
  /v1/frontdesk/registration-drafts/${uuid
  /v1/frontdesk/registrations/number-preview
Why test is wrong: these are additions from already-ruled work, not OFFLINE-3 code; LD310_ALLOW.route_strings_added regex (LD-400) only forgives v1/billing, identity and the ledger link.
Suggested fix (tester): widen route_strings_added regex to also match ^/v1/frontdesk/(custom-field-definitions|favourite-tests|icd-codes|registration-drafts|registrations/number-preview) and ^/v1/catalog/\$\{kind\}$, plus one not-vacuous check that an unrelated frontdesk route is still rejected.
Still failing, unchanged and out of scope: rs-c4.screens "Daily cash (open shift)" snapshot (parked by lead, awaiting founder).
Writer: no code change.
