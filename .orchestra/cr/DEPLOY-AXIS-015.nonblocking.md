Title: CR-C1-DEPLOY-015: operator lowered the staff password floor from 12 to 6 characters on the test host (deviation from REQ-SEC-060)
From chunk: C1 (deploy attempt, prod-lean, 2026-11-24)    To owner: per item (listed below)
Type: decision record / spec deviation
Blocking? no for any current orchestra task (file named `.nonblocking`).
Relation to earlier CRs: none; 05-SCHEMA 4.6 (`password_min_length` 12..64), 04 A3, 01-PRD AC-A6.1..A6.3, REQ-SEC-060.

## Decision
On 2026-11-24 the operator (informed that this weakens a public-facing login that has MFA, fail2ban and the common-password check as the other layers) ordered the minimum staff password length floor to be lowered from 12 to 6 characters on the test host. The default for a new tenant stays 12; an admin may now set 6..64 per tenant. Nothing in the repo is changed by this CR: the change exists only as host-only patches.

## What was changed on the host (the floor lived in five places)
1. Database: `identity.tenant_settings` CHECK `tenant_settings__pwlen__ck` from `BETWEEN 12 AND 64` to `BETWEEN 6 AND 64` (migration file `20261124000000_identity__relax_password_min_length.sql`, applied with Atlas out of order after `20261117000000`; the column DEFAULT stays 12).
2. API: `services/api/src/modules/identity/domain/password-policy.ts` `DEFAULT_MIN_PASSWORD_LENGTH` 12 -> 6 (the floor a tenant setting can only raise), and `domain/settings.ranges.ts` `password_min_length` min 12 -> 6; tests that encoded 12 were updated and two tests added (api r12).
3. Web: the set-password server action (`apps/web/src/features/admin/auth/actions.ts`, `pw.length < 6`), its client form `SetPasswordForm.tsx` (>= 6 and texts), the change-own-password form `components/MyAccount.tsx`, the admin settings field `components/SettingsScreen.tsx` (`min: 6`), and the message texts in `auth/messages.ts` and `lib.ts` (web r12); two tests adjusted.
4. GoTrue: `GOTRUE_PASSWORD_MIN_LENGTH` is not set on the host (library default, 6); `services/api/src/modules/identity/gotrue/mapping.md` still documents 12 and `gotrue/gateway.fake.ts` emulates 12.
5. Not changed: `apps/partner` (its own 12 check), the contract (already `minimum: 1, maximum: 128`).
The tenant setting itself (`password_min_length`) must still be lowered by the admin in Settings per tenant; until then a tenant keeps its stored value (12).

## What the owners should decide
- Keep the host-only deviation only on this test host, or take a proper decision to change REQ-SEC-060 / 05-SCHEMA 4.6 (then the five places above, the partner app, the GoTrue mapping notes and the tests change together).
- If 12 stays the product rule: revert is one migration (CHECK back to 12..64 after setting every tenant value to at least 12), api r11 and web r11 images (or later), and the tenant setting back to 12.

Tenant/security impact: weaker minimum for new passwords on this host; MFA, rate limits, fail2ban (12 login POSTs per 10 minutes per address) and the breached-password check remain. No secret value appears; no patient data.
IRD/regulatory impact: none known; check the product's password rule against any regulatory baseline before shipping.
