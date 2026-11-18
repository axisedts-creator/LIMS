# T0D-UISETTINGS-1 screens (LD-353 template 4 SETTINGS)
| route | template | changed | left / why |
|---|---|---|---|
| /frontdesk/settings | 4 | cards Discounts / Registration became tabs in kit SettingsForm (all sections mounted, inactive hidden); sticky Save, dirty note, one success toast; 501 NotAvailable, 5xx ErrorState via loadOr | field names, PUT/If-Match, step-up banner |
| /engagement/settings | 4 | five cards became tabs Features / Patient app / Bookings / Reminders / Queue; one Save, dirty note, toast; loadOr | server action, step-up banner |
| /homecollection/settings | 4 | five cards became tabs; "Save settings" moved from header to sticky bar; dirty note; loadOr | payment-methods table inside the Payments tab, pending switches |
| /instruments/settings | 4 | tabs Backlog and clock / Agent PC; sticky Save, dirty note, toast | retention help text stays |
| /inventory/settings | 4 | four tabs; dirty note, one toast; pendingOr became loadOr | only the selected tab is mounted (uiset1 dirty helper types into the first DOM input); read-only view keeps its DescriptionList |
| /lab/settings | 4 | tabs moved into the SettingsForm slot; General is the kit form | Verification levels tab (VerificationPolicyTab.tsx) left to T0D-VERLEVEL-1 |
| /micro/settings | 4 | five tabs in the slot; General is the kit form (h2 and loose Save removed) | four master-list tabs keep their tables and drawers |
| /partners/settings | 4 | kit SettingsForm, no tabs (one section), dirty note; 501 NotAvailable | 500 stub message stays (LD-301); T0D-PARTYSET-1 may own this screen (no task file found) |
| /payments/settings | 4 | one tab per gateway plus Refunds and labels; ONE Save runs the existing account/settings actions only for dirty sections; loadOr | Fonepay read-only (B8); secrets stay write-only |
| /quality/settings | 4 | Settings tab is the kit form, cards became h2 sections, one Save; loadOr | Coded sets tab keeps its table and edit dialog |
| /anatomic/config | 4 | seven tabs in the slot on every ?tab=; Settings tab is the kit form with dirty note | list tabs keep their own list, drawer and Save |

Not touched: billing and reporting settings forms (T0D-PRINTCFG-1); catalog tax and surcharges (list screens with dialogs, UILIST-3, no settings form); features/admin, features/platform (rs-c2.static pin).
Kit (packages/ui): SettingsForm uses kit Form (validation, Ctrl+Enter) and gains isDirty / problem; Form gains className; kit.css adds .lims-settings-dirty, .lims-settings-section, full-width h2/h3.
Later: a kit SettingsForm option without Save (list tabs and read-only views use a plain .lims-settings wrapper today).
