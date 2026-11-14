# RS-C2 impl (writer) — BLOCKED on dispute (RS-C2-dispute.md)
- features/admin/ui.tsx: `RequiredNote` ("Required" as a description next to the label, not inside it); `Field` shows it when `required`.
- auth/LoginForm, ForgotPasswordForm, PasswordField: RequiredNote on Email / Password.
- components/OrgUnits.tsx: drawer body = kit DrawerSection "Details" + "Contact", each Save runs the same save(); old primary Save removed (Deactivate stays). [CONV] read-only viewers get the same sections with no Save.
- components/RoleEditor.tsx: kit Badge "MFA required" (tone warning) in the header when MFA is on or forced by privileged codes.
- components/SettingsScreen.tsx: accent colour message reworded (no hex); Display name passes `required`.
- Open: t20.roles-org conflict (6 tests); snapshots not recorded yet; nothing committed.
