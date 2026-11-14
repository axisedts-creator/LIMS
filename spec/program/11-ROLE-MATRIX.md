# 11 — Role matrix → permission templates (RBAC pack)

Status: DRAFT for client confirmation · Date: 2026-11-13 · Owner: program lead · Applies to: C2 (identity/admin), every chunk's route and UI guards
Inputs: `Corporate_User_Role_Matrix_New_1.xlsx` (two sheets: **ELabCorp**, 19 roles × 80 rows; **ELabAssist**, 10 roles × 44 rows) and `contracts/permissions.yaml` (186 permission codes). The sheets are menu-level ticks (screen visible yes/no). The registry is action-level. This document is the bridge and lists every place where the bridge needed a judgement.

## 1. Which sheet is Metro's

The ElabAssist capture of Metro's current software (`corpmain.elabassist.com`) lists role names in User Management that match the **ELabCorp** sheet (Accession User, Accounts, Franchise User, Client Operator, Laboratory Admin, Laboratory Lab User, Laboratory User, Collection Center, Pathologist …). So ELabCorp is built as the **default pack for Metro** and ELabAssist as the **standard pack** for other tenants (pack codes `elabcorp_default`, `elabassist_standard`). This is an assumption (D1); one line from the client settles it.

## 2. Rules (binding for the C2 tasks below)

| # | Rule | Why |
|---|---|---|
| R1 | A tick grants the permissions of that screen (table §5), nothing more. | Replicates today's access without widening it. |
| R2 | **Decision authorities are never inferred from a menu tick**: result verify/approve/amend, narrative sign, histopathology sign-out, refund, payment reverse, invoice cancel, discount approve. They come only from the explicit overlay in §3, chosen by role name. | The sheet ticks screens, not who may sign a report; Pathologist and Sr. Lab User do not even have the Pathology Result screen ticked, so the sheet alone cannot say who authorises results. |
| R3 | Any privileged permission in a template forces MFA for that role (existing C2 rule). Counts are shown in §3. | `permissions.yaml` semantics. |
| R4 | Safety caps: `identity.role.manage` and `identity.user.manage` only on the pack's Admin role (C1; a user manager can create an Admin user, so it is an escalation path unless C2 limits assignable roles); `instruments.instrument.manage` and `catalog.instrument_code_map.manage` only on Admin, the three Sr. Lab User roles and (ELabAssist) Lab technician (C2). A tick elsewhere is dropped and listed in the role's appendix entry. | A role editor can grant itself anything; a wrong instrument code map changes patient results (C7 D-18). The sheet ticks both for centre and sales roles, which looks like template copying. |
| R5 | Admin (`corp_admin` / `std_admin`) = default role `tenant_admin` ∪ all ticked screens. It holds no clinical sign-off. | Separation of duties: the lab owner/IT admin is not a signing pathologist. |
| R6 | Templates are **custom roles** (S9) seeded at tenant provisioning (S14) and editable afterwards by `identity.role.manage` holders. Template codes carry a pack prefix (`corp_`, `std_`) so they never collide with the ten default role codes (`pathologist` and `finance` are default codes; a plain `pathologist` template would have collided). | No registry change needed; tenant can adjust. |
| R7 | Screens with no spec home (§6) grant nothing and are listed as gaps, never silently dropped. | No false claim of coverage. |
| R8 | Row-level scope (centre, franchise, client, outsource lab) is enforced by RLS on the user's assigned entities, not by the role. | Reference product asks for Franchise/Client/Collection Center per user; same idea. |

## 3. Role templates

### 3.1 ELabCorp pack (`elabcorp_default`)

| Role (as in sheet) | Template code | Screens ticked | Permissions | Privileged (forces MFA) | Notes |
|---|---|---:|---:|---:|---|
| Admin | `corp_admin` | 68 | 92 | 33 | Default role `tenant_admin` plus every screen the sheet ticks. Holds NO clinical sign-off (result approve/amend, narrative sign): those stay with a pathologist identity. |
| Accession User | `corp_accession_user` | 7 | 22 | 0 | Ticks: Dashboard, Search, Accession, Manual OutSource, Patient Registration, User Management, Change Password. |
| Accounts | `corp_accounts` | 3 | 18 | 6 | Sheet ticks only Search, Manual OutSource, Change Password. Accounting authority below is added from the role name (see D3). Needs the client to confirm. |
| Franchise User | `corp_franchise_user` | 10 | 24 | 0 | Entity-scoped in the reference system (User Management asks for a Franchise). Template is a centre-scoped tenant role; see D4. |
| Client Operator | `corp_client_operator` | 27 | 44 | 8 | Machine Mapping tick dropped by safety cap C2 (not a laboratory role). |
| Laboratory Admin | `corp_laboratory_admin` | 4 | 11 | 0 | Sheet ticks Dashboard, Search, Accession, Manual OutSource only (plus Expense, which has no home in the spec). |
| Laboratory Lab User | `corp_laboratory_lab_user` | 5 | 24 | 0 | Treated as an entry-level tier (D2). |
| Laboratory User | `corp_laboratory_user` | 10 | 18 | 0 | Treated as an entry-level tier (D2). |
| Collection Center | `corp_collection_center` | 27 | 22 | 1 | Role Management and User Management ticks dropped by safety cap C1. Entity-scoped by centre. |
| IT Department | `corp_it_department` | 3 | 5 | 0 | Only Dashboard, Search, Change Password are ticked. |
| Junior Lab User | `corp_junior_lab_user` | 6 | 24 | 0 | Enter results only; no verification. Reference product shows a separate "Sr.Technician Authorized" status, which this tier cannot set. |
| Sr.Lab User | `corp_sr_lab_user` | 24 | 51 | 9 | Identical to the two roles below it in the sheet; probably one role under three names (D6). |
| Sr. Lab User_T2 | `corp_sr_lab_user_t2` | 24 | 51 | 9 | Identical to Sr.Lab User and Senior Lab User; meaning of T2 undocumented (D5, D6). |
| Pathologist | `corp_pathologist` | 14 | 45 | 7 | Clinical authority overlay (verify, approve, amend, narrative sign, histopathology sign-out). Pathology Result screen is NOT ticked for this role in the sheet; authority comes from the role name (D2). |
| Pathologist_T2 | `corp_pathologist_t2` | 13 | 44 | 7 | Sheet gives fewer screens than Pathologist; meaning of T2 is not documented (D5). Same clinical overlay. |
| Pathologist_T3 | `corp_pathologist_t3` | 11 | 40 | 7 | Sheet gives fewer screens than Pathologist and ticks Pathology Result; meaning of T3 is not documented (D5). Same clinical overlay. |
| Client User | `corp_client_user` | 22 | 21 | 3 | Ticks 22 screens, mostly account ledgers and invoices: looks like a client's own login. Better served by the partner portal (C13); see D4. |
| Sales Person | `corp_sales_person` | 21 | 35 | 7 | Sheet ticks laboratory, doctor, franchise, centre and machine masters for this role; looks copied from another column (D7). Machine Mapping dropped by safety cap C2. Sales screens have no spec home. |
| Senior Lab User | `corp_senior_lab_user` | 24 | 51 | 9 | Identical to Sr.Lab User and Sr. Lab User_T2 (D6). |

