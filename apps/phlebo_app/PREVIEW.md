# Phlebotomist app: UI map and the dev preview

Look: the M5 board (`spec/program/design-m-series`) plus the MyHealthNow wireframe pack (forest rounded header, teal→green
hero cards, lime pill primary button with dark text, white cards, floating tab bar). Everything comes from `lims_ui` tokens
(`lib/ui/phlebo_theme.dart` is the theme, `lib/ui/phlebo_kit.dart` the shared widgets).

## Run the clickable preview (synthetic data, dev flavour only)

```bash
flutter run --dart-define=FLAVOR=dev --dart-define=API_BASE_URL=https://api.example.test
```

Sign in with any email and password (password `wrong` shows the error copy). The round "tune" button on the Today tab flips the
phone into offline, location off, locked, wipe requested and update required. `staging` and `prod` still show the placeholder
routes until the shell is wired to the cache DB and the sync engine (`PhleboScreens` in `lib/app/router.dart` is that seam).

Screenshots of every screen (needs the Flutter SDK): `PHLEBO_SHOTS_DIR=/some/dir flutter test __tests__/screens_gallery_test.dart`.

## Screens

| Area | Screens |
|---|---|
| Entry | Splash, Sign in (offline, wrong password, locked, rate limited, no screen lock, rooted, update required, other user has unsent changes, rebind), Lock gate (attempts left, session ended), device notices (wipe requested, wiped, update required, no screen lock, rooted) |
| Today | Home (progress hero, next stop, handover prompt, up next, completed, cancelled, empty / purged / loading / offline / all done), full ordered list |
| Visit | Visit detail (patient, travel "On my way" with live-location states, address + Navigate, window, note, fasting, recollection / revisit / address-needed flags, tubes with tests, amount due), Identity, Consent, Collect (per-tube checklist, camera / scanner / typed barcode, not collected + reason), Payment, Finish (collected / partly collected), Can't do this visit |
| Handover | Handover, receipt (waiting for the centre, confirmed, tube not found) |
| Sync | Outbox, Sync now |
| History | Last working days, one day |
| Alerts | Grouped by day, unread count, opens the visit |
| Profile | Summary and week numbers, ID card (what the patient checks), Location sharing, Help & support (FAQs with search, Contact dispatch, Report a problem), Settings and sign out |

Not built on purpose (spec rules them out, see `.orchestra/cr/PHLEBO-UI-FULL-1.nonblocking.md`): field label printing
(D-LABELS) and notification preferences (no push).
