# LIMS — Build Documentation Set

This folder is everything a coding agent (or developer) needs to build one chunk of the LIMS without guessing.

## Reading order for an agent assigned to chunk Cxx

1. `program/00-README.md` — this file.
2. `program/01-CHUNK-MAP.md` — what your chunk owns, what it must never touch, the only four ways it may talk to other chunks.
3. `program/02-CONVENTIONS.md` — how code, APIs, DB objects, events, tests and PRs must look.
4. `program/03-INTERFACE-CATALOG.md` — the exact events, ports, published views, error codes and routes. Your chunk produces or consumes some of these; use them verbatim.
5. `chunks/Cxx-*/01-PRD.md` → `02-TRD.md` → `03-APP-FLOW.md` → `04-UI-UX.md` → `05-SCHEMA.md` → `06-IMPLEMENTATION-PLAN.md` → `07-SECURITY.md`.
6. `program/05-DEFINITION-OF-DONE.md` — the gates you must pass.
7. `program/04-CHANGE-REQUESTS.md` — what to do when something you need isn't in the contracts.
8. `program/07-BLOCKERS.md` — what's still unknown and what to build against meanwhile.

Reference material (read when a document cites it):
- `research/00-scope-baseline.md`: what the client actually said. Ground truth.
- `research/04-consolidated-decisions.md`: the single source of truth for stack, numbers, regulatory facts, phasing. Cited as "04 <row id>".
- `research/01-features-workflow.md`, `02-security.md` (REQ-SEC-###), `03-backend-architecture.md` (REQ-ARCH-###), `05-pass2-critical-recheck.md`: the verified research behind 04.

## Precedence when documents disagree

`research/00` (client facts) > `research/04` (decisions/facts) > `program/03` (interfaces) > `program/01`/`02` > chunk documents > everything else.

If you find a disagreement:
1. Do not pick a side yourself.
2. Build to the higher-precedence document.
3. File a CR (`program/04-CHANGE-REQUESTS.md`) so the lower one gets fixed.

## Prompt to give the coding agent (per chunk)

```
You are building chunk Cxx of the LIMS. Read docs/program/00-README.md and follow its reading
order completely before writing any code. Do not start coding yet: first reply with (1) a summary of your
chunk's scope in under 300 words, (2) every contradiction or missing detail you found across the documents
you read, (3) your plan for the first task in 06-IMPLEMENTATION-PLAN.md. Only touch paths your chunk owns
(01-CHUNK-MAP §3). Never invent a table, endpoint, event, error code or library version — if it is not in
the contracts or 04, file a change request and work against the fake. Use synthetic data only.
```

## Labels used across all documents

| Label | Meaning |
|---|---|
| **VERIFIED** | Checked against a named source (see research/04 Source column) |
| **UNVERIFIED** | Must not be treated as fact; code must not hard-depend on it |
| **DECISION** | Engineering choice made in this documentation; changeable only via CR |
| **BLOCKED (B#)** | Waiting on an outside party; build against the default in `program/07-BLOCKERS.md` |
| **ASSUMPTION** | Planning number (e.g., capacity); validate with measurement |

## Hard rules (repeat of the most violated ones)

1. Only edit paths your chunk owns.
2. Patient data never in fixtures, logs, tickets or AI prompts. The client's sample report PDFs are confidential and are not in this repo.
3. No foreign service beyond 04 §11 without founder approval.
4. Invoices and approved results are never edited or deleted. Changes only by versioned amendment or credit note.
5. Every endpoint and table gets a cross-tenant probe test.