Authority overlay (R2), all marked assumptions until D2/D3 are answered: **Pathologist, Pathologist_T2, Pathologist_T3** get the clinical sign-off set (verify, approve, amend, critical values, report release/render/regenerate, narrative write/sign, histopathology work/sign-out, smart-report read). **Sr.Lab User, Sr. Lab User_T2, Senior Lab User** get entry + verify + critical values (read, log notification) + QC capture + worksheet management. **Laboratory Lab User** gets entry + critical values (read, log notification). **Junior Lab User, Laboratory User** get entry only. (CR-C2-RM-002, founder ruling 2026-11-13: the data file and the section 9 appendix are the source of truth for these four roles; the clinical-safety review of who may log critical values stays with the client, D2.) **Accounts** gets invoice cancel, payment reverse, refund request/approve, discount approve and the read side of ledgers and cash reports. **Laboratory Admin** gets worksheet management and the status board. **Collection Center** gets specimen collect and label print.

### 3.2 ELabAssist pack (`elabassist_standard`)

| Role (as in sheet) | Template code | Screens ticked | Permissions | Privileged (forces MFA) | Notes |
|---|---|---:|---:|---:|---|
| Admin | `std_admin` | 41 | 85 | 30 | Default role `tenant_admin` plus every screen the sheet ticks. |
| Reception | `std_reception` | 8 | 18 | 0 | Ticks: Search, Test Registration, Print Report, Barcode Printing, Turn Around Time (TAT), Summary Sheet, Transfer Reg and 1 more. |
| Accession | `std_accession` | 14 | 25 | 0 | Ticks: Search, Test Registration, Print Report, Worksheet, Pending test, Collection Sheet, Dispatch Sheet and 7 more. |
| Lab technician | `std_lab_technician` | 29 | 40 | 0 | Entry and first verification (D2). |
| Consulting Pathologist | `std_consulting_pathologist` | 2 | 20 | 5 | Only Test Result and Print Report style access is ticked; clinical authority is added from the role name (D2). |
| Collection Center User | `std_collection_center_user` | 11 | 21 | 0 | Ticks: Search, Test Registration, Print Report, Pending test, Workflow History, Payment History, Barcode Printing and 4 more. |
| Collection Center Admin | `std_collection_center_admin` | 12 | 21 | 0 | Ticks: Search, Test Registration, Reports, Print Report, Workflow History, Payment History, Barcode Printing and 5 more. |
| Collection Boy | `std_collection_boy` | 6 | 19 | 0 | Maps to the home-collection app user (offline upload, payment record). |
| Affiliation / Hospital User | `std_affiliation_hospital_user` | 5 | 17 | 0 | Ticks: Search, Test Registration, Print Report, Pending test, Summary Sheet. |
| Account | `std_account` | 12 | 25 | 6 | Accounting authority added from the role name (D3). |

The last four rows of the ELabAssist sheet ("Discount Reason", "Discount Authorithy", "Change Password", "Collection Center Boy" under the heading MIS reports) carry values for only the first three roles and are mis-grouped. Only "Change Password" is honoured; the rest are ignored (R1) and listed as D8.

## 4. Tests that prove it (C2 and each UI chunk)

1. **Pack integrity**: every code in `11-ROLE-MATRIX.data.yaml` exists in `contracts/permissions.yaml`; no template code equals a default role code; a role with ≥ 1 privileged code is created with `mfa_required = true`.
2. **Matrix replay**: a generated test iterates every (role, feature) cell of both sheets; a ticked cell → the role holds all permissions of that feature (except capped codes); an unticked cell → the role holds none of the permissions that belong **only** to that feature.
3. **Guard test per screen**: for each staff web route, a role without the route's permission gets `403` from the API and no nav entry in the shell; a role with it gets both.
4. **Escalation test**: a user holding `corp_admin` minus `identity.role.manage` cannot create or edit a role (R4).
5. **Seed test**: provisioning a tenant with pack `elabcorp_default` creates 19 roles whose permission sets equal the data file byte for byte (sorted).

## 5. Screen → permission map

### 5.1 ELabCorp sheet

