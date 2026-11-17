# LIMS — Production Readiness Checklist

As of 2026-11-07. Living copy: https://claude.ai/artifact/TE76QhWwWx19sjeBNHVsqg — this file is the repo copy; update both when an item changes.

## Read this first

Most of what Plan E's checklist asks for is already written into the LIMS spec as testable requirements. This checklist marks each item as **In spec** (agents build it), **Added** (a gap found 2026-11-07 and pushed to the build as addendum A33 in 08-CR-REGISTER before its chunk starts; per-task wording in `C:\LIMS-state\lead-decisions-<chunk>.md`, LD-24…LD-29), or **You** (non-engineering work no agent can do). Three things make the LIMS harder than Plan E:

1. **The LIMS is truly multi-tenant.** One lab reading another lab's patient results ends the business. Tenant isolation is enforced by row-level security on every table and proven by generated cross-tenant probe tests (C0 T0B-08). It is never traded for speed.
2. **A wrong result on the right patient is worse than an outage.** Result integrity (patient identity, specimen chain, amendments, critical-value calls, signatory rules) outranks every performance item. Labs cannot stop working when the internet drops, so downtime mode with paper fallback and back-entry is part of the build.
3. **Self-hosting in Nepal is a permanent job.** Backups, PITR, patching and the restore drill are yours forever. The Data Centre and Cloud Service Directive 2081 requires customers to use only DOIT-enrolled providers, so blocker B12 must be a DOIT-enrolled provider. Name the person on the ops rota before go-live.

## Checklist

### A. Tenancy and data model
| Item | Status | Where |
| --- | --- | --- |
| RLS on every table, ENABLE + FORCE, tenant from server-side session, never client input | In spec | 02-CONVENTIONS RLS template; C0 T0B tasks |
| Generated cross-tenant probe suite for every table; CI fails on any leak | In spec | C0 T0B-08 |
| UUIDv7 keys; never sequential ids in URLs or QR codes | In spec | 04 D9 |
| Money as exact decimals, timestamptz everywhere, CHECKs match API validation | In spec | 02-CONVENTIONS; C0 shared libs |
| Append-only audit log for every PHI read and every change | In spec | 04 D11; C0 T0B-03/04 |
| Retention and purge jobs per data class | In spec | C0 core.retention_purge |
| Training tenant: no CBMS sync, no real SMS, TRAINING watermark | Added | A33-3 (C2, C4, C6, C15) |

### B. Database operations (self-hosted in Nepal)
| Item | Status | Where |
| --- | --- | --- |
| pgBackRest with WAL archiving, two encrypted repositories (one off-site) | In spec | C1 T-09 |
| Restore drill monthly, timed, RTO recorded; last drill < 35 days old | In spec | 04 I3, REQ-ARCH-007 |
| Connection pooling, per-role statement timeouts, long jobs with their own timeout | In spec | C0 TRD §6.4; C1 |
| Patching playbook for every self-hosted component | In spec | C1 T-28 |
| Hosting on a DOIT-enrolled Nepal provider with a DR site | You | Blocker B12 |
| Named person on the ops rota, with a backup | You | — |

### C. Lab correctness
| Item | Status | Where |
| --- | --- | --- |
| Specimen chain: collect, dispatch, receive, reject, recollect, aliquot, barcodes | In spec | C5 T-07/T-08 |
| Critical values, delta checks, amendments with reason and audit | In spec | C5, C6 |
| QC with Westgard rules; results held on failed QC | In spec | C9, C5 |
| Auto-verification only as a suggestion, four-eyes activation, never auto-approval | In spec | C9 D-AV-1 |
| Downtime mode: numbered paper forms, back-entry with original times and form number, flagged and audited | Added | A33-2 (C4, C5) |
| External quality assessment (NPHL NEQAS) participation | You | Labs enrol; LIMS records it in phase 2 |

### D. Reports and delivery
| Item | Status | Where |
| --- | --- | --- |
| Versioned report templates, QR verification, sandboxed PDF renderer | In spec | C6 |
| Signatory block shows the right council: NMC for doctors, NHPC for lab professionals | Added | A33-4 (C2, C6) |
| Notification consent, opt-out and channel rules | In spec | C6 T-19, C16 |
| Render load test: 42 renders/min for 15 min, bulk 200 | In spec | C6-T34 |

### E. Billing, tax and payments
| Item | Status | Where |
| --- | --- | --- |
| Gapless IRD invoice numbering, immutable invoices, credit notes only | In spec | C4 |
| CBMS sync with retry and a register for the tax office | In spec | C4 BL-T14/T15 |
| Software listed with IRD; Annex 2 letter to each lab; each lab's Annex 3 tax-office permission | You | 04 L3 |
| Payment gateways with idempotent callbacks and daily reconciliation | In spec | C15 |
| Merchant onboarding with each gateway | You | Start now |
| Tax treatment of hand-written bills during downtime | You (accountant) | A33-2, UNVERIFIED |

### F. Identity and accounts
| Item | Status | Where |
| --- | --- | --- |
| MFA for privileged staff, rate limits on login and OTP | In spec | C2; REQ-SEC-078 |
| In-app account deletion for patients | In spec | C16 T-AC1 |
| Record which ToS and DPA version each lab accepted | Added | A33-6 (C2) |

