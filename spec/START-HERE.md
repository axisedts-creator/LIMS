# LIMS — build specification (START HERE)

Multi-tenant lab information system SaaS for Nepal (anchor lab: Metro Labs). Hosted in Nepal; synthetic data only in every document.

## How this package is organised
| Folder | What it is |
|---|---|
| `research/` | Ground truth and research: `00-scope-baseline` (what the client asked for), `01` features & workflow, `02` security (REQ-SEC), `03` backend architecture, **`04-consolidated-decisions` (single source of truth)**, `05` primary-source re-check |
| `program/` | Rules every build agent follows: `00-README` (reading order, precedence, agent prompt), `01-CHUNK-MAP` (19 chunks, file ownership, channels, waves), `02-CONVENTIONS`, `03-INTERFACE-CATALOG` (events, ports, views, routes, errors, permissions), `04-CHANGE-REQUESTS`, `05-DEFINITION-OF-DONE`, `06-GLOSSARY`, `07-BLOCKERS` (open items + defaults), **`08-CR-REGISTER`** (all arbitration decisions; Addenda A1–A31 are binding and override older text) |
| `chunks/C0 … C18/` | One folder per independently buildable chunk, each with 7 documents: 01-PRD, 02-TRD, 03-APP-FLOW, 04-UI-UX, 05-SCHEMA, 06-IMPLEMENTATION-PLAN, 07-SECURITY |
| `review/` | Independent review findings per chunk, the four triage files, and the hand-off log (audit trail of how every finding was resolved) |

Precedence when documents disagree: `program/00-README` > `research/04` > `program/08` (newest addendum wins) > `program/03` > `program/01`/`02` > research 01–03 > chunk docs.

## Chunks
C0 Foundation & Contracts · C1 Infrastructure & Ops · C2 Identity & Admin · C3 Catalog & Pricing · C4 Front Desk & Billing · C5 Lab Workflow · C6 Reporting & Delivery (+ patient portal) · C7 Instrument Integration · C8 Analytics & MIS · C9 Quality Engine · C10 Microbiology · C11 Specialty Pathology · C12 Inventory · C13 B2B Partner Portal · C14 Smart Report · C15 Payment Gateways · C16 Patient Engagement · C17 Home Collection · C18 Legacy Migration (design only until the eLabs export sample arrives, B4).

## Quality steps done
1. Research → two verification passes → primary-source re-check.
2. 220 cross-chunk change requests arbitrated, then applied.
3. Independent fresh-context review of all 19 chunks (≈ 800 findings); every BLOCKER/MAJOR verified against sources; 31 addenda of decisions; fix pass on every chunk.
4. Every chunk's SQL loaded on PostgreSQL 16 with FORCE RLS (C0–C17 load in wave order; C18 parses); registry validators (no duplicate codes, all schemas valid, all referenced permissions exist).

## Open items (build against the stated defaults meanwhile) — see `program/07-BLOCKERS.md`
- **Founder:** F-01 egress register · F-05 push notifications · F-08 sign-off of wording changes · **F-09 confirm 32 GB app VM cost** · **F-10 DR storage may need ~2 TB** · F-06/F-07 legacy migration scope.
- **Client:** B2 analyser models & manuals · B3 test list · B4 eLabs export sample · B9 Meta/WhatsApp status · B13 referral-incentive position · B14 named pathologist · C-02 · C-06 own patient app? · C-07 re-invite rule.
- **Auditor / IRD / bank / counsel:** B6, B7, B17 (IRD invoicing), B8 (Fonepay), B15–B16 (retention, privacy regulation).
- **Release preconditions checked in the first build tasks:** GoTrue patient sessions and recovery TTL (D-218/D-219), Supabase image extensions (SP-3).
