# RS-C2 impl (writer)
- features/admin/ui.tsx: `RequiredNote` ("Required" as a description next to the label, not inside it); `Field` shows it when `required`.
- auth/LoginForm, ForgotPasswordForm, PasswordField: RequiredNote on Email / Password.
- components/OrgUnits.tsx: drawer body = kit DrawerSection "Details" + "Contact", each Save runs the same save(); old primary Save removed (Deactivate stays). [CONV] read-only viewers get the same sections with no Save.
- components/RoleEditor.tsx: kit Badge "MFA required" (tone warning) in header when MFA is on or forced by privileged codes. SettingsScreen.tsx: accent message reworded (no hex); Display name `required`.
- Snapshots recorded (`__tests__/__snapshots__/`, 5). Verify (CI=true): rs-c2 75/75 pass; t20 config 196/196 pass (after ruling fix).
- Open: first verify run hit host "Failed to start forks worker" once (no code change); t12.actions "../nav/generated" failure is outside RS-C2 per ruling.
