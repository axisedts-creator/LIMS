# 07 — Blockers and what agents build in the meantime

This mirrors `research/04-consolidated-decisions.md` §13 (authoritative). If they ever disagree, 04 wins and this file gets fixed.

Rule for agents: **a blocker never stops a chunk.** Build against the default in the right-hand column, and keep the blocked decision behind configuration or an interface so the answer can be dropped in later. Never present a default as the real answer, especially in UI text, invoices or anything shown to IRD.

| # | Blocked item | Waiting on | Chunks affected | Build against this default | How it stays swappable |
|---|---|---|---|---|---|
| B1 | ~~Module priority ranking~~ **CLOSED 2026-11-06** — client confirmed the 01 §1 wave order (08 A11.2) | Client | C13, C16, C17 | Wave order in `01-CHUNK-MAP.md` §1 | — |
| B2 | Exact analyser models + official LIS/host interface manuals | Client + vendors | C7, C9, C10, C12; C7 (calibration event, CR-C12-006) | Both ASTM and HL7/MLLP stacks; drivers only for models with a manual; upload-only unless manual confirms host query (04 N14) | Driver per model behind a parser interface; host-query capability flag per instrument. Note (08 A13 D-40): instrument graphs (client baseline 00 §3 item 3) are not dropped — default to build is C7 IS-27: histogram/scattergram payloads from a `verified` driver are stored as `attachment`-kind records (PNG if sent as image, otherwise raw) and shown in the C7 message viewer; printing on reports is a later C6 CR once a driver is verified. Reported to the founder as information, not a blocker (A13 lead modification). |
| B3 | Test list with prices and reference ranges | Client | C3, C4, C5, C6 | Synthetic catalogue from `packages/test-fixtures` | Excel import (C3) loads the real list |
| B4 | eLabs export format / migration sample | Client | C18 | No migration build. C18's documents specify the canonical export format, staging, mapping, validation and cut-over runbook (design only); no DDL, ports or tool code before the client delivers the eLabs export sample. | C18 staging schema isolated from live schemas |
| B5 | Ownership/licensing the LIMS provider ↔ anchor client | Client + founder | all (commercial) | — | Not a code concern |
| B6 | IRD submission checklist, CBMS API spec, cl.7 interpretation, Annex 7 template, invoice-series granularity, current threshold notice | IRD / auditor | C4, C0-0B | Gapless counter per (tenant, B.S. fiscal year); immutable invoices; cancel via credit note; CBMS client behind an interface with a recording stub | `CbmsClient` interface + config; series key configurable |
| B7 | VAT treatment of lab services; HS-code applicability; Health Service Tax | Client's auditor | C4, C12 (`inventory.settings.vat_in_cost`, default true — 08 A17 D-57) | Invoice lines support exempt, VAT 13% and an additional configurable per-line tax type | Tax rules are data (per tenant, per orderable), not code |
| B8 | Fonepay merchant API / webhook spec | Lab's bank / Fonepay | C15 | Static-QR manual reconciliation (operator records reference) | `PaymentProvider` implementation slot for Fonepay left unimplemented |
| B9 | Meta business verification; WhatsApp volume; Nepal rate | Client | C6 | Budget assumes the charged case (04 T3); SMS fallback always available | Channel selection per tenant config |
| B10 | Migration lint tool (Atlas Pro vs free linter) | Founder | C0 | Manual migration review checklist | CI step pluggable |
| B11 | Any foreign touchpoint beyond the email relay | Founder | C2, C6, C14, C1 | Not used (local breached-password list; no LLM API; no CDN; WhatsApp link-only) | Feature flags, default off |
| B12 | Nepal DC/VM provider, SLA, DR site | Founder | C1 | Spec in 04 I1; infra code provider-agnostic (plain VMs) | Provider-specific bits isolated in `infra/providers/<name>` |
| B13 | Referral-incentive compliance position | Client management | C4, C8 | Reporting only; never labelled "commission"; no payout features | Tenant flag hides the report entirely |
| B14 | Named pathologist owning smart-report templates + critical-value SOP | Client | C14, C5, C9 (auto-verify rule-set sign-off; default four-eyes activation by two holders of `quality.autoverify.manage`, nothing activates by default — 08 A17 D-57) | Templates ship as drafts requiring tenant pathologist approval before use | Approval workflow gate |
| B15 | Legal retention periods for lab records | Nepali counsel | C0, C6, C1, C9 (08 A17 D-57), C7 (raw analyser archive = `retention.rawInstrumentYears` — 08 A13 D-42) | 5-year default, per-tenant config (raw analyser archive: `TenantSettings.retention.rawInstrumentYears`, default 1, floor 1 = 04 I8; single source, C7 `settings.archive_retention_days` dropped — D-42) | Retention as config, no hard-coded years |
| B16 | Privacy Regulation 2077 content; NMC/NHPC codes | Nepali counsel | all | Controls in 02 | — |
| B17 | IRD "each taxpayer's data stored separately" | IRD clarification | C0-0B, C4 | Shared schema + RLS; `billing` isolatable per tenant (04 D16) | `billing` schema + tenant-leading keys + per-tenant export/restore test |

