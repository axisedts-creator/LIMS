# C7 addendum — Getein Metis series analyser (HL7 v2.3.1 over TCP/MLLP: results, QC, host query)

Status: ACTIVE amendment to `02-TRD.md` §5.4–5.5, §6.1–6.3, §6.6 · Date: 2026-11-14 · Owner: program lead (founder go 2026-11-14 07:50 NPT)
Binding for tasks `MET-T01 … MET-T07` (`C:\LIMS-state\tasks\C7-instrument-integration.json`) and for lead decision LD-162. Same pattern as `08-ADDENDUM-TRUTH-H80E.md`; where this file is silent, that addendum's rules apply to this driver too.

## 0. Sources and honesty rules

- **Getein Biotech "HL7 Communication Protocol (Applicable to Metis Series Analyzers)"** — 54 pages, HL7 v2.3.1. The title page carries no revision number (the PDF's file metadata says created 2024-03-26; that is not a revision). Its text is machine-readable, so every position below was read from the text, not counted from an image. The file the lab gave us is named for the Metis 6000; the document itself covers the whole Metis series.
- It is a protocol document, not an operating manual. It does **not** say: who opens the TCP connection, the port, retry or timeout rules, which analytes a given Metis unit runs, or whether a given unit supports LIS-initiated download. Those are **U** (unverified until a real capture and the commissioning checklist, §9).
- The manual contradicts itself in a few places (time formats, OBX-3/OBX-4 roles, the order of two QC fields). Each is listed below; the driver parses tolerantly and never hard-codes a guess.
- Driver status stays `generic` (host query inert) until the commissioning checklist is signed and a reviewed migration promotes it (02-TRD §6.1, CI job `c7-driver-registry-check`).
- Synthetic data only: names such as `Test Patient`, barcodes such as `MT2600000042`. The samples below are built to the manual's field positions with invented values; they are not copied from the manual.

**Unverified items.** Each stays open until the step named in §9 is done; no driver code may hard-code a guess for any of them.

| U | Open question | Closed by (§9 step) |
|---|---|---|
| U1 | Does the analyser connect out to a LIS address, or listen for the LIS to connect? | 1 |
| U2 | Which item ids does this lab's unit actually run? | 4 |
| U3 | Does the analyser accept our ACK sender names (`LIS` / `LIMS`) instead of blank? | 3 |
| U4 | Time format in OBR-6/7 and OBX-14: `YYYY/MM/DD HH:mm:ss` (manual text) or 14 digits (manual examples)? | 3 |
| U5 | Are OBX-3 and OBX-4 the item id and abbreviation as in the examples, or as the field table says? | 3 |
| U6 | What does the analyser do when it receives `NF`? | 6 |
| U7 | How long does the analyser wait for QCK and DSR, and does it acknowledge QCK? | 5 |
| U8 | Does MSH-10 restart at 1 after an instrument restart? | 3 |
| U9 | Does the analyser need the sample number (DSP-22) as well as the barcode? | 5 |
| U10 | Does the analyser screen render a Devanagari name? | 8 |
| U11 | Does this unit accept a LIS-pushed DSR (M9)? Not built either way in release 1 | 7 |
| U12 | Meaning and order of the QC fields OBR-11, 12, 14, 15 | 3 |
| U13 | How retests (OBX-17 = 1) relate to the original result | 3 |
| U14 | Control ids, QRD echo and multi-sample numbering in the LIS replies | 5 |
| U15 | Is the time-range query by receiving time or by test time? | 7 |

## 1. Topology

```
Metis analyser (static IP on the lab LAN)  ──TCP/MLLP──  lab PC running the bridge agent  ──HTTPS, device token──▶  LIS API: ingest (E01) · host query (E05)
```

- The manual says "TCP/IP connection" and MLLP framing only. **U (U1):** whether the analyser connects **out** to a LIS address typed into its settings (as the H80E does) or **listens** for the LIS to connect. Decision D-MET-3: the preset uses transport `tcp_server` (`bind_address` = the lab PC's static LAN IP, never `0.0.0.0`; `allowed_peers` = [the analyser IP]), same as H80E. 02-TRD names `tcp_server` and no client-side TCP transport; if commissioning shows the analyser listens, **CR-C7-021** adds one (not raised unless needed).
- The address typed into the analyser is the lab PC, never the cloud server: the analyser speaks raw MLLP with no TLS.
- MLLP: `0x0B` message `0x1C 0x0D`, UTF-8 (the manual writes the charset as `UTF8`; accept `UTF8` and `UTF-8`), processing id `P`. The manual restricts message data to printable ISO 8859-1 plus `<CR>`; the driver still decodes UTF-8 and never fails on other characters.

## 2. Messages

| # | Direction | MSH-9 | MSH-16 | Purpose | Our action |
|---|---|---|---|---|---|
| M1 | analyser → LIS | `ORU^R01` | `0` | patient results, one message per sample | parse (§3); reply M2 |
| M2 | LIS → analyser | `ACK^R01` | echo | accept / reject | `AA` or `AE`/`AR` (§6) |
| M3 | analyser → LIS | `ORU^R01` | `2` | QC result | parse (§4); reply M2 |
| M4 | analyser → LIS | `ORU^R01` | `1` | calibration result | **not parsed**: archived as `other`, no events (D-MET-2); reply M2 |
| M5 | analyser → LIS | `QRY^Q02` | blank | host query (3 modes, §5) | host query; reply M6, M7 |
| M6 | LIS → analyser | `QCK^Q02` | blank | `OK` or `NF` | built by the driver |
| M7 | LIS → analyser | `DSR^Q03` | blank | sample details **with a test list**, one DSR per sample, `DSC` marks continuation | built by the driver (only after `OK`) |
| M8 | analyser → LIS | `ACK^Q03` | blank | confirms the DSR | accepted, not matched strictly (§6) |
| M9 | LIS → analyser | `DSR^Q03` with MSH-15 = `P` | | LIS pushes sample requests unasked | **not built** (D-MET-4); the manual itself says to check the unit's own manual for support (**U11**) |

MSH-16 on analyser messages is documented as mandatory for `ORU`, `QRY` and `DSR`, but the manual's own `QRY` and `DSR` examples leave it blank; we send it blank on M6/M7 and accept blank or filled on M5. Classifier for ORU: MSH-16 first (`0` patient, `1` calibration, `2` QC); if blank, PID present = patient, otherwise `other`.

## 3. Patient result message (M1)

```
MSH|^~\&|GP|Metis|||20261114093015||ORU^R01|57|P|2.3.1||||0||UTF8|||
PID|1|V000123|||Test Patient||19880912000000|F
OBR|1|MT2600000042|7|^|N|20261114085510|20261114092940|||||||20261114085730|serum
OBX|1|NM|0|ALT|31.2|U/L|0-40|N|||F||31.2|20261114093001|||0
OBX|2|NM|1|AST|44.8|U/L|0-40|H~A|||F||44.8||||0
OBX|3|ST|1112|CoV2Ag|Negative||||-||F|||20261114093010|||1
```

| Field | Meaning (manual) | Driver use |
|---|---|---|
| MSH-3 / MSH-4 | sender application / device (the manual's own text and example disagree on which holds the model) | recorded, never used for matching |
| MSH-7 | send time `YYYYMMDDHHMMSS` | `messageTimeLocal` |
| MSH-10 | message control id, counts up from 1 | ACK echoes it. **U8:** whether it restarts at 1 after an instrument restart, so the message key must be MSH-10 **plus** MSH-7 and OBR-2 (02-TRD key rules), never MSH-10 alone |
| MSH-12 / MSH-18 | `2.3.1` / `UTF8` | the ACK echoes the original's version (the agent's `HL7AckMode: "original"`); MET-T01 proves it with a test |
| PID-2, PID-5, PID-7, PID-8 | patient id, name, date of birth, sex `M/F/O` | ignored by the driver, never copied to events (PHI minimisation); stored only in the encrypted raw archive |
| **OBR-2** | **sample barcode** ("placer order number") | `sampleBarcode` (≤ 40, 03-IC §3.14). If empty, follow the pipeline's existing behaviour for a result without a barcode (02-TRD §6.4) and cite it in a code comment; do not invent a new path |
| OBR-3 | instrument sample number (required in the manual) | warning-level context only |
| OBR-5 | priority `Y`/`N` (emergency) | context |
| OBR-6, OBR-7 | collection time, test time. The manual's text says `YYYY/MM/DD HH:mm:ss`, its own examples use 14 digits `YYYYMMDDHHMMSS` (**U4**) | accept both; `instrumentResultTimeLocal` fallback = OBR-7 |
| OBR-9, OBR-10 | manual dilution factor, tray^cup position | context |
| OBR-15 | sample type text: `serum`, `plasma`, `blood`, `urine`, `cerebrospinal fluid`, `others` | context only |
| OBR-16 | sending doctor | ignored |
| OBX-2 | `NM` numeric, `ST` string | `recordKind = quantitative` for `NM`, `qualitative` for `ST` (03-IC §3.14) |
| **OBX-3** | **item id** — the manual says this field "must be used to match the item" | `instrumentAnalyteCode` = OBX-3 trimmed |
| OBX-4 | item abbreviation in every example; the manual's field table calls it "test item id" (**U5**) | context name; if OBX-3 is empty and OBX-4 is not, use OBX-4 as the code and warn |
| OBX-5 | value. With the host option "Upload result values" the instrument may send `Error` or a `>` / `<` prefixed value | `valueRaw` as received; never "fix" it |
| OBX-6, OBX-7 | unit, reference range (`low-high`) | `unitRaw`; the range is context, C5 evaluates ranges from the C3 catalog |
| OBX-8 | abnormal flags `A L H N`, several joined with `~` | stored as flags `METIS_FLAG:<v>`; **not used to decide abnormal or critical** |
| OBX-9 | qualitative result: `-`, `+`, `+-` | for `ST` rows with an empty OBX-5, `valueRaw` = OBX-9 |
| OBX-13 | raw result | context |
| OBX-14 | test time `YYYYMMDDHHMMSS`. The manual's own example leaves it empty on one row | per row: OBX-14, else OBR-7, else MSH-7; `instrumentResultTimeLocal`; instrument timezone default = tenant timezone (Asia/Kathmandu) |
| OBX-17 | retest flag `1` retest / `0` not | stored as flag `METIS_RETEST`; both the original and the retest are emitted as separate records (**U13**: C5 decides which counts) |

Item ids are the analyser's own numbers. The manual's appendices list them: biochemistry 0–1000, chemiluminescence immunoassay 1001–3036 (names, units, test ranges, decimals). **Which of them a lab's Metis actually runs is U2.** The appendices are reference material for the commissioning engineer; none are seeded. Mapping to the lab's tests goes through C3 `catalog.instrument_code_map.manage` (tenant data created at commissioning, as for H80E).

## 4. QC message (M3, MSH-16 = 2)

```
MSH|^~\&|GP|Metis|||20261114101502||ORU^R01|58|P|2.3.1||||2||UTF8|||
OBR|1|7|AST|^|||20261114101455||||2|1^2|QCSYN1^QCSYN2|LOT111^LOT222|20300101^20300101||L^H|45.0^120.0|4.5^9.0|44.1^123.4|U/L
```

One OBR carries **lists joined by `^`**, one entry per control level; the manual says a message is sent for each QC test (inter-day, real-time and intra-day alike).

| OBR field | Manual meaning | Driver use |
|---|---|---|
| OBR-2 / OBR-3 | item number / item name | `instrumentAnalyteCode` / name |
| OBR-7 | QC time | `instrumentResultTimeLocal` |
| OBR-11, OBR-12 | the manual's table gives "control number 1" for OBR-11 and "control no." for OBR-12; its example puts the count in OBR-11 and `1^2` in OBR-12 (**U12**) | context; the entry count comes from splitting OBR-13 |
| OBR-13 | control names | `controlIdRaw` (one per entry) |
| OBR-14, OBR-15 | the manual's table says OBR-14 = expiry and OBR-15 = lot, its example has them the other way round (**U12**) | classify by content: a value of 8 or 14 digits starting with `19` or `20` is the expiry, anything else is the lot; `controlLotRaw` = the lot |
| OBR-17 | level: `L`, `M`, `H`, or a number 1–30 | `controlLevel` through option `qc_level_map` |
| OBR-18, OBR-19, OBR-20, OBR-21 | target, standard deviation, measured value, unit | target and SD are context (C9 holds its own targets); **OBR-20 = `valueRaw`**; OBR-21 = `unitRaw` |

- One QC record per entry (`recordClass = qc`). If the `^`-lists in OBR-13, 17, 18, 19 and 20 differ in length, the message is `instruments.message_malformed`: no guessing which entry is which.
- The manual says an abnormal QC result may arrive as `Error` or `-1` depending on the instrument's configuration. Store as received; add flag `METIS_QC_ERROR`; C9 decides.
- A QC message has no PID and never becomes a patient result.

## 5. Host query — "which sample is this, and what should I run on it?"

The analyser has three query modes. **Release 1 answers only mode (a)** (D-MET-1); (b) and (c) are answered `NF` so the operator sees "nothing to download" and is never given wrong data. Batch download needs a pending-order list per instrument; **CR-C7-022** adds it if the lab asks for it at commissioning (not raised unless needed).

| Mode | How the analyser asks | Release 1 |
|---|---|---|
| (a) one barcode | QRD-8 = barcode, QRF empty | answered (below) |
| (b) sample-number range (first = last for one sample) | QRD-8 empty, QRF-4 = first number, QRF-5 = last number | `NF` in QAK-2, reason `unsupported_query_mode` |
| (c) time range | QRD-8 empty, QRF-2 = start, QRF-3 = end (`YYYYMMDDHHMMSS`). The manual's QRF table calls it the sample **receiving** time; its §2.4.2 text calls it "test time" (**U15**) | same as (b) |

```
analyser → LIS   MSH|^~\&|||||20261114104700||QRY^Q02|61|P|2.3.1||||||UTF8|||
                 QRD|20261114104700|R|D|9|||RD|MT2600000042|OTH|||T|
                 QRF||||||RCT|COR|ALL||

LIS → analyser   MSH|^~\&|||||20261114104701||QCK^Q02|61|P|2.3.1||||||UTF8|||
                 MSA|AA|61|Message accepted|||0|
                 ERR|0|
                 QAK|SR|OK|
                 (or, when not found:  QAK|SR|NF|)

LIS → analyser   (only after OK)
                 MSH|^~\&|||||20261114104701||DSR^Q03|61|P|2.3.1||||||UTF8|||
                 MSA|AA|61|Message accepted|||0|
                 ERR|0|
                 QAK|SR|OK|
                 QRD|20261114104700|R|D|9|||RD||OTH|||T|
                 QRF||||||RCT|COR|ALL||
                 DSP|1||V000123|||
                 DSP|2|||||
                 DSP|3||Test Patient|||
                 DSP|4||19880912000000|||
                 DSP|5||F|||
                 DSP|6|||||
                 DSP|7 … DSP|20   (empty, present as in the manual)
                 DSP|21||MT2600000042|||
                 DSP|22|||||
                 DSP|23||20261114085730|||
                 DSP|24||N|||
                 DSP|25|||||
                 DSP|26||serum|||
                 DSP|27|||||
                 DSP|28|||||
                 DSP|29||0^^^|||
                 DSP|30||1^^^|||
                 DSC||

analyser → LIS   MSH|^~\&|||||<time>||ACK^Q03|<n>|P|2.3.1||||||UTF8|||
                 MSA|AA|<id>|Message accepted|||0|
                 ERR|0|
```

**Reply rules**

| Server finds | `QAK-2` | DSR |
|---|---|---|
| barcode known, receivable, **at least one pending test mapped to this instrument** (outbound code map, §6.6 step 4) | `OK` | sent, one `DSP` per mapped test |
| barcode unknown, not receivable, or no mapped pending test (`not_found`, `not_receivable`, `no_mapped_tests`) | `NF` | not sent |
| query mode (b) or (c) | `NF` | not sent |

Tests the lab ordered that are **not** mapped to this instrument are left out of the DSR; that is not an error. What the analyser does on `NF` is **U6**; the commissioning engineer observes and records it.

**DSP mapping** (HL7 escaping `| ^ ~ \ &` → `\F\ \S\ \R\ \E\ \T\`, line breaks removed; UTF-8). `DSP-1` is the running number, `DSP-2` stays empty, **`DSP-3` carries the value**:

| Item n (segment number) | Value | Source / rule |
|---|---|---|
| 1 | patient id | the patient identifier on the bill, never the internal UUID |
| 2 | bed number | always empty (no such concept here) |
| 3 | name, ≤ 32 characters | the registered name; **U10** whether the screen renders Devanagari, so option `name_script` (`as_registered` \| `latin_if_available`, default `as_registered`) |
| 4 | date of birth `YYYYMMDDHHMMSS` | only if recorded, time part `000000`; **empty when only an age is known, never invented from an age** |
| 5 | sex | `M`, `F`, other or unknown `O` |
| 6–10 | blood type, race, address, postal code, phone | always empty (PHI minimisation) |
| 11 | sample position | empty |
| 12 | collection time `YYYYMMDDHHMMSS` | if recorded, else empty |
| 13–14, 16, 18–20, 25, 27–28 | reserved or not used (the manual's example puts `1` in 25 although its table says not used) | empty |
| 15, 17 | patient type, charge type | empty (not held in a form the device vocabulary fits) |
| **21** | **sample barcode** | echo of the queried barcode |
| 22 | instrument sample number | empty. The manual says barcode **or** sample number is required, yet its examples fill both (**U9**); if the analyser insists, a later change adds an option |
| 23 | received time `YYYYMMDDHHMMSS` | the lab's receipt time of the sample if recorded, else empty |
| **24** | **emergency, required** | `Y` for a STAT order, else `N` |
| **26** | **sample type, required** | option `specimen_type_map`: serum→`serum`, plasma→`plasma`, whole blood→`blood`, urine→`urine`, CSF→`cerebrospinal fluid`, anything else→`others` |
| **29 and up** | **one `DSP` per mapped test**: `item id^name^unit^reference range` | the item id is the instrument code from the outbound map; the manual says it must equal the analyser's own item id. Default option `dsr_item_details` = `id_only` (`100^^^`, which the manual allows); `full` is available once commissioning shows the analyser benefits |
| DSC | continuation | one sample per reply: a `DSC` segment with an empty continuation field (empty = last) |

Determinism (the server rebuilds the reply on a duplicate query, §6.6 step 1): QCK and DSR both carry the query's MSH-10 as their own MSH-10 and as MSA-2, exactly as the manual's single-barcode example does (its multi-sample examples number the DSRs differently, which is part of **U14**; release 1 sends one DSR per query); MSH-7 is `ctx.receivedAt` rendered in the instrument timezone; QRD/QRF in the DSR echo the query's own (the manual's DSR example shows a different QRD-4, **U14**); the same query bytes and the same order state give byte-identical replies. The reply must also stay inert while the driver status is not `verified` (§6.6 step 2).

## 6. ACKs

LIS → analyser, built the way the manual's examples are (MSH-3..MSH-6 blank in its examples, see U3; MSH-16 echoed from the ORU; one trailing `|` after the last field of every segment). `<id>` is the MSH-10 of the message being answered:

```
MSH|^~\&|<ack_sending_app>|<ack_sending_facility>|||<time>||ACK^R01|<id>|P|2.3.1||||<MSH-16 of the ORU>||UTF8|||
MSA|AA|<id>|Message accepted|||0|
```

Other MSA lines, same MSH:

```
MSA|AE|<id>|Required field missing|||101|        required field missing
MSA|AE|<id>|Data type error|||102|                wrong data type
MSA|AR|<id>|Application internal error|||207|     not stored (internal error)
MSA|AR|<id>|Unsupported message|||200|            unsupported message type
```

The wording after MSA-2 follows the manual's error-code table (101, 102, 200, 207). From the analyser: accept any `ACK^Q03` (M8); do not require MSA-2 to equal the DSR id.

- The agent persists the message and commits before sending `AA` (02-TRD D-02). Queue-before-ACK is unchanged. Version 2.3.1 is **not** a reason to reject (203 is never sent for it).
- The manual's examples leave MSH-3..MSH-6 of the LIS replies blank. Our `protocol_options.hl7v2.ack_sending_app` pattern `^[A-Z0-9_]+$` rejects blank, so the defaults are `LIS` / `LIMS` as for H80E. If the analyser rejects them, **CR-C7-017** (already defined by the H80E addendum) relaxes the pattern for this driver too. **U3.**

## 7. Agent profile and transport

Profile code `getein_metis` in `apps/bridge-agent/internal/drivers/` (02-TRD §5.5), built on the fields CR-C7-016 added for H80E:

```go
SessionProfile{ Code: "getein_metis", Protocol: "hl7v2", HL7AckMode: "original",
  HostQueryMessageTypes: []string{"QRY^Q02"},
  ExpectAckOnReply: true, ReplyAckPolicy: "last", ReplyAckMatchControlId: false,
  ReplyTimeout: 10 * time.Second /* U7: how long the analyser waits for QCK and DSR; is QCK itself acknowledged */ }
```

- Transport `tcp_server`, `bind_address` = the lab PC's LAN IP (never `0.0.0.0`), `port` ≥ 1024, `allowed_peers` = [analyser IP]. The installer opens the inbound firewall rule only with `--allow-lan-listener` (02-TRD §5.12).
- If the API is unreachable the agent sends **no** reply (PRD AC-10.6); result messages queue locally and upload later. Same offline decision as D-H80-1.

## 8. Server driver

`services/api/src/modules/instruments/drivers/getein_metis/index.ts` (+ `testdata/`), registered in `registry.ts` and `instruments.g_drivers`:

| Property | Value |
|---|---|
| `code` / `version` | `getein_metis` / `0.1.0` |
| `protocol` / `status` | `hl7v2` / `generic` (never `verified`; §0) |
| `capabilities` | `resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: false, calibration: false` — `hostQuery` is inert while `status ≠ verified` |
| `manualRef` | `{ title: 'HL7 Communication Protocol (Applicable to Metis Series Analyzers)', documentId: 'getein-metis-hl7-communication-protocol', revision: 'unversioned' }` |
| `optionsSchema` | `type_flag_field` (default `MSH.16`), `qc_level_map` (object, default `{ "L": "low", "M": "mid", "H": "high" }`; the right-hand words must be the contract's level vocabulary, 03-IC §3.15), `name_script`, `specimen_type_map`, `dsr_item_details` (`id_only` \| `full`, default `id_only`) |
| `parse` | §3–§4; MSH-16 `1` or unknown `MSH-9` → `messageKind: 'other'`; no `MSH` → `instruments.message_malformed` |
| `extractHostQueryBarcodes` | mode (a): `[QRD-8 component 1]`; modes (b)/(c): `[]` and the reply is `NF`; mode (a) with empty or > 40 characters → `instruments.message_malformed` |
| `buildHostQueryReply` | §5 (`[QCK]` for `NF`, `[QCK, DSR]` for `OK`), using the existing `HostQueryAnswer.tests` mechanism |

Golden files (`testdata/`, synthetic): `oru-patient`, `oru-patient-qualitative`, `oru-patient-empty-obx-time`, `oru-qc`, `oru-qc-lists-differ`, `oru-calibration`, `qry-found`, `qry-not-found`, `qry-no-mapped-test`, `qry-sample-range`, `qry-time-range`, `malformed-no-msh`, `ack-q03-mismatched-id`, plus a replay test proving byte-identical replies.

## 9. Commissioning checklist (runbook: `docs/manual/instruments/getein-metis-commissioning.md`)

Done by the lab manager with the vendor engineer; each item is recorded in the instrument's commissioning checklist in the app.

1. Vendor engineer sets the analyser's static IP (same subnet as the lab PC) and its LIS settings. **Confirms U1:** whether the analyser connects out (the LIS address typed into it is the lab PC and port) or listens. If it listens, stop: CR-C7-021.
2. Bridge agent on the lab PC with a **static** LAN IP; instrument created with transport `tcp_server`; enrolment code issued and used (existing flow).
3. State `commissioning` (shadow): run 5 patient samples and 2 QC runs per level in use. Capture the raw messages and compare every value with the analyser's printout. **Confirms U3, U4, U5, U8, U12, U13** (U3: the analyser does not resend or complain about our ACK).
4. Read the analyser's own item list; record which ids the lab runs. **Confirms U2.** Map them to the lab's tests and review.
5. Host query in shadow: scan a registered tube; confirm `QCK OK` + `DSR`, the analyser shows the sample and runs the listed tests; confirm the `ACK^Q03` form and whether QCK is acknowledged. **Confirms U7, U9, U14.**
6. Scan an **unregistered** tube and a tube registered **without any test mapped to this analyser**; record what the analyser does on `NF`. **Confirms U6.**
7. Try the analyser's sample-number-range and time-range download once; record what it shows after `NF`. Ask the vendor engineer whether this unit accepts a LIS-pushed sample request. **Confirms U11, U15.** Decide with the lab manager whether CR-C7-022 is needed.
8. Register a patient with a Devanagari name; record whether the analyser renders it. **Confirms U10.** Record whether a calibration run arrives and is archived harmlessly.
9. Pull the internet link; scan a tube; record behaviour; restore; confirm queued results upload once (no duplicates). Sign off. Promotion to `verified` is a reviewed migration plus code change; `capabilities.host_query = true` on the instrument is then switched on by `instruments.instrument.manage` (aal2).

## 10. Change requests raised by this addendum

| CR | To | Type | Summary |
|---|---|---|---|
| CR-C7-020 | C0 (db) | schema | `instruments.g_drivers` row for `getein_metis`: one forward-only migration, **first statement `SET LOCAL ROLE lims_owner;`** like every other migration (db/migrations/20261105002000_instruments__create_instruments_schema.sql line 7), then one `INSERT` with the columns the H80E row uses (`code, display_name, protocol, vendor, status, driver_version, cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration, manual_title, manual_document_id, manual_revision`); `status = 'generic'`; no `UPDATE`. Approved with this addendum. |
| CR-C7-021 | C7 agent | transport | only if commissioning shows the analyser listens: a client-side TCP transport. Not raised unless needed. |
| CR-C7-022 | C7 | host query | only if the lab needs sample-number-range or time-range download: a per-instrument pending-order list behind `worklistDownload`. Not raised unless needed. |

CR-C7-017 (sender-name pattern) is reused from the H80E addendum if needed.

## 11. Tasks (lane C7b, binding lead decision LD-162)

| ID | Title | Main files |
|---|---|---|
| MET-T01 | Agent profile `getein_metis`; prove the ACK echoes MSH-12 `2.3.1`; simulator sessions | `apps/bridge-agent/internal/drivers/*`, `testdata/sessions/` |
| MET-T02 | Server driver: parse patient and QC results, calibration as `other`, golden files | `drivers/getein_metis/*`, `registry.ts` |
| MET-T03 | Host query: mode (a) answered with a test list, modes (b)/(c) answered `NF`, deterministic replay | `drivers/getein_metis/*`, `__tests__/hostQuery.getein_metis.test.ts` |
| MET-T04 | `g_drivers` row (CR-C7-020, with the role switch), options schema, registry check, simulator end-to-end | `db` migration via CR, `testdata/sessions/*`, `driver-registry-check.ts` |
| MET-T05 | Web: instrument preset "Getein Metis series" (after H80-T06, same files) | `apps/web/src/features/instruments/*` |
| MET-T06 | Runbook + site checklist for the vendor engineer and lab manager | `docs/manual/instruments/getein-metis-commissioning.md` |
| MET-T07 | Regression: full C7 suite green with both new drivers; driver shown `generic`, host-query toggle disabled until verified | tests only |