| Sheet group | Feature (as in sheet) | Roles ticked | Status | Registry permissions it grants |
|---|---|---:|---|---|
| Menu | Dashboard | 16 | ok | `lab.status_board.read`, `frontdesk.order.read` |
| Menu | Search | 18 | ok | `frontdesk.order.read`, `frontdesk.patient.read`, `reporting.report.read` |
| Menu | Accession | 14 | ok | `lab.specimen.read`, `lab.specimen.collect`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.specimen.label_print` |
| Menu | Manual OutSource | 12 | ok | `lab.specimen.read`, `reporting.outsourced.attach` |
| Menu | Patient Registration | 13 | ok | `frontdesk.registration.create`, `frontdesk.order.read`, `frontdesk.order.edit`, `frontdesk.patient.read`, `frontdesk.trf.upload`, `catalog.test.read`, `catalog.referrer.read`, `catalog.price_list.read`, `billing.invoice.read`, `billing.invoice.issue`, `billing.invoice.reprint`, `billing.payment.record`, `lab.specimen.label_print` |
| Menu | Pathology Result | 3 | ok | `lab.worklist.read`, `lab.result.read`, `lab.result.enter`, `lab.specimen.read`, `lab.critical_value.read`, `lab.critical_value.log_notification`, `reporting.report.read` |
| Menu | ActivityLog History | 1 | ok | `audit.log.read` |
| User Management | User Management | 4 | ok | `identity.user.read`, `identity.user.manage` |
| User Management | User Lock Management | 1 | ok | `identity.user.read`, `identity.user.manage` |
| User Management | Role Management | 2 | ok | `identity.role.manage`, `identity.user.read` |
| User Management | Change Password | 16 | ok | `identity.self.manage` |
| Ops Master | Laboratory Management | 2 | ok | `identity.centre.read`, `identity.centre.manage`, `identity.settings.manage` |
| Ops Master | Doctor Management | 3 | ok | `catalog.referrer.read`, `catalog.referrer.manage` |
| Ops Master | Patient Management | 3 | ok | `frontdesk.patient.read` |
| Ops Master | Franchise Management | 3 | ok | `partners.partner.read`, `partners.partner.manage` |
| Ops Master | Collection Center | 3 | ok | `identity.centre.read`, `identity.centre.manage` |
| Ops Master | Client | 6 | ok | `billing.credit_party.read`, `billing.credit_party.manage`, `partners.partner.read` |
| Ops Master | Collection Boy | 3 | ok | `homecollection.visit.read`, `homecollection.visit.assign` |
| Ops Master | Consultant | 6 | ok | `catalog.referrer.read`, `catalog.referrer.manage` |
| Ops Master | Sales Representative | 6 | gap | **no spec home** |
| Ops Master | Sales Designation | 6 | gap | **no spec home** |
| Ops Master | Sales Client List | 6 | gap | **no spec home** |
| Ops Master | Online Payment Logger | 6 | ok | `payments.reconciliation.read` |
| Ops Master | Whatsapp Logger | 6 | ok | `reporting.delivery.read` |
| Ops Master | Method Master | 6 | ok | `catalog.test.read`, `catalog.test.manage` |
| Ops Master | Franchise Details | 6 | ok | `partners.partner.read`, `partners.partner.manage` |
| Ops Master | Membership | 6 | ok | `engagement.membership.read`, `engagement.membership.enrol`, `engagement.membership_plan.manage` |
| Ops Master | Outsource Lab | 6 | ok | `reporting.outsourced.attach`, `reporting.settings.manage` |
| Ops Master | Inter Lab Mapping | 6 | ok | `catalog.test.read`, `catalog.test.manage` |
| Ops Master | Center Test Mapping | 6 | ok | `catalog.test.read`, `catalog.test.manage` |
| Ops Master | Contact Us | 6 | ok | `identity.settings.manage` |
| Ops Master | Machine Mapping | 6 | ok | `instruments.instrument.read`, `instruments.instrument.manage`, `catalog.instrument_code_map.manage`, `instruments.message.read` |
| Accounting | Laboratory Accounting | 5 | ok | `catalog.price_list.read`, `catalog.price_list.manage` |
| Accounting | Invoice | 2 | ok | `billing.invoice.read`, `billing.invoice.issue`, `billing.invoice.reprint`, `billing.credit_party.read` |
| Accounting | Rate Master | 1 | ok | `catalog.price_list.read`, `catalog.price_list.manage` |
| Accounting | Discount | 2 | ok | `catalog.price_list.read`, `catalog.price_list.manage` |
| Accounting | AccontGroupMaster | 1 | gap | **no spec home** |
| Accounting | AccountPerticularMaster | 1 | gap | **no spec home** |
| Test Management | Test Details | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Test Management | Test Category | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Test Management | Test Group | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Test Management | Test Profile | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Test Management | Test Unit | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Test Management | Notes | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Test Management | Popular Test | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Test Management | Compare Test List | 2 | ok | `catalog.test.read` |
| Test Management | Upload Special Offers | 2 | ok | `catalog.price_list.read`, `catalog.price_list.manage` |
| Test Management | Batch Upload | 2 | ok | `frontdesk.registration.create` |
| Test Management | Speciman Details | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Demographic Changes | View | 2 | ok | `frontdesk.patient.read` |
| Expense Management | Expense | 12 | gap | **no spec home** |
| Expense Management | Expense Type | 11 | gap | **no spec home** |
| elab Dashboard | (row has no feature name) elab Dashboard | 1 | ok | `analytics.dashboard.read` |
| Reports | Report Setup | 5 | ok | `reporting.template.manage`, `reporting.settings.manage` |
| Reports | MIS Report | 5 | ok | `analytics.dashboard.read`, `analytics.collections.read`, `billing.cash_report.read` |
| Device Request | Pickup Request | 1 | ok | `partners.pickup.manage`, `homecollection.visit.read` |
| Device Request | Patient Appointment | 1 | ok | `engagement.booking.read`, `engagement.booking.manage` |
| Device Request | Message Laboratory | 1 | ok | `engagement.enquiry.read`, `engagement.enquiry.respond` |
| Device Request | Schedular | 1 | ok | none (dead screen in reference product) |
| Device Request | Trip Management | 1 | ok | `homecollection.visit.read`, `homecollection.visit.assign` |
| Accounts | Account Entry | 3 | ok | `billing.credit_party.read`, `billing.payment.record` |
| Accounts | View Account | 2 | ok | `billing.credit_party.read` |
| Accounts | Bill Of The Day | 2 | ok | `billing.invoice.read` |
| Accounts | Test Rate Card | 2 | ok | `catalog.price_list.read` |
| Accounts | Account Summary | 2 | ok | `billing.credit_party.read` |
| Accounts | Account Ledger | 2 | ok | `billing.credit_party.read` |
| Accounts | Pocket Ledger | 2 | ok | `billing.credit_party.read` |
| Accounts | Client Ledger | 2 | ok | `billing.credit_party.read` |
| Accounts | Daily Payment Collection | 2 | ok | `billing.cash_report.read` |
| Accounts | Rate Change Log | 2 | ok | `catalog.price_list.read` |
| Cash Transfer | (row has no feature name) Cash Transfer | 12 | ok | `homecollection.handover.receive`, `billing.cash_report.read` |
| QuotationView | (row has no feature name) QuotationView | 12 | ok | `frontdesk.order.read` |
| Re Collect Cancel Test | (row has no feature name) Re Collect Cancel Test | 12 | ok | `frontdesk.order.read`, `frontdesk.order.cancel`, `lab.specimen.read` |
| Radiology  Results | (row has no feature name) Radiology  Results | 12 | ok | `reporting.report.read` |
| Histopathology Results | (row has no feature name) Histopathology Results | 12 | ok | `anatomic.case.read` |
| Logistics | Material Request | 1 | ok | `inventory.item.read` |
| Logistics | Matrial Accept | 1 | ok | `inventory.item.read` |
| Logistics | Catelogue Viw | 1 | ok | `inventory.item.read` |

### 5.2 ELabAssist sheet

| Sheet group | Feature (as in sheet) | Roles ticked | Status | Registry permissions it grants |
|---|---|---:|---|---|
| Menu Options | Search | 9 | ok | `frontdesk.order.read`, `frontdesk.patient.read`, `reporting.report.read` |
| Menu Options | Test Registration | 8 | ok | `frontdesk.registration.create`, `frontdesk.order.read`, `frontdesk.order.edit`, `frontdesk.patient.read`, `frontdesk.trf.upload`, `catalog.test.read`, `catalog.referrer.read`, `catalog.price_list.read`, `billing.invoice.read`, `billing.invoice.issue`, `billing.invoice.reprint`, `billing.payment.record`, `lab.specimen.label_print` |
| Menu Options | Test Result | 3 | ok | `lab.worklist.read`, `lab.result.read`, `lab.result.enter`, `lab.specimen.read`, `lab.critical_value.read`, `lab.critical_value.log_notification`, `reporting.report.read` |
| Menu Options | Administration | 3 | ok | none (dead screen in reference product) |
| Menu Options | Reports | 4 | ok | `analytics.dashboard.read`, `analytics.collections.read`, `billing.cash_report.read` |
| Menu Options | Device (Mobile) Request | 2 | ok | `partners.pickup.manage`, `homecollection.visit.read`, `engagement.booking.read`, `engagement.booking.manage` |
| Menu Options | Dashboard | 1 | ok | `lab.status_board.read`, `frontdesk.order.read` |
| Menu Options | Radiology Report | 2 | ok | `reporting.report.read` |
| Operations Management | Print Report | 10 | ok | `reporting.report.read`, `reporting.report.print` |
| Operations Management | Worksheet | 4 | ok | `lab.worksheet.manage`, `lab.worklist.read` |
| Operations Management | Pending test | 6 | ok | `lab.status_board.read`, `lab.worklist.read` |
| Operations Management | Collection Sheet | 3 | ok | `homecollection.visit.read`, `lab.specimen.read` |
| Operations Management | Dispatch Sheet | 4 | ok | `reporting.delivery.read`, `lab.specimen.read` |
| Operations Management | Workflow History | 6 | ok | `lab.specimen.read`, `lab.result.read` |
| Operations Management | Payment History | 6 | ok | `billing.invoice.read`, `billing.cash_report.read` |
| Operations Management | Barcode Printing | 8 | ok | `lab.specimen.label_print` |
| Operations Management | Turn Around Time (TAT) | 4 | ok | `quality.tat_alert.read` |
| Operations Management | Summary Sheet | 9 | ok | `frontdesk.order.read` |
| Operations Management | Transfer Reg | 8 | ok | `frontdesk.order.read`, `lab.specimen.read` |
| Master Data Management | Centers, Affiliations, Referring Doctors | 1 | ok | `identity.centre.read`, `identity.centre.manage`, `partners.partner.read`, `partners.partner.manage`, `catalog.referrer.read`, `catalog.referrer.manage` |
| Master Data Management | Test, Profile and Parameter Setup | 1 | ok | `catalog.test.read`, `catalog.test.manage` |
| Master Data Management | Notes, Unit setup | 2 | ok | `catalog.test.read`, `catalog.test.manage` |
| Master Data Management | User Management | 1 | ok | `identity.user.read`, `identity.user.manage` |
| Master Data Management | Lab level configurations | 1 | ok | `identity.settings.manage`, `lab.config.manage`, `reporting.settings.manage`, `frontdesk.settings.manage`, `billing.settings.manage` |
| Accounting | Configure base rates | 1 | ok | `catalog.price_list.read`, `catalog.price_list.manage` |
| Accounting | Discounts specific to centers and affiliations | 1 | ok | `catalog.price_list.read`, `catalog.price_list.manage` |
| Accounting | Copy rates from one center to other | 1 | ok | `catalog.price_list.read`, `catalog.price_list.manage` |
| Accounting | Bill Receipt | 4 | ok | `billing.invoice.read`, `billing.invoice.reprint` |
| Accounting | Various Payment modes | 1 | ok | `billing.payment.record`, `billing.settings.manage` |
| Accounting | Test level, Patient level discount | 1 | ok | `frontdesk.discount.apply` |
| Accounting | Discount Authorization | 1 | ok | `frontdesk.discount.approve` |
| Inventory Management | Consumption tracking at multiple levels – Patient, Test, Frequency | 2 | ok | `inventory.item.read`, `inventory.bench.record` |
| Inventory Management | Reorder level alerts | 2 | ok | `inventory.item.read` |
| Inventory Management | Item Master, Barcoding | 2 | ok | `inventory.item.read`, `inventory.master.manage` |
| Inventory Management | Supplier Management | 2 | ok | `inventory.master.manage`, `inventory.po.manage` |
| MIS reports | Consolidated income statement | 2 | ok | `analytics.dashboard.read`, `analytics.collections.read` |
| MIS reports | Bill to Doctor | 2 | ok | `billing.invoice.read`, `billing.credit_party.read` |
| MIS reports | Daily cash receipt | 5 | ok | `billing.cash_report.read` |
| MIS reports | Center Summary and detail report | 3 | ok | `analytics.dashboard.read` |
| MIS reports | Turn Around Time Analysis | 2 | ok | `quality.tat_alert.read`, `analytics.dashboard.read` |
| MIS reports | Discount Reason | 2 | ragged | ignored (ragged row) |
| MIS reports | Discount Authorithy | 2 | ragged | ignored (ragged row) |
| MIS reports | Change Password | 2 | ok | `identity.self.manage` |
| MIS reports | Collection Center Boy | 2 | ragged | ignored (ragged row) |

## 6. Gaps: ticked in the client's sheet, no module in the spec

| Feature | Roles ticked (ELabCorp) | Where the reference product has it | Proposed handling |
|---|---:|---|---|
| Expense, Expense Type | 12 / 11 | Expense Management (stationery, advance salary, fuel, transport, canteen) | Client decision (D9): add a small expense log to C4/C15, or leave to their accounting software. |
| Sales Representative, Sales Designation, Sales Client List | 6 each | Sales masters and a client list per sales person | Client decision (D10): needed only if sales staff are paid or tracked per client. |
| AccountGroupMaster, AccountParticularsMaster | 1 each | Chart-of-accounts masters | Likely out of scope: C4 invoices and C8 reports cover billing; accounting stays in the lab's accounting software. Confirm (D11). |

## 7. Open decisions for the client (defaults I built in)

| ID | Question | Default built in |
|---|---|---|
| D1 | Is ELabCorp Metro's current role set? | Yes. |
| D2 | Who may verify and approve results? The sheet cannot say. | Pathologist* approve; Sr/Senior Lab Users verify; Junior/Laboratory (Lab) User enter only. |
| D3 | Who may cancel invoices, reverse payments, approve refunds and discounts? The Accounts column has almost nothing ticked. | `corp_accounts` plus Admin (discount approve only). Refund approver must differ from requester (two-person rule exists in C4). |
| D4 | Are Franchise User, Client Operator, Client User, Collection Center outside parties? | Built as tenant roles scoped by RLS. If they log in from outside the lab, move Franchise User and Client User to the partner portal (C13); no change to the other roles. |
| D5 | What do the _T2 / _T3 suffixes mean? | Treated as separate roles with the sheet's own screen ticks and the same authority overlay. |
| D6 | Are Sr.Lab User, Sr. Lab User_T2 and Senior Lab User one role? | Kept as three identical templates; merge on request. |
| D7 | Does Sales Person really manage lab, doctor, franchise and centre masters? | Built as ticked, machine mapping dropped by cap. Looks like a template copy; confirm. |
| D8 | Intended meaning of the mis-grouped last rows of the ELabAssist sheet. | Ignored except Change Password. |
| D9–D11 | See §6. | Gaps recorded, nothing granted. |
| D12 | The sheet ticks User Management for Accession User, Collection Center and Pathologist. Do centre staff create their own centre's users? | Capped (R4). If yes, C2 needs a rule "a user manager may assign only roles at or below their own" (new CR) before the tick can be honoured. |

## 8. Implementation tasks

Raised as C2 tasks `RM-T01 … RM-T05` in `C2-identity-admin.json` (lane C2b; binding lead decision LD-141 in the global `lead-decisions.md`): **RM-T01** data file and loader (the data file is copied unchanged into `services/api/src/modules/identity/role-packs/`); **RM-T02** seeding at tenant provisioning and safe re-apply (service and CLI only); **RM-T03** matrix-replay and per-route guard tests; **RM-T04** escalation and decision-authority tests; **RM-T05** admin screen to apply or re-apply a pack with a diff (needs the HTTP operation `applyRolePack`, so a CR to C0, `CR-C2-RM-001`, must be accepted first; the same CR may add `contracts/role-packs.yaml` generated from the data file).

## 9. Appendix — permissions per role (`*` = privileged)

### 9.1 ELabCorp

#### Admin  (`corp_admin`) — 92 permissions, 33 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`, `analytics.data.export`*, `analytics.schedule.manage`
- **anatomic**: `anatomic.case.read`
- **audit**: `audit.log.export`*, `audit.log.read`*
- **billing**: `billing.cash_report.read`, `billing.credit_party.manage`*, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`, `billing.release.override`*, `billing.settings.manage`*
- **catalog**: `catalog.instrument_code_map.manage`*, `catalog.price_list.manage`*, `catalog.price_list.read`, `catalog.referrer.export`*, `catalog.referrer.manage`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.bookable_item.manage`, `engagement.booking.manage`, `engagement.booking.read`, `engagement.enquiry.read`, `engagement.enquiry.respond`, `engagement.link.read`, `engagement.link.revoke`, `engagement.membership.enrol`, `engagement.membership.read`, `engagement.membership_plan.manage`*, `engagement.queue.manage`, `engagement.reminder.read`, `engagement.settings.manage`*, `engagement.slot.manage`
- **frontdesk**: `frontdesk.discount.approve`*, `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.anonymise`*, `frontdesk.patient.merge`*, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.settings.manage`*, `frontdesk.trf.upload`
- **homecollection**: `homecollection.device.manage`*, `homecollection.handover.receive`, `homecollection.settings.manage`*, `homecollection.visit.assign`, `homecollection.visit.read`
- **identity**: `identity.centre.manage`*, `identity.centre.read`, `identity.role.manage`*, `identity.self.manage`, `identity.session.revoke`*, `identity.settings.manage`*, `identity.user.manage`*, `identity.user.read`
- **instruments**: `instruments.agent.manage`*, `instruments.instrument.manage`*, `instruments.instrument.read`, `instruments.message.read`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.result.enter`, `lab.result.read`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`
- **partners**: `partners.partner.manage`*, `partners.partner.read`, `partners.pickup.manage`, `partners.referrer.map`
- **payments**: `payments.merchant_config.manage`*, `payments.merchant_config.read`, `payments.reconciliation.read`*
- **reporting**: `reporting.channel.manage`*, `reporting.delivery.read`, `reporting.message_template.manage`*, `reporting.outsourced.attach`, `reporting.report.bulk_download`*, `reporting.report.read`, `reporting.settings.manage`*, `reporting.template.manage`*, `reporting.token.revoke`*

#### Accession User  (`corp_accession_user`) — 22 permissions, 0 privileged
- **billing**: `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **identity**: `identity.self.manage`, `identity.user.read`
- **lab**: `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`
- **reporting**: `reporting.outsourced.attach`, `reporting.report.read`
- dropped by safety cap: `identity.user.manage`

