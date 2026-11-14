# C2 — Identity, Access & Administration — 04 UI/UX

Status: DECISION draft, 2026-11-05. Web only (staff Next.js app, server-only BFF — 04 S4). Language English with message-catalog keys `admin.<screen>.<key>` / `platform.<screen>.<key>` / `auth.<screen>.<key>` (02-CV §13). WCAG 2.2 AA target (02-CV §14). All values marked [CONV] are UI choices made here.

## 1. Information architecture

| Route (URL) | Screen id | Route group (owner path) | Permission (nav + page guard) |
|---|---|---|---|
| `/auth/login` | AU-1 Login | `(auth)` (CR-C2-001) | public |
| `/auth/mfa` | AU-2 MFA challenge | `(auth)` | session `mfa_pending` |
| `/auth/mfa/enrol` | AU-3 MFA enrolment | `(auth)` | session `mfa_enrolment_required` |
| `/auth/forgot` | AU-4 Forgot password | `(auth)` | public |
| `/auth/confirm` | (landing, no UI beyond spinner) | `(auth)` | public |
| `/auth/set-password` | AU-5 Set password | `(auth)` | session `password_setup` |
| `/auth/logout` | AU-6 Logged out | `(auth)` | public |
| `/auth/session-expired` | AU-7 Session expired | `(auth)` | public |
| `/admin/me` | ME-1 My account (tabs: Profile, Security, Sessions) | `(staff)/admin` | `identity.self.manage` (CR) |
| `/admin/users` | AD-1 Users | `(staff)/admin` | `identity.user.read` |
| `/admin/users/new` | AD-2 Invite user | `(staff)/admin` | `identity.user.manage` |
| `/admin/users/{membership_id}` | AD-3 User detail (route `staff.admin.user`) | `(staff)/admin` | `identity.user.read` |
| `/admin/roles` | AD-4 Roles | `(staff)/admin` | `identity.user.read` |
| `/admin/roles/{role_id}` (+ `/admin/roles/new`) | AD-5 Role editor | `(staff)/admin` | `identity.user.read` (edit: `identity.role.manage`) |
| `/admin/branches` | AD-6 Branches | `(staff)/admin` | `identity.user.read` |
| `/admin/centres` | AD-7 Collection centres | `(staff)/admin` | `identity.centre.read` (08 A13 D-16; edit actions `identity.centre.manage`) |
| `/admin/settings` | AD-8 Lab settings (tabs) | `(staff)/admin` | `identity.settings.manage` |
| `/admin/sessions` | AD-9 Active sessions | `(staff)/admin` | `identity.session.revoke` |
| `/admin/audit` | AD-10 Audit log | `(staff)/admin` | `audit.log.read` |
| `/admin/audit/{audit_id}` | AD-11 Audit entry (route `staff.admin.audit_entry`) | `(staff)/admin` | `audit.log.read` |
| `/admin/access-log` | AD-12 Access log + Sign-in events (tabs) | `(staff)/admin` | `audit.log.read` |
| `/admin/exports` | AD-13 Exports | `(staff)/admin` | `audit.log.export` (page guard and list; other requesters' rows appear only when the caller also holds `audit.log.read`, 02-TRD §5.9, 08 A13 P-10) |
| `/admin/support-access` | AD-14 the LIMS provider support access | `(staff)/admin` | `audit.log.read` |
| `/admin/access-review` | AD-15 Access review | `(staff)/admin` | `identity.user.read` |
| `/platform` | PL-1 Platform home | `(platform)` (CR-C2-001) | `platform.tenant.read` |
| `/platform/tenants` (+ `/new`) | PL-2 Tenants / Provision | `(platform)` | read / `platform.tenant.manage` |
| `/platform/tenants/{tenant_id}` | PL-3 Tenant detail (route `staff.platform.tenant`) | `(platform)` | `platform.tenant.read` |
| `/platform/ird` | PL-4 IRD Annex tracker (all tenants) | `(platform)` | `platform.tenant.read` |
| `/platform/support-sessions` | PL-5 Support sessions | `(platform)` | `platform.tenant.read` |
| `/platform/dead-letters` (+ `/{dead_letter_id}`, route `staff.platform.dead_letter`) | PL-6 Dead letters | `(platform)` | `platform.dead_letter.manage` |
| `/platform/staff` | PL-7 Platform staff + sessions | `(platform)` | `platform.staff.manage` (CR) |
| `/platform/auth-events` | PL-8 Sign-in events | `(platform)` | `platform.tenant.read` |

Nav manifests: `features/admin/nav.manifest.ts` (group "Administration", items above with permission), `features/platform/nav.manifest.ts` (used only by the `(platform)` layout). "My account" appears in the shell user menu for everyone with `identity.self.manage`.

## 2. Components

### 2.1 From `@lims/ui` (C0-0D) — names as expected; C0-0D confirms the final names in its kit inventory

`AppShell` (core), `PageHeader`, `Breadcrumbs`, `Tabs`, `Card`, `DataTable` (sortable headers, row actions, keyboard row navigation), `FilterBar`, `CursorPager` ("Load more"), `TextField`, `EmailField`, `PasswordField` (show/hide toggle), `PhoneField`, `Textarea`, `Select`, `MultiSelect`, `Checkbox`, `Switch`, `RadioGroup`, `DateField`, `DateRangeField` (renders per calendar setting; values A.D. ISO), `NumberField`, `FileUpload` (drag/drop + button, accept list, size hint), `ImagePreview`, `Button`, `IconButton`, `Dialog`, `ConfirmDialog` (typed confirmation variant), `Banner` (info/warning/danger), `Toast`, `Badge`/`StatusChip` (text label always present), `EmptyState`, `Skeleton`, `ErrorState` (shows `request_id`), `KeyValueList`, `Tooltip`, `HelpPanel` (core in-app help), `Form` + `FormField` (label, hint, error with `aria-describedby`), `Spinner`.

### 2.2 Kit components (CR-C2-016 ACCEPTED-MODIFIED in 08 R22) — not built locally (02-CV §14)

Names below are the final kit names (08 R22, 08 §4.6; CR-C2-016 mapped the requested look-alikes onto them); `SupportBanner` = C0 shell slot (not a feature component); new `PermissionMatrix`, `DataUriImage`.

| Component | Needed by | Spec |
|---|---|---|
| `OtpInput` | AU-2, AU-3, ME-1 | 6 single-digit cells or one field with `inputmode="numeric"`, `autocomplete="one-time-code"`, paste of 6 digits fills all, Enter submits |
| `PermissionMatrix` | AD-5 | rows = modules, columns = permission codes grouped by resource; checkbox per code; "privileged" badge; disabled + tooltip for non-assignable codes; keyboard grid navigation |
| `DiffTable` | AD-11 | rows `{label, before, after, changed}`: two-column old/new per key, changed keys highlighted with text marker "changed" (not colour only), values rendered as text nodes only (REQ-SEC-088), long values collapsed |
| `SecretRevealOnce` (`requireAcknowledgement`, default true) | AU-3 | monospace read-only text + copy button + "shown once" hint |
| `DataUriImage` | AU-3 | renders `data:image/svg+xml;base64,…` or PNG data URI as `<img>` with alt text; never inline SVG markup |
| `Timeline` (existing kit component) | PL-3, PL-4 | vertical list of state changes with actor + time |
| support-session banner — C0 shell slot, fed from `SessionState.actor.support_session` (CR-C2-009) | every staff page during support | persistent danger banner "The LIMS provider support is accessing this lab until {time} — reason: {ticket_ref}"; shown to support user and to tenant users |

## 3. Global UX rules for C2 screens

| Rule | Value |
|---|---|
| Date/time display | tenant `calendar_display` (AD default; 04 D12) + timezone `Asia/Kathmandu`; A.D. format `DD/MM/YYYY hh:mm A`; B.S. `YYYY-MM-DD B.S.` (02-CV §13). Audit screens additionally show UTC in a tooltip |
| Masking | email in lists `te***@example.test`; phone `+97798******21`; IP `203.0.113.x` (last octet masked) in lists; full only in detail views to holders of the page permission |
| Destructive actions | `ConfirmDialog`; lock/deactivate/terminate/discard require reason; terminate requires typing the tenant code |
| Privileged actions at aal1 | API returns `auth.mfa_required` → dialog "This action needs two-step verification. Log in again with your authenticator code." → button logs out and returns to `/auth/login?next=…` |
| Optimistic concurrency | every edit form keeps `version`; `409 common.version_conflict` → dialog "This record was changed by someone else. Reload to see the latest version." [Reload] |
| Toasts | success only; errors are inline or banners |
| Help | `HelpPanel` on every screen, content in `features/<m>/help/<screen>.md` |
| Page size | 50 rows default, "Load more" (02-CV §4.3) |
| Keyboard | `/` focuses the first filter field; `n` = primary "New" action on list pages; `Esc` closes dialogs; `Ctrl+Enter` submits forms; tables: ↑/↓ move row focus, Enter opens. Shortcuts disabled while focus is in a text input (except Ctrl+Enter, Esc) [CONV] |
| Barcode scanner | not used on C2 screens; scanner keystrokes into a C2 text field are treated as typing |

## 4. Auth screens

### AU-1 Login
Layout: centred card (max 420 px), lab-neutral LIMS wordmark (no tenant branding before login — the tenant is unknown), form, "Forgot password?" link, footer with help link.

| Field | Type | Validation | Required | Max |
|---|---|---|---|---|
| Email | `EmailField`, `autocomplete="username"` | email format | yes | 254 |
| Password | `PasswordField`, `autocomplete="current-password"` | non-empty | yes | 128 chars |

Submit: "Log in". Enter submits.
Copy by error code:
- `auth.login_failed`: "Email or password is incorrect."
- `auth.step_up_required`: "Too many failed attempts. Reset your password using “Forgot password”, or ask your lab administrator to unlock your account."
- `common.rate_limited`: "Too many attempts. Try again in {retry_after_human}."
- `auth.account_locked`: "Your account is locked. Contact your lab administrator."
- `identity.membership_inactive`: "Your account is not active. Contact your lab administrator."
- `identity.tenant_suspended`: "Access for your lab is currently suspended. Contact your lab administrator."
- `identity.platform_ip_denied`: "Platform access is not allowed from this network."
- `common.dependency_unavailable`: "Sign-in is temporarily unavailable. Try again in a few minutes."
Query `?logged_out=1` → info banner "You have been logged out."

### AU-2 MFA challenge
Card: "Enter the 6-digit code from your authenticator app." `OtpInput` (required, `^[0-9]{6}$`), button "Verify", link "Use a different account" (logs out). Error: `auth.mfa_invalid` → "That code didn't work. Check your phone's time is correct and try the newest code." After 5 failures the session is revoked → redirect AU-1 with banner "Too many incorrect codes. Log in again."

### AU-3 MFA enrolment
Stepper (3 steps, text-only `Tabs` styled as steps or `PageHeader` subtitle "Step n of 3"):
1. "Install an authenticator app on your phone (any TOTP app)." [Continue]
2. QR (`DataUriImage`, alt "QR code for your authenticator app"), `SecretRevealOnce` "Can't scan? Enter this key", field "Device name" (optional, ≤40, default "Authenticator").
3. `OtpInput` + "Confirm". Success → "Two-step verification is on." [Continue to LIMS].
Banner when forced: "Your role requires two-step verification before you can continue."

### AU-4 Forgot password
Email field + "Send reset link". After submit always: "If an account exists for {email}, we have sent a reset link. The link works once and expires in 60 minutes." (email echoed from the form, not from the server).

### AU-5 Set password
Fields: New password (`PasswordField`, `autocomplete="new-password"`, 12–128 chars, live checklist: "At least 12 characters", "Not a commonly leaked password (checked when you save)"); Confirm password (must match). Errors: `auth.password_policy_violation` → "Use at least 12 characters (and no more than 72 bytes)."; `auth.password_breached` → "This password appears in known data breaches. Choose a different one." Invite variant title "Welcome to {tenant display_name}" (name from session state), recovery variant "Choose a new password". Token errors: `auth.reset_token_invalid` → "This reset link is invalid or has expired. Request a new one." [Forgot password]; `auth.invite_invalid` → "This invitation link is invalid or has expired. Ask your administrator to resend it."

### AU-6 Logged out / AU-7 Session expired
AU-7 copy: "For your security you were logged out after {n} minutes without activity, or because your session ended." [Log in again]. Reason-specific variants when the API gave a code: locked / suspended / role changed ("Your access was changed by an administrator. Log in again.").

## 5. My account (ME-1)

Tabs:
- **Profile** (read-only): name, email, roles, centre scope, last login (`getMe.last_login_at` = `core.memberships.last_login_at`, 08 A6.3).
- **Security**: "Change password" form (Current password, New password, Confirm; same rules as AU-5; success toast "Password changed. Your other sessions were logged out."); "Two-step verification" card: status `StatusChip` ("On"/"Off"), [Set up] (→ enrolment flow inline, same steps as AU-3), factor list with [Remove] (disabled with tooltip "Your role requires two-step verification" when it is the last factor and MFA is required).
- **Sessions**: `DataTable` columns: Device/browser (UA family), IP (masked), Started, Last active, Expires, Current (badge). Row action [Log out this session] (hidden on current).

## 6. Tenant admin screens

### AD-1 Users
`PageHeader` "Users" + [Invite user] (`n`). `FilterBar`: Status (`Select`: All, Invited, Active, Deactivated; default Active+Invited), Locked (`Select`: Any/Locked/Not locked → API filter `is_locked`, a wire name kept by 08 A6.1; locked = membership `locked_at IS NOT NULL`, 08 Addendum A3.4), Role (`Select` of roles), Centre (`Select`), MFA (Any/On/Off), Search box (calls `searchUsers`; 2–100 chars; debounce 300 ms).
Columns: Name, Email (masked), Status (`StatusChip`: Invited/Active/Deactivated from `status` + "Locked" badge when `locked_at IS NOT NULL` — lock is independent of status), Roles (comma list, max 3 + "+n"), Centres ("All centres" or count), MFA (On/Off text), Last login (relative + exact tooltip; `core.memberships.last_login_at` for this tenant — `core.users.last_login_at` is internal and not shown, 08 A6.3). Sort: Name, Last login, Created.
Empty: "No users match these filters." [Clear filters].

### AD-2 Invite user
| Field | Type | Validation | Required | Default | Max |
|---|---|---|---|---|---|
| Email | EmailField | email | yes | — | 254 |
| Full name | TextField | 1–120 chars | yes | — | 120 |
| Mobile | PhoneField | E.164 `^\+[1-9][0-9]{7,14}$` (same as API and C0 CHECK, 08 A6.2) | no | `+977` prefix shown | 16 |
| Roles | MultiSelect (active roles; privileged roles show "MFA required" tag) | 1–20 | yes | — | 20 |
| Centre access | RadioGroup: "All centres" / "Selected centres" | — | yes | Selected | — |
| Centres | MultiSelect (active centres, grouped by branch) | ≥1 when Selected | cond. | — | 200 |
| Branches | MultiSelect | — | no | — | 50 |
Hub-lab warning (08 A13 D-13(2), A17 D-63) [CONV]: when the selected roles grant any of `lab.specimen.receive`, `lab.result.*`, `micro.culture.read`, `micro.culture.work`, `anatomic.case.read`, `anatomic.case.work`, `anatomic.case.signout` and Centre access is "Selected centres", a warning `Banner` under Centre access reads: "These roles receive or work on samples. Staff who process samples from other collection centres need **All centres** or every collection centre whose samples they process. Before receipt, a sample is visible only at its collection centre." The banner never blocks saving.
Submit "Send invitation" (Ctrl+Enter). Info line: "The user receives an email link valid for a limited time. Roles marked MFA required will have to set up two-step verification." `identity.user_exists` → banner "This email cannot be invited. Use a different email or contact the LIMS provider support."

### AD-3 User detail
Header: name, status badges, actions menu (permission-gated): Lock / Unlock, Deactivate / Reactivate, Resend invitation (status Invited), Reset two-step verification, Log out all sessions.
Tabs:
- **Profile**: Full name (1–120), Mobile (E.164 `^\+[1-9][0-9]{7,14}$`, optional; 08 A6.2), Email (read-only).
- **Roles**: MultiSelect + [Save] (`setUserRoles`); warning text "Saving logs this user out of all sessions."; the AD-2 hub-lab warning `Banner` when the rule matches (D-13).
- **Centre access**: as AD-2 (incl. the hub-lab warning `Banner`) + [Save] with the same session warning.
- **Signatory** (shown when user holds `lab.result.approve` or tenant enables "show signatory tab for all"): Title (≤80, e.g. "MD Pathology"), Registration number (≤40, label "Registration no. (e.g. NMC)"), Signature image `FileUpload` (PNG/JPEG, ≤1 MB, hint "Transparent PNG, at least 600 px wide works best"), `ImagePreview` of current. Copy: "This signature is printed on reports this user approves (configured by report templates)."
- **Sessions**: as ME-1 Sessions, for this user, with [Log out] per row (`identity.session.revoke`).
- **History**: last 50 audit entries for this membership (link to AD-10 filtered).
Lock dialog: Reason (`Select`: Left organisation, Security concern, Policy violation, Other), Details (`Textarea` ≤500; required for Other). Copy: "Locked users are logged out immediately and cannot log in until unlocked."

### AD-4 Roles / AD-5 Role editor
AD-4 columns: Name, Code, Default (badge), MFA required (Yes/No), Members, Status. Action [New role].
AD-5 fields: Name (1–80, required), Code (`^[a-z][a-z0-9_]{1,39}$`, required on create, read-only after), Description (≤500), MFA required (`Switch`; forced on and disabled with hint "Includes privileged permissions" when any privileged code selected), Permissions (`PermissionMatrix`). Footer: [Save] [Deactivate role] (disabled for default roles and roles with members, tooltip explains). Copy: "Changing a role logs out everyone who has it." When the selected permissions include any permission of the AD-2 hub-lab rule, a warning `Banner` above the matrix reads: "Members with these permissions who process samples from other collection centres need **All centres** or every collection centre whose samples they process." (D-13, D-63; warning only).

### AD-6 Branches / AD-7 Collection centres
Tables: Code, Name, (centres: Branch, Type: Own / Franchise / Home collection — value `own|franchise|home_collection`, 08 §4.11 note), Phone, Status. Row click → side `Dialog` editor.
Fields: Code (`^[A-Za-z0-9-]{1,16}$`, required, immutable after create, hint "Printed on reports, e.g. C000000002"), Name (1–120, required), Branch (centres; `Select`, required), Type (centres; `RadioGroup`, default Own), Address (≤300), Phone (≤30), Processing lab (branches; `Switch`, default on).
Empty AD-7: "Add your first collection centre. Home collection can be added as its own centre."

### AD-8 Lab settings (tabs; one `Form` per tab, If-Match per tab save)
| Tab | Fields (type · validation · default) |
|---|---|
| General | Display name (1–120 · from provisioning) · Legal name (read-only; platform edits) · PAN (read-only unless platform; pattern UNVERIFIED) · Address lines (up to 4 × ≤120) · Phones (up to 3 × ≤40) · Contact email (≤254) · Website (≤200, https URL) · Receipt footer note (≤200) · Accent colour (`#RRGGBB`; kit derives accessible variants — C0 04-UI-UX §1.6) (08 §4.12) |
| Date & time | Calendar display (`RadioGroup`: A.D. / B.S. / A.D. + B.S. / B.S. + A.D. · default A.D.) · Timezone (read-only text "Asia/Kathmandu"; the only value in v1, 08 A13 P-15) · note "Bills and statutory registers always show both B.S. and A.D. (04 L11)" |
| Sign-in & sessions | Idle timeout minutes (`NumberField` 15–30 · 15) · Maximum session length hours (1–12 · 12) · Minimum password length (12–64 · 12) · Support access (`RadioGroup`: "Notify me" / "Require my approval" · Notify) |
| Numbering | Prefix (`^[A-Z0-9]{0,8}$` · "") · Patient code pattern · Registration no. pattern · Barcode pattern · Invoice no. pattern · Credit note no. pattern · Receipt no. pattern · Barcode prefix (`^[A-Z0-9]{0,4}$`) · Accession no. pattern + prefixes Histology/Cytology/IHC/Molecular (`^[A-Z0-9]{0,4}$`, defaults S/C/I/M; validated with C11's grammar) — each pattern `TextField` ≤40 with live example (synthetic) and token help ("{branch} {centre} {yy} {fy} {fyl} {seq:N} {prefix}"); pending pattern shown read-only with "Takes effect from FY {fy}" |
| Letterhead & branding | Logo, Letterhead header, Letterhead footer (`FileUpload` PNG/JPEG ≤2 MB ≤4000 px, `ImagePreview`; while `scan_state = 'pending'` the preview shows "Security scan in progress — the image is used once the scan has passed" and no image, 08 A17 P-19) · Default for reports and receipts (`RadioGroup` With letterhead / Without · With) · note "Report layout, watermark and signature placement are set in Report templates." (link to C6 screen if permitted) |
| Reports & delivery | Hold reports until paid (`Switch` · on) · Allow partial release (`Switch` · off) · Report link validity days (30–90 · 30) · Channels: SMS / WhatsApp / Email (`Switch` each · off) · SMS sender ID (`^[A-Za-z0-9]{1,11}$` · empty; hint "provider rules may be stricter") |
| Data retention | Clinical records years (≥5 · 5) · Audit logs years (≥5 · 5) · Raw analyser messages years (≥1 · 1); banner "Legal retention periods are not yet confirmed (B15). These are minimum defaults." |
| Features | table of flags: Name, Description, Status `Switch` (disabled for platform-managed flags, tooltip "Managed by the LIMS provider"), Blocker ref; Referral-incentive report flag copy: "Shows the referral-incentive report (reporting only). Leave off until your management confirms the compliance position (B13)." |
| Billing & IRD | CBMS real-time push required (`Switch` · off; hint "Only taxpayers designated by IRD notice — 04 L6") · Abbreviated invoice limit (paisa → shown in NPR, optional, label "UNVERIFIED — confirm with your auditor") · IRD Annex status (read-only table: Annex, Status, Reference no., Date) + banner "IRD submission requirements are pending clarification (B6). This tracker records status only." |
| Lab operations | Auto-verification enabled (`Switch` · off; disabled with "Available in Phase 2" until C9 is deployed) · Westgard mode (`Select` classic/modern · classic, hint "default pending QC module design") |

Save copy: "Saved. Other screens update within 30 seconds."

### AD-9 Active sessions
Columns: User, Started, Last active, Expires, IP (masked), Browser, Two-step (aal2 → "Verified"), Support (badge). Filters: User search, Support only. Row action [Log out].

### AD-10 Audit log
Filters: Date range (required; default last 24 h; max 31 days, inline error "Choose 31 days or fewer"), Table (`Select` from allowlist, labels "frontdesk.orders" etc.), Action (Insert/Update), User (`Select` via `searchUsers`), Centre, Record id (UUID text), Request id (UUID), Support session (UUID).
Columns: Time, User, Action, Table, Record id (short form + copy), Centre, Changed fields (count + names tooltip), Support (badge). Row → AD-11. Header action [Export…] (requires `audit.log.export`).
### AD-11 Audit entry
`KeyValueList` (time, user, action, table, record id, request id, IP, user agent, centre, support session) + `DiffTable`. Notice line: "Your viewing of this entry is recorded."
### AD-12 Access log / Sign-in events
Same pattern; access-log columns: Time, User, Event, Entity type, Entity id, Centre. Sign-in columns: Time, User, Event, Reason, IP, Browser.
### AD-13 Exports
[New export] dialog: Source (`RadioGroup` Audit log / Access log / Sign-in events), Date range (≤31 days), source filters, Format (CSV only). Warning `Banner`: "Exports are limited, recorded, and every administrator of your lab is notified. Exports do not include changed values." Submit "Create export". A caller whose centre access is not "All centres" gets `auth.forbidden` → banner "Exports need access to all centres. Ask another administrator." [CONV]. Table: Created, Requested by, Source, Range, Status, Rows, Expires, Downloads left, [Download] (requester only).
### AD-14 the LIMS provider support access
Pending requests (cards with staff name, reason, ticket, requested duration, [Approve] [Deny]); Active (with [End access]); History table.
### AD-15 Access review
Table: User, Roles, Centres, MFA, Last login (`core.memberships.last_login_at`, 08 A6.3), Status; "Last review: {date} by {name}" `Banner` (warning when > 90 days); [Record review completed] dialog (Notes ≤2000, count auto-filled).

## 7. Platform console screens (`(platform)` layout: distinct header colour token "platform" + persistent label "PLATFORM CONSOLE — the LIMS provider staff only" [CONV])

- **PL-1 Home**: tiles: tenants by status, open dead letters, active support sessions, tenants with incomplete IRD annexes.
- **PL-2 Tenants**: columns Code, Display name, Status, Users, Centres, IRD readiness (Complete/Incomplete), Created. [Provision tenant] wizard (single page, sections): Tenant (code `^[a-z][a-z0-9_]{2,31}$` — C0 `tenant_code` CHECK, 08 Addendum A3.3, legal name 1–200, display name 1–120, PAN optional, timezone (read-only text "Asia/Kathmandu", P-15), calendar display), First branch (code, name, address), First centre (code, name, type, address), First administrator (email, full name). Submit "Provision tenant" → result page with checklist (created items) and "Invitation sent".
- **PL-3 Tenant detail** tabs: Overview (status `Timeline`, actions Activate/Suspend/Reactivate/Terminate), Settings (full settings form incl. platform-only fields), Feature flags (switch + Approval reference field ≤200, required when enabling flags marked "Founder approval"), IRD annexes (as PL-4 filtered), Administrators (invite additional tenant admin), Support sessions.
- **PL-4 IRD Annex tracker**: matrix rows = tenants, columns = Annex 1 (platform), Annex 2, Annex 3, Annex 7, each cell `StatusChip`; cell click → record panel: status + allowed transition buttons, fields (Reference no. ≤100, Tax office ≤200, Counterparty (Annex 7) ≤200, Software version (Annex 1) ≤40, Submitted on, Completed on, Notes ≤2000), documents list with upload (PDF/PNG/JPEG ≤15 MB) and download (a document whose scan is still pending shows "Scan pending"; download returns `422 common.upload_quarantined` until clean, P-19), `Timeline`. Transition to Superseded opens the new successor record (IR7). Persistent banner: "Tracking only. IRD checklist and Annex 7 template are pending IRD clarification (B6)."
- **PL-5 Support sessions**: [Open support session] dialog: Tenant (`Select`), Scope (Read only / Admin — Admin only for superadmin), Reason (10–500, hint "No patient details"), Ticket reference (1–60), Duration minutes (5–60, default 30). Active session card with countdown and [Go to tenant admin] (navigates to `/admin` in support mode) and [End].
- **PL-6 Dead letters**: filters State (default Open), Platform tasks only (`Checkbox`, default off → query param `platform_rows`, 08 A10.2; when on, the Tenant filter is cleared and disabled, because the API rejects `platform_rows=true` with `tenant_id` with `400 common.validation_failed`), Tenant, Task, Dead at range (query params `state`, `tenant_id`, `task_identifier`, `dead_at_from`/`dead_at_to` of `listDeadLetters`, 08 A9.2); columns Dead at, Tenant, Task, Attempts, Last error code, State. Detail (`getDeadLetter` → `DeadLetterRow`, C0 02-TRD §6.8; `404 common.not_found` for an unknown id, 08 A9.1): task, tenant, attempts, first failed at, dead at, last error code, redacted error message, state, resolved by/at, resolution note (the discard reason or the optional replay note, shown for resolved rows when set; 08 A8.4, A9.3) as `KeyValueList`; no job payload is shown — the API never returns `job_payload` (08 A8.5). [Replay] (confirm dialog with an optional Note `Textarea`, 1–500 chars when filled, sent as `reason_text` and stored as `resolution_note`, 08 A9.3), [Discard] (reason required, 1–500 chars, sent as `reason_text` and stored as `resolution_note`). Both send the row's `version` (from the list/detail response, 08 A8.5) as If-Match (→ `expectedVersion`, 08 A6.4); `409 common.version_conflict` → the §3 reload dialog.
- **PL-7 Platform staff**: table Name, Email, Role, Allowed networks, MFA, Status; invite dialog (email, name, role, allowed CIDRs as chips validated `x.x.x.x/nn` or IPv6 CIDR); sessions tab with [Log out].
- **PL-8 Sign-in events**: filters Date range (≤31 d), Tenant (incl. "No tenant"), Event; columns Time, Tenant, User, Event, Reason, IP, Browser.

## 8. Accessibility and responsive rules

- Every input has a visible `<label>`; hints and errors linked via `aria-describedby`; error summary at top of forms with links to fields on submit failure.
- Status never by colour alone (text labels in `StatusChip`; diff markers in `DiffTable`).
- Focus moves to the page heading on navigation and to the first error on failed submit; dialogs trap focus and return it on close.
- OTP input announces "6-digit code"; QR has a text alternative (secret key).
- Session-expiry warning: 2 minutes before idle expiry the shell (C0) shows a `Dialog` "You will be logged out in 2 minutes due to inactivity" [Stay logged in] — requested in CR-C2-009 using `idle_expires_at` from `SessionState`.
- Responsive: admin/platform screens are desktop-first (≥1024 px); at < 768 px tables switch to stacked cards; auth screens fully usable at 360 px width.
- Contrast and tokens from `@lims/ui`; no custom colours.