## Founder, client and auditor decisions raised by the CR register (not 04 §13 items)

Tracked in `08-CR-REGISTER.md` §5 and Addendum A1. Build against the default listed there. Client decision C-03 (static IPs) was withdrawn by 08 Addendum A1.

| # | Decision | Default |
|---|---|---|
| F-01 | Non-PHI egress register: OS package mirrors, container-image registries, ClamAV signature mirrors, ACME CA, Git host, optional SMS paging of ops (B11 scope) (CR-C1-006) | No product host has direct egress except worker → approved provider FQDNs (04 §11) and app-1 → ACME CA; all other fetches only from ops-1 through logging Squid; ops paging by e-mail only; SMS paging off |
| F-05 | Push notifications through FCM/APNs (foreign touchpoint, B11) (CR-C16-020) | No push; in-app polling and SMS via NotificationPort |
| F-06 | When C18 work starts (B4 lifted only by the client's eLabs sample) | Design only; no DDL, ports or tool code (08 R15 wording) |
| F-07 | Legacy eLabs invoices and opening balances — to the client's auditor via the founder (B6/B7) (CR-C18-009) | (A) no import, eLabs read-only |
| F-09 | Confirm the cost of the 32 GB app VM (8 vCPU / 32 GB); 16 GB is not deployable as specified (08 A25.1, A27.1) | Build for 32 GB |
| F-10 | DR site storage may need ~2 TB instead of 1 TB (worst-case WAL ≈ 840 GiB over 35 days) (08 A27.4) | Measure in C1 T-09 before go-live |
| F-08 | Doc-owner sign-off on the program-level wording changes: research/04 P4 Khalti `Initiated` (08 A19.2/D-114); research/04 §4 Login row (08 Addendum A1, supersedes R6), 04 D4 wording (R5), 04 §13 B4 default (R15), 02-CV §15.2 ops-tool licence row (R15), 02-CV §4.7 amounts (R15) | Apply phase edits the documents as decided (Login row per 08 Addendum A1) |
| C-02 | Whether an anatomic sign-out by a holder of `lab.result.approve` may also count as C5 first-level verification (CR-C11-010) | **No** — A1 chain: sign-out → verify → approve (approver ≠ verifier) (08 R2) |
| C-04 | Paying dues from the web portal (patient link) in addition to the patient app (CR-C15-010) | **CLOSED: YES, ships with C15** (08 A11.1) |
| C-06 | Does the client have or plan its own patient/phlebotomy app? (08 A19.4, D-124) | The LIMS provider builds both (C16, C17) |
| C-07 | May a person deactivated at one lab be invited by another lab with the same e-mail? (08 A25 D-220) | **No** in v1 (`identity.user_exists` restriction stays) |
| C-05 | Module priority (B1) | **CLOSED: current 01 §1 wave order confirmed** (08 A11.2) |

Closed by the founder 2026-11-06 (research/04 §11/§13): Authenticode certificate and app-store accounts/keys owned by the client; maps hand-off approved; per-summary smart-report approval kept (08 §5.0).

## Requests to send now (owner: founder)

1. **To the client:**
   - B2 model list plus contacts at each distributor;
   - B3 test list (Excel);
   - B4 eLabs export sample;
   - B9 Meta Business Manager status;
   - B13 commission position;
   - B14 named pathologist;
   - C-06 own patient/phlebotomy app plans; C-07 re-invite rule; C-02 sign-out as verification;
   - client to provide the Authenticode certificate and the app-store accounts/signing keys it owns (founder decision 2026-11-06).
2. **To the client's auditor:** B7 VAT and Health Service Tax treatment; B6 invoice-series granularity.
3. **To IRD (via the auditor or directly):** B6/B17 — the cl.7 interpretation, the Annex 7 template, the CBMS API spec and the current listing checklist.
4. **To the lab's acquiring bank:** B8 Fonepay merchant integration document.
5. **To Nepali counsel:** B15, B16.
6. **To the founder:** F-01 egress register; F-05 push; F-08 sign-off of the 04/02 wording edits; F-09 app-1 VM sizing; F-10 DR storage.