#### Accounts  (`corp_accounts`) — 18 permissions, 6 privileged
- **billing**: `billing.cash_report.read`, `billing.credit_party.read`, `billing.invoice.cancel`*, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`, `billing.payment.reverse`*, `billing.refund.approve`*, `billing.refund.request`*
- **frontdesk**: `frontdesk.discount.approve`*, `frontdesk.order.read`, `frontdesk.patient.read`
- **identity**: `identity.self.manage`
- **lab**: `lab.specimen.read`
- **payments**: `payments.reconciliation.read`*
- **reporting**: `reporting.outsourced.attach`, `reporting.report.read`

#### Franchise User  (`corp_franchise_user`) — 24 permissions, 0 privileged
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`
- **lab**: `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`
- **reporting**: `reporting.report.read`

#### Client Operator  (`corp_client_operator`) — 44 permissions, 8 privileged
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.manage`*, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.manage`*, `catalog.price_list.read`, `catalog.referrer.manage`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.membership.enrol`, `engagement.membership.read`, `engagement.membership_plan.manage`*
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`, `homecollection.visit.assign`, `homecollection.visit.read`
- **identity**: `identity.centre.manage`*, `identity.centre.read`, `identity.self.manage`, `identity.settings.manage`*
- **instruments**: `instruments.instrument.read`, `instruments.message.read`
- **lab**: `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`
- **partners**: `partners.partner.manage`*, `partners.partner.read`
- **payments**: `payments.reconciliation.read`*
- **reporting**: `reporting.delivery.read`, `reporting.outsourced.attach`, `reporting.report.read`, `reporting.settings.manage`*
- dropped by safety cap: `catalog.instrument_code_map.manage`, `instruments.instrument.manage`

