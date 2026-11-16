# T0A-M5-PHLEBO-2 impl (writer)
Files: apps/phlebo_app/lib/features/payment/ui/payment_screen.dart (amount due + methods card, amount/reference card), outcome/ui/fail_visit_screen.dart (reasons card, details card), handover/ui/handover_screen.dart (instruction card, centres card, one card per tube with its result), outbox/ui/outbox_screen.dart (one card per mutation: label, state chip, review note; list padding), settings/ui/settings_screen.dart (facts on one card). Complete already met the look.
[CONV] LD-258: restyle only; no behaviour, API, route, storage, mutation, payment or sync change; existing lims_ui widgets only (LimsCard; packages/ui-flutter untouched).
[CONV] offline banner: shows the real sync state on the route screen (PHLEBO-1); these six screens have no offline input, so no banner is added (would be an API change). The outbox header shows the real sync state via SyncChip.
Gap (founder): board History and Profile tabs (no screen in this app); board sample content and any board element without a spec screen or API data (not built).
[CONV] fail visit wraps each reason ChoiceTile in MergeSemantics so every reason is one labelled node inside the shared card (no invented heading).
Open: flutter test __tests__ 772/773: db_ci_guards REQ-SEC-102 (core/db, untouched) pre-existing; flutter analyze on touched folders clean.