### G. Apps and stores
| Item | Status | Where |
| --- | --- | --- |
| Minimum app version (force update) and remote kill-switch | In spec | C16, C17 HC-T29; REQ-SEC-104 |
| Offline phlebotomy queue, encrypted cache, no logout with unsynced work | In spec | 04 S17, A15 |
| Privacy policy and terms links inside both apps and on store listings | Added | A33-5 (C16, C17) |
| Apple and Google organisation accounts (Apple needs D-U-N-S) | You | Start now |
| Google Play health apps declaration (Healthcare Services and Management) and Data safety form | You | Google Play Console Help 14738291 |

### H. Observability
| Item | Status | Where |
| --- | --- | --- |
| Logs, metrics, alerts, dashboards, all self-hosted in Nepal, PHI scrubbed | In spec | C1 T-17/T-18/T-19 |
| Crash/error tracking for web + both Flutter apps, self-hosted GlitchTip, PHI stripped | Added | A33-1 (C1, C0, C16, C17) |
| Status page and a test alert to a real phone | In spec | C1 |

### I. Security
| Item | Status | Where |
| --- | --- | --- |
| OWASP-mapped security requirements with tests in every chunk | In spec | research/02; each 07-SECURITY |
| TLS with automatic renewal, edge rate limits, fail2ban | In spec | C1 T-13, T-25 |
| External penetration test before the first paying lab | You | Book 4 weeks before go-live |

### J. Testing and release
| Item | Status | Where |
| --- | --- | --- |
| Tests before code for every task; reviewer approval; CI gates | In spec | Build orchestrator |
| RLS load test on production-sized synthetic data | In spec | REQ-SEC-025 |
| Migrations rehearsed on a production-sized snapshot | In spec | REQ-ARCH-080 |
| eLabs data migration for Metro, dry run and sign-off | You + C18 | Needs eLabs export sample (B4) |

### K. Legal and regulatory
| Item | Status | Where |
| --- | --- | --- |
| Lawyer review: lab contract + DPA, patient app terms, Privacy Act 2075 / Regulation 2077 | You | Blocker B16 |
| Report and e-signature rules with NMC/NHPC; scanned signature vs licensed digital signature (Electronic Transactions Act 2063) | You | Ask counsel |
| Each lab's own NPHL/local registration current (the LIMS does not license the lab) | You | Onboarding check |

### L. Operations and support
| Item | Status | Where |
| --- | --- | --- |
| Runbooks: outages, restore, key rotation, incident response | In spec | C1 |
| Staff training on the training tenant before go-live | You | Uses A33-3 |
| Support channel, hours and SLA in the lab contract | You | — |

### Y. Go-live runbook
Two weeks out:
- [ ] Feature freeze; bug fixes only
- [ ] Restore drill on production, time recorded
- [ ] Test alert reaches the on-call phone
- [ ] Metro staff trained on the training tenant
- [ ] eLabs migration dry run signed off by Metro
- [ ] Pen-test findings fixed or accepted in writing

Launch day:
- [ ] Real end-to-end run: register, collect, result, approve, print, SMS, invoice to CBMS
- [ ] Gateways on live keys, one small real payment and refund
- [ ] Downtime kit (numbered paper forms) at every counter
- [ ] Rollback owner named

First week:
- [ ] Daily IRD/CBMS and payment reconciliation by a person, not just the job
- [ ] Every support ticket read personally
- [ ] Day-7 review with Metro, prioritised fix list

## Sequencing
**Launch-blocking:** tenant isolation with its probe suite, gapless IRD invoicing and CBMS sync, backups with a timed restore, result integrity, downtime mode, self-hosted error tracking, lawyer-reviewed lab contract and patient terms.

**Smaller than it looks:** one payment gateway plus one backup, Postgres full-text search, manual reconciliation in week one, one pilot lab (Metro) before a second.

**Defer until a real signal:** read replicas, recording EQA results in the LIMS, more gateways, more instrument drivers than Metro uses.

**Start this week (each takes weeks):**
- [ ] DOIT-enrolled Nepal hosting provider with a DR site (B12)
- [ ] Lawyer brief: lab contract, DPA, patient terms, e-signature question (B16)
- [ ] Apple organisation enrolment with D-U-N-S; Google Play organisation verification
- [ ] Payment gateway merchant onboarding
- [ ] IRD software listing and the Annex 2 letter template
- [ ] eLabs export sample from Metro (B4)
- [ ] Ops rota owner and a backup named

## Sources
- Data Centre and Cloud Service Directive 2081 — Pradhan Law: https://pradhanlaw.com/publications/data-center-and-cloud-service-operation-and-management-directive-2081-2025-ad
- Health apps declaration form — Google Play Console Help: https://support.google.com/googleplay/android-developer/answer/14738291
- Health laboratory establishment and operation — Medical Lab Notes: https://medicallabnotes.com/?p=3425
- GlitchTip — AlternativeTo: https://alternativeto.net/software/glitchtip/about
- Plan E Production Readiness Checklist (2026-09-20), the structure this follows
- The LIMS spec: research/02-04, program/07-BLOCKERS, chunk docs