#### Laboratory Admin  (`corp_laboratory_admin`) — 11 permissions, 0 privileged
- **frontdesk**: `frontdesk.order.read`, `frontdesk.patient.read`
- **lab**: `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worksheet.manage`
- **reporting**: `reporting.outsourced.attach`, `reporting.report.read`

#### Laboratory Lab User  (`corp_laboratory_lab_user`) — 24 permissions, 0 privileged
- **billing**: `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.result.enter`, `lab.result.read`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`
- **reporting**: `reporting.report.read`

#### Laboratory User  (`corp_laboratory_user`) — 18 permissions, 0 privileged
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.read`, `frontdesk.patient.read`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`
- **lab**: `lab.result.enter`, `lab.result.read`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`
- **reporting**: `reporting.outsourced.attach`, `reporting.report.read`

#### Collection Center  (`corp_collection_center`) — 22 permissions, 1 privileged
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`
- **catalog**: `catalog.price_list.manage`*, `catalog.price_list.read`, `catalog.test.manage`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`, `identity.user.read`
- **inventory**: `inventory.item.read`
- **lab**: `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`
- **reporting**: `reporting.outsourced.attach`, `reporting.report.read`
- dropped by safety cap: `identity.role.manage`, `identity.user.manage`

#### IT Department  (`corp_it_department`) — 5 permissions, 0 privileged
- **frontdesk**: `frontdesk.order.read`, `frontdesk.patient.read`
- **identity**: `identity.self.manage`
- **lab**: `lab.status_board.read`
- **reporting**: `reporting.report.read`

#### Junior Lab User  (`corp_junior_lab_user`) — 24 permissions, 0 privileged
- **billing**: `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **identity**: `identity.self.manage`
- **lab**: `lab.result.enter`, `lab.result.read`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`
- **reporting**: `reporting.outsourced.attach`, `reporting.report.read`

#### Sr.Lab User  (`corp_sr_lab_user`) — 51 permissions, 9 privileged
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.manage`*, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.instrument_code_map.manage`*, `catalog.price_list.manage`*, `catalog.price_list.read`, `catalog.referrer.manage`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.membership.enrol`, `engagement.membership.read`, `engagement.membership_plan.manage`*
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`, `identity.settings.manage`*
- **instruments**: `instruments.instrument.manage`*, `instruments.instrument.read`, `instruments.message.read`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.qc.capture`, `lab.result.enter`, `lab.result.read`, `lab.result.verify`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`, `lab.worksheet.manage`
- **partners**: `partners.partner.manage`*, `partners.partner.read`
- **payments**: `payments.reconciliation.read`*
- **reporting**: `reporting.delivery.read`, `reporting.outsourced.attach`, `reporting.report.read`, `reporting.settings.manage`*

#### Sr. Lab User_T2  (`corp_sr_lab_user_t2`) — 51 permissions, 9 privileged
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.manage`*, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.instrument_code_map.manage`*, `catalog.price_list.manage`*, `catalog.price_list.read`, `catalog.referrer.manage`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.membership.enrol`, `engagement.membership.read`, `engagement.membership_plan.manage`*
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`, `identity.settings.manage`*
- **instruments**: `instruments.instrument.manage`*, `instruments.instrument.read`, `instruments.message.read`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.qc.capture`, `lab.result.enter`, `lab.result.read`, `lab.result.verify`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`, `lab.worksheet.manage`
- **partners**: `partners.partner.manage`*, `partners.partner.read`
- **payments**: `payments.reconciliation.read`*
- **reporting**: `reporting.delivery.read`, `reporting.outsourced.attach`, `reporting.report.read`, `reporting.settings.manage`*

#### Pathologist  (`corp_pathologist`) — 45 permissions, 7 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`
- **anatomic**: `anatomic.case.read`, `anatomic.case.signout`*, `anatomic.case.work`
- **billing**: `billing.cash_report.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`, `identity.user.read`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.result.amend`*, `lab.result.approve`*, `lab.result.read`, `lab.result.verify`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`
- **reporting**: `reporting.narrative.sign`*, `reporting.narrative.write`, `reporting.outsourced.attach`, `reporting.report.read`, `reporting.report.regenerate`*, `reporting.report.release`, `reporting.report.render`, `reporting.settings.manage`*, `reporting.template.manage`*
- **smartreport**: `smartreport.summary.read`
- dropped by safety cap: `identity.user.manage`

#### Pathologist_T2  (`corp_pathologist_t2`) — 44 permissions, 7 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`
- **anatomic**: `anatomic.case.read`, `anatomic.case.signout`*, `anatomic.case.work`
- **billing**: `billing.cash_report.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.result.amend`*, `lab.result.approve`*, `lab.result.read`, `lab.result.verify`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`
- **reporting**: `reporting.narrative.sign`*, `reporting.narrative.write`, `reporting.outsourced.attach`, `reporting.report.read`, `reporting.report.regenerate`*, `reporting.report.release`, `reporting.report.render`, `reporting.settings.manage`*, `reporting.template.manage`*
- **smartreport**: `smartreport.summary.read`

#### Pathologist_T3  (`corp_pathologist_t3`) — 40 permissions, 7 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`
- **anatomic**: `anatomic.case.read`, `anatomic.case.signout`*, `anatomic.case.work`
- **billing**: `billing.cash_report.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.result.amend`*, `lab.result.approve`*, `lab.result.enter`, `lab.result.read`, `lab.result.verify`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.worklist.read`
- **reporting**: `reporting.narrative.sign`*, `reporting.narrative.write`, `reporting.report.read`, `reporting.report.regenerate`*, `reporting.report.release`, `reporting.report.render`, `reporting.settings.manage`*, `reporting.template.manage`*
- **smartreport**: `smartreport.summary.read`

#### Client User  (`corp_client_user`) — 21 permissions, 3 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.manage`*, `catalog.price_list.read`
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.read`, `frontdesk.patient.read`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`
- **lab**: `lab.specimen.read`, `lab.status_board.read`
- **reporting**: `reporting.report.read`, `reporting.settings.manage`*, `reporting.template.manage`*

#### Sales Person  (`corp_sales_person`) — 35 permissions, 7 privileged
- **billing**: `billing.credit_party.manage`*, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.manage`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.membership.enrol`, `engagement.membership.read`, `engagement.membership_plan.manage`*
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.visit.assign`, `homecollection.visit.read`
- **identity**: `identity.centre.manage`*, `identity.centre.read`, `identity.self.manage`, `identity.settings.manage`*
- **instruments**: `instruments.instrument.read`, `instruments.message.read`
- **lab**: `lab.specimen.label_print`, `lab.status_board.read`
- **partners**: `partners.partner.manage`*, `partners.partner.read`
- **payments**: `payments.reconciliation.read`*
- **reporting**: `reporting.delivery.read`, `reporting.outsourced.attach`, `reporting.settings.manage`*
- dropped by safety cap: `catalog.instrument_code_map.manage`, `instruments.instrument.manage`

#### Senior Lab User  (`corp_senior_lab_user`) — 51 permissions, 9 privileged
- **anatomic**: `anatomic.case.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.manage`*, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.instrument_code_map.manage`*, `catalog.price_list.manage`*, `catalog.price_list.read`, `catalog.referrer.manage`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.membership.enrol`, `engagement.membership.read`, `engagement.membership_plan.manage`*
- **frontdesk**: `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.handover.receive`
- **identity**: `identity.self.manage`, `identity.settings.manage`*
- **instruments**: `instruments.instrument.manage`*, `instruments.instrument.read`, `instruments.message.read`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.qc.capture`, `lab.result.enter`, `lab.result.read`, `lab.result.verify`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.specimen.receive`, `lab.specimen.reject`, `lab.status_board.read`, `lab.worklist.read`, `lab.worksheet.manage`
- **partners**: `partners.partner.manage`*, `partners.partner.read`
- **payments**: `payments.reconciliation.read`*
- **reporting**: `reporting.delivery.read`, `reporting.outsourced.attach`, `reporting.report.read`, `reporting.settings.manage`*


### 9.2 ELabAssist

#### Admin  (`std_admin`) — 85 permissions, 30 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`, `analytics.data.export`*, `analytics.schedule.manage`
- **audit**: `audit.log.export`*, `audit.log.read`*
- **billing**: `billing.cash_report.read`, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`, `billing.release.override`*, `billing.settings.manage`*
- **catalog**: `catalog.price_list.manage`*, `catalog.price_list.read`, `catalog.referrer.export`*, `catalog.referrer.manage`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.bookable_item.manage`, `engagement.booking.manage`, `engagement.booking.read`, `engagement.link.read`, `engagement.link.revoke`, `engagement.membership.read`, `engagement.membership_plan.manage`*, `engagement.queue.manage`, `engagement.reminder.read`, `engagement.settings.manage`*, `engagement.slot.manage`
- **frontdesk**: `frontdesk.discount.apply`, `frontdesk.discount.approve`*, `frontdesk.order.cancel`, `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.anonymise`*, `frontdesk.patient.merge`*, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.settings.manage`*, `frontdesk.trf.upload`
- **homecollection**: `homecollection.device.manage`*, `homecollection.settings.manage`*, `homecollection.visit.read`
- **identity**: `identity.centre.manage`*, `identity.centre.read`, `identity.role.manage`*, `identity.self.manage`, `identity.session.revoke`*, `identity.settings.manage`*, `identity.user.manage`*, `identity.user.read`
- **instruments**: `instruments.agent.manage`*
- **inventory**: `inventory.bench.record`, `inventory.item.read`, `inventory.master.manage`, `inventory.po.manage`
- **lab**: `lab.config.manage`*, `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.result.enter`, `lab.result.read`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.status_board.read`, `lab.worklist.read`, `lab.worksheet.manage`
- **partners**: `partners.partner.manage`*, `partners.partner.read`, `partners.pickup.manage`, `partners.referrer.map`
- **payments**: `payments.merchant_config.manage`*, `payments.merchant_config.read`
- **quality**: `quality.tat_alert.read`
- **reporting**: `reporting.channel.manage`*, `reporting.delivery.read`, `reporting.message_template.manage`*, `reporting.report.bulk_download`*, `reporting.report.print`, `reporting.report.read`, `reporting.settings.manage`*, `reporting.template.manage`*, `reporting.token.revoke`*

#### Reception  (`std_reception`) — 18 permissions, 0 privileged
- **billing**: `billing.cash_report.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **lab**: `lab.specimen.label_print`, `lab.specimen.read`
- **quality**: `quality.tat_alert.read`
- **reporting**: `reporting.report.print`, `reporting.report.read`

#### Accession  (`std_accession`) — 25 permissions, 0 privileged
- **billing**: `billing.cash_report.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.visit.read`
- **identity**: `identity.self.manage`
- **lab**: `lab.result.read`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.status_board.read`, `lab.worklist.read`, `lab.worksheet.manage`
- **quality**: `quality.tat_alert.read`
- **reporting**: `reporting.delivery.read`, `reporting.report.print`, `reporting.report.read`

#### Lab technician  (`std_lab_technician`) — 40 permissions, 0 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.manage`, `catalog.test.read`
- **engagement**: `engagement.booking.manage`, `engagement.booking.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.visit.read`
- **inventory**: `inventory.bench.record`, `inventory.item.read`, `inventory.master.manage`, `inventory.po.manage`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.qc.capture`, `lab.result.enter`, `lab.result.read`, `lab.result.verify`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.status_board.read`, `lab.worklist.read`, `lab.worksheet.manage`
- **partners**: `partners.pickup.manage`
- **quality**: `quality.tat_alert.read`
- **reporting**: `reporting.delivery.read`, `reporting.report.print`, `reporting.report.read`

#### Consulting Pathologist  (`std_consulting_pathologist`) — 20 permissions, 5 privileged
- **anatomic**: `anatomic.case.read`, `anatomic.case.signout`*, `anatomic.case.work`
- **lab**: `lab.critical_value.log_notification`, `lab.critical_value.read`, `lab.result.amend`*, `lab.result.approve`*, `lab.result.enter`, `lab.result.read`, `lab.result.verify`, `lab.specimen.read`, `lab.worklist.read`
- **reporting**: `reporting.narrative.sign`*, `reporting.narrative.write`, `reporting.report.print`, `reporting.report.read`, `reporting.report.regenerate`*, `reporting.report.release`, `reporting.report.render`
- **smartreport**: `smartreport.summary.read`

#### Collection Center User  (`std_collection_center_user`) — 21 permissions, 0 privileged
- **billing**: `billing.cash_report.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **lab**: `lab.result.read`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.status_board.read`, `lab.worklist.read`
- **reporting**: `reporting.report.print`, `reporting.report.read`

#### Collection Center Admin  (`std_collection_center_admin`) — 21 permissions, 0 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`
- **billing**: `billing.cash_report.read`, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **lab**: `lab.result.read`, `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`
- **reporting**: `reporting.report.print`, `reporting.report.read`

#### Collection Boy  (`std_collection_boy`) — 19 permissions, 0 privileged
- **billing**: `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **homecollection**: `homecollection.sync.upload`, `homecollection.visit.read`
- **lab**: `lab.specimen.collect`, `lab.specimen.label_print`, `lab.specimen.read`
- **reporting**: `reporting.report.print`, `reporting.report.read`

#### Affiliation / Hospital User  (`std_affiliation_hospital_user`) — 17 permissions, 0 privileged
- **billing**: `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`
- **catalog**: `catalog.price_list.read`, `catalog.referrer.read`, `catalog.test.read`
- **frontdesk**: `frontdesk.order.edit`, `frontdesk.order.read`, `frontdesk.patient.read`, `frontdesk.registration.create`, `frontdesk.trf.upload`
- **lab**: `lab.specimen.label_print`, `lab.status_board.read`, `lab.worklist.read`
- **reporting**: `reporting.report.print`, `reporting.report.read`

#### Account  (`std_account`) — 25 permissions, 6 privileged
- **analytics**: `analytics.collections.read`, `analytics.dashboard.read`
- **billing**: `billing.cash_report.read`, `billing.credit_party.read`, `billing.invoice.cancel`*, `billing.invoice.issue`, `billing.invoice.read`, `billing.invoice.reprint`, `billing.payment.record`, `billing.payment.reverse`*, `billing.refund.approve`*, `billing.refund.request`*
- **frontdesk**: `frontdesk.discount.approve`*, `frontdesk.order.read`, `frontdesk.patient.read`
- **lab**: `lab.result.read`, `lab.specimen.label_print`, `lab.specimen.read`, `lab.status_board.read`, `lab.worklist.read`, `lab.worksheet.manage`
- **payments**: `payments.reconciliation.read`*
- **reporting**: `reporting.delivery.read`, `reporting.report.print`, `reporting.report.read`

