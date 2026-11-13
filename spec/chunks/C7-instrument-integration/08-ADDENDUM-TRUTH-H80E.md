# C7 addendum — Truth-H80E HbA1c analyser (HL7 v2.3 over TCP/MLLP, host query)

Status: ACTIVE amendment to `02-TRD.md` §5.4–5.5, §6.1–6.3, §6.6 · Date: 2026-11-13 · Owner: program lead
Binding for tasks `H80-T01 … H80-T08` (`C:\LIMS-state\tasks\C7-instrument-integration.json`) and for the lead decisions in `lead-decisions-C7-instrument-integration.md` (`[ALL]` lines).

## 0. Sources and honesty rules

- **Truth Biotechnology "HL7 Interface User Manual", Version 1.5** (17 pages; model line "Truth-H80E, fully automated glycated haemoglobin analyser"). Its message examples are page images; the field positions below were read from those images (counted, not machine-readable). Every position marked **U** is *unverified until a real capture from the lab's analyser* (§9).
- **Truth "LIS Operating Manual"** (1 page, instrument-side setup).
- This closes blocker B2 **only for this one model, and only partly**: the manual exists, so the driver may be written; it stays status `generic` (shadow/commissioning only) until the commissioning checklist (§9) is signed and a reviewed migration + code change promote it to `verified` (02-TRD §6.1 CI job `c7-driver-registry-check`).
- Synthetic data only in tests and fixtures: names such as `Test Patient`, barcodes such as `E2600000042`, never real patient or lab data.

## 1. Topology (what "the static IP" is)

```
Truth-H80E (TCP CLIENT, static IP e.g. 192.168.1.3)  ──LAN──▶  lab PC running the bridge agent (static IP e.g. 192.168.1.2, TCP SERVER :port)
                                                                      │  HTTPS, device token (04 A13)
                                                                      ▼
                                                           LIS API: ingest (E01) · host query (E05)
```

- The analyser connects **out** to a LIS server address and port that the lab types into the instrument: `[Apply] → [Set] → [Lis]` (LIS Operating Manual step 2). That address is the **lab PC with the bridge agent** (transport `tcp_server`, §5.8: `bind_address` = the PC's static LAN IP, `port`, `allowed_peers` = [the analyser's IP]). It is not the cloud server: the analyser speaks raw MLLP with no TLS and no internet route.
- The analyser's own address is a static address on the same subnet, set by the vendor engineer in the instrument's Android settings (needs the engineer root account: `[Apply] → [Engineer] → Close Software` → Settings → Ethernet → static; LIS Operating Manual steps 3–6). Lab staff do not do this step.
- Link check: ping the analyser from the lab PC (step 7), then the LIS icon in the analyser's navigation bar turns green (step 8). A single stored result can be re-sent by hand from the analyser ("click on any sample result and upload it").
- The instrument's LIS settings screen also lists Enable/Duplex/Result Flag/Abnormal Results/Alarm Prompt options; **U**: exact labels and effects are not in the manual text we hold; the commissioning engineer records the values used.

## 2. Messages (MLLP: `0x0B` … `0x1C 0x0D`, UTF-8, HL7 2.3, processing id `P`)

| # | Direction | MSH-9 | Purpose | Our action |
|---|---|---|---|---|
| M1 | analyser → LIS | `ORU^R01` | patient results (one per sample, several OBX) | parse; reply M2 |
| M2 | LIS → analyser | `ACK^R01` | accept / reject | `AA` or `AR` (§6) |
| M3 | analyser → LIS | `ORU^R01` with type flag 1 | QC result | parse as QC; reply M2 |
| M4 | analyser → LIS | `QRY^Q02` | "which sample is barcode X?" | host query (§5); reply M5 and M6 |
| M5 | LIS → analyser | `QCK^Q02` | query acknowledgement, `OK` or `NF` | built by the driver |
| M6 | LIS → analyser | `DSR^Q03` | patient/sample details (only after `OK`) | built by the driver |
| M7 | analyser → LIS | `ACK^Q03` | confirms the DSR | accepted, not matched strictly (§6) |

The introduction of the manual also mentions calibration results; **no calibration message example is given**, so the driver sets `capabilities.calibration = false` and treats any such message as `other` (archived, no events).

## 3. Result message M1 (patient) — layout as in the manual, synthetic values

```
MSH|^~\&|Truth|Truth-H80E|||20261105173723||ORU^R01|1|P|2.3||||0||UTF-8||||
PID|1||2600000123||Test Patient|General Practice Department|19880912|1||||
OBR|1|0001|E2600000042||||||||||||1||||
OBX|1|NM|HbA1c_NGSP||5.63|%||0|||||20261105173723||||
OBX|2|NM|HbA1c_IFCC||37.82|mmol/mol||0|||||20261105173723||||
OBX|3|NM|HbF||0.92|%||0|||||20261105173723||||
OBX|4|NM|HbA1||6.93|%||0|||||20261105173723||||
OBX|5|NM|eAG||5.82|mmol/L||0|||||20261105173723||||
OBX|6|NM|A1ab||1.05|%||0|||||20261105173723||||
OBX|7|NM|HbLA1C+||3.25|%||0|||||20261105173723||||
OBX|8|NM|HbA0||85.35|%||0|||||20261105173723||||
OBX|9|NM|A1A||0.35|%||0|||||20261105173723||||
OBX|10|NM|A1B||0.7|%||0|||||20261105173723||||
OBX|11|ED|Chromatogram||/9j/4AAQSkZJRgABAQ...||||||||20261105173723||||
```

| Field | Meaning (manual) | Driver use |
|---|---|---|
| MSH-3 / MSH-4 | `Truth` / `Truth-H80E` (sender, device name) | recorded; not used for matching |
| MSH-7 | send time `YYYYMMDDHHMMSS` | `messageTimeLocal` |
| MSH-10 | message control id | message key (04 N10); ACK echoes it |
| MSH-16 **U** | type: `0` patient, `1` QC | hint only; **primary classifier is PID present (patient) / PID absent with the QC OBR layout (QC)** |
| PID-3 | medical record number | ignored for matching (barcode is the key); stored only in the encrypted raw archive |
| PID-5, PID-6, PID-7, PID-8 | name, department, date of birth `YYYYMMDD`, gender `0/1/2` | ignored by the driver; never copied to events (PHI minimisation, REQ-SEC) |
| OBR-2 | instrument sample number (e.g. `0001`) | warning-level context only |
| **OBR-3** | **sample barcode** | `sampleBarcode` (≤ 40, 03-IC §3.14) |
| OBR-15 **U** (position counted from the page image) | detection mode `1` whole blood, `2` haemolysis | option `detection_mode_field`, default `OBR.15`; recorded as warning-free metadata only |
| OBX-3 | analyte code | `instrumentAnalyteCode` (table below) |
| OBX-5 | value | `valueRaw`; `recordKind = quantitative` for `NM` |
| OBX-6 | unit | `unitRaw` |
| OBX-8 **U** | "mark 1: ↑, 0: ↓" | stored as flag `H80E_MARK:<v>`; the manual's own examples show `0` on every value including a normal 5.63 %, so it is **not used to decide abnormal/critical**: C5 evaluates ranges from the C3 catalog |
| OBX-13 / OBX-14 **U** | result time `YYYYMMDDHHMMSS`, local. As counted from the manual's pages, the patient example puts it in OBX-13 and the QC example in OBX-14 (standard HL7 is OBX-14) | the driver takes the first 14-digit value among OBX-12, OBX-13, OBX-14; `instrumentResultTimeLocal`; instrument timezone default tenant timezone (Asia/Kathmandu) |

Literal `null` in any field (the QC example uses it in OBX-8) is treated as empty.

**Analyte codes seen in the manual** (all mapped through C3 `catalog.instrument_code_map.manage`; rows are tenant data created at commissioning, none are seeded in production): `HbA1c_NGSP` (%), `HbA1c_IFCC` (mmol/mol), `HbF`, `HbA1`, `eAG` (mmol/L in the manual's example), `A1ab`, `HbLA1C+`, `HbA0`, `A1A`, `A1B` (all %), `Chromatogram` (`ED`).

**Chromatogram.** `OBX-2 = ED`, OBX-5 holds a base64 JPEG (starts `/9j/`). The driver emits one `recordKind = attachment` record per message and the pipeline stores the picture through the same upload path as §6.8 (re-encode, strip metadata, scan, then `instruments.result.received.v1` with `attachment`). This needs a contract change: **CR-C7-015** (§10). Size is **U**: the manual gives no size; the ingest cap is 1 MiB per message (§6.4 step 1). If the real capture is larger, a further CR raises the cap for this instrument only.

## 4. QC message M3

```
MSH|^~\&|Truth|Truth-H80E|||20261105190559||ORU^R01|1|P|2.3||||1||UTF-8|||
OBR|1|2|A0926|NGSP|L|20270926000000|20261105111537||4.4|0.3||5.2403173|0.013031356||0.0024867496||||
OBX|1|NM|HbA1c_NGSP||5.24|%||null||||||20261105111537||||
OBX|2|NM|HbA1c_IFCC||33.70|mmol/mol||null||||||20261105111537||||
OBX|3|NM|HbF||0.18|%||null||||||20261105111537||||
OBX|4|NM|HbA1||7.15|%||null||||||20261105111537||||
OBX|5|NM|HbA1c_NGSP||5.26|%||null||||||20261105111637||||
```

| OBR field (manual labels) | Driver use |
|---|---|
| OBR-2 project number | context |
| **OBR-3** QC solution batch number | `controlIdRaw` **and** `controlLotRaw` |
| OBR-4 reference type (`NGSP`) | context |
| OBR-5 level (`L` low; the other level letters are not listed — **U**) | `controlLevel` |
| OBR-6 expiry `YYYYMMDDHHMMSS` | context |
| OBR-7 QC time | `instrumentResultTimeLocal` fallback |
| OBR-9, OBR-10 | reference value, deviation: context (C9 holds its own targets) |
| OBR-12, OBR-13, OBR-15 | result, SD, CV of the run: context |
| OBX rows | one QC record per OBX (`recordClass = qc`); the time is read as for patient results (first 14-digit value among OBX-12…OBX-14); rows of one run share a time |

QC records satisfy 03-IC §3.15 (`control_id_raw` 1–64 = the batch number, `value_raw` 1–64). A QC message has no barcode and no PID; the driver never treats it as a patient result.

## 5. Host query — "which sample is this tube, and should I run it?"

```
analyser → LIS   MSH|^~\&|Truth|Truth-H80E|||20261105103542||QRY^Q02|126|P|2.3||||||UTF-8||||
                 QRD|20261105103542|R|D|65|||RD|E2600000042||||
                 QRF|||||RCT|COR|ALL|||

LIS → analyser   MSH|^~\&|Truth|Truth-H80E|||20261105103542||QCK^Q02|12601|P|2.3|||||UTF-8||||
                 MSA|AA|126|Message accepted|||0
                 ERR|0
                 QAK|SR|OK|||||                      (or  QAK|SR|NF|||||  when not found)

LIS → analyser   (only after OK)  MSH|^~\&|Truth|Truth-H80E|||20261105103542||DSR^Q03|12602|P|2.3||||||UTF-8||||
                 MSA|AA|126|Message accepted|||0
                 ERR|0
                 QAK|1|OK|||||
                 QRD|20261105103542|R|D|65|||RD||OTH|||T|
                 DSP|1||2600000123|||          patient id
                 DSP|2||General Practice Department|||   department
                 DSP|3||Test Patient|||        name
                 DSP|4||19880912|||            date of birth
                 DSP|5||1|||                   gender 0 unknown, 1 male, 2 female
                 DSP|6||<history>|||           medical history
                 DSP|7|||||  … DSP|12|||||     (empty, present in the manual's example)
                 DSP|13||2600000123|||         medical record number
                 DSP|14|||||  … DSP|20|||||    (empty)
                 DSP|21||E2600000042|||        sample barcode
                 DSP|22||0|||                  detection mode 1 whole blood, 2 haemolysis, 0 per instrument program
                 DSC|0|

analyser → LIS   MSH|^~\&|Truth|Truth-H80E|||20261105103542||ACK^Q03|127|P|2.3||||||UTF-8||||
                 MSA|AA|126|Message accepted|||0
                 ERR|0
```

**What the reply can and cannot say.** The DSR carries identity and a detection mode; **it has no test list**. The H80E is a single-assay (HbA1c) analyser, so it cannot be told "run only these tests". The LIS decision is therefore binary:

| Server finds | `QAK-2` | DSR |
|---|---|---|
| barcode known, receivable, **at least one pending test mapped to this instrument** (outbound code map, §6.6 step 4) | `OK` | sent |
| barcode unknown, not receivable, or **no HbA1c order pending** (`not_found`, `not_receivable`, `no_mapped_tests`) | `NF` | not sent |

What the analyser then does on `NF` (refuse to run, run anyway with manual entry, show a prompt) is **U**; the commissioning engineer observes and records it (§9, item 6). For analysers whose own interface does carry test codes, the existing `HostQueryAnswer.tests` mechanism is used; nothing here changes it.

**DSP mapping from LIS data** (all values go through HL7 escaping: `| ^ ~ \ &` → `\F\ \S\ \R\ \E\ \T\`, line breaks removed; UTF-8):

| DSP | Value | Source / rule |
|---|---|---|
| 1 | patient id | C4 patient identifier shown on the bill (not the internal UUID) |
| 2 | department | referring unit or centre name; empty if none |
| 3 | name | the registered name; **U** whether the instrument screen renders Devanagari — if not, the driver falls back to the Latin form when the registration holds one (§9, item 7) |
| 4 | date of birth `YYYYMMDD` | only if the date of birth is recorded; **empty when only age is known — never invented from an age** |
| 5 | gender | male `1`, female `2`, other/unknown `0` |
| 6 | history | **always empty** (clinical notes are not sent to a device: PHI minimisation) |
| 13 | medical record number | the order (accession) number of this registration |
| 21 | barcode | echo of the queried barcode |
| 22 | detection mode | instrument option `host_query_detection_mode`, default `0` (the lab's instrument program decides); `1`/`2` only if the lab sets it |

Determinism (needed because the server rebuilds the reply on a duplicate query, §6.6 step 1): reply control ids are `<query MSH-10>01` (QCK) and `<query MSH-10>02` (DSR); `MSH-7` is `ctx.receivedAt` rendered in the instrument timezone; the same query bytes and the same order state give byte-identical replies.

## 6. ACKs

| Case | LIS → analyser |
|---|---|
| M1/M3 stored | `MSH|^~\&|Truth|Truth-H80E|||<time>||ACK^R01|<n>|P|2.3||||||UTF-8||||` + `MSA|AA|<MSH-10 of the ORU>|Message accepted|||0` + `ERR|0` |
| not stored (internal error) | same MSH, `MSA|AR|<MSH-10>|Internal application error|||207`, `ERR|0` (manual's error example) |
| M7 from analyser | accept any `ACK^Q03`; the manual's example carries `MSA-2 = 126` although the DSR it answers had control id 171, so **do not require MSA-2 to equal the DSR id** |

- The agent persists the message and commits before sending `AA` (02-TRD D-02). The queue-before-ACK rule is unchanged.
- The manual shows MSH-3/MSH-4 of the LIS replies as `Truth` / `Truth-H80E` (echo of the instrument). Our `protocol_options.hl7v2.ack_sending_app` pattern is `^[A-Z0-9_]+$`, which rejects both. Decision: the instrument's `ack_sending_app`/`ack_sending_facility` default to `LIS` / `LIMS`; if the commissioning engineer finds the analyser rejects them, **CR-C7-017** relaxes the pattern for this driver. **U**.

## 7. Agent profile and transport

Profile code `truth_h80e` in `apps/bridge-agent/internal/drivers/` (02-TRD §5.5):

```go
SessionProfile{ Code: "truth_h80e", Protocol: "hl7v2", HL7AckMode: "original",
  HostQueryMessageTypes: []string{"QRY^Q02"},
  ExpectAckOnReply: true, ReplyAckPolicy: "last", ReplyAckMatchControlId: false,   // new fields, CR-C7-016
  ReplyTimeout: 10 * time.Second /* U: how long the analyser waits for QCK */ }
```

- `ReplyAckPolicy`: `each` (current behaviour), `last` (only the final reply message is acknowledged: here the DSR; **U** whether the analyser also ACKs the QCK), `none`. With `last`, QCK is written, then DSR is written immediately, then the agent waits for `ACK^Q03`. **CR-C7-016**.
- Transport: `tcp_server`, `bind_address` = the lab PC's LAN IP (never `0.0.0.0`), `port` ≥ 1024, `allowed_peers` = [analyser IP]. The installer opens the inbound firewall rule only with `--allow-lan-listener` (02-TRD §5.12).
- If the API is unreachable the agent sends **no** reply (PRD AC-10.6); the analyser times out. Result messages still queue locally and upload later. **Offline behaviour decision (D-H80-1):** accepted for the first release; a local pending-order cache in the agent (using the existing `worklistDownload` capability, CR-C7-005) is a possible later CR, not built now.

## 8. Server driver

`services/api/src/modules/instruments/drivers/truth_h80e/index.ts` (+ `testdata/`), registered in `registry.ts` and `instruments.g_drivers`:

| Property | Value |
|---|---|
| `code` / `version` | `truth_h80e` / `0.1.0` |
| `protocol` / `status` | `hl7v2` / `generic` (not `verified`; §0) |
| `capabilities` | `resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: true, calibration: false` — `hostQuery` is inert while `status ≠ verified` (§6.6 step 2) |
| `manualRef` | `{ title: 'HL7 Interface User Manual — Fully Automated Glycated Hemoglobin Analyzer', documentId: 'truth-h80e-hl7-interface-user-manual', revision: '1.5' }` |
| `optionsSchema` | `detection_mode_field` (default `OBR.15`), `type_flag_field` (default `MSH.16`), `host_query_detection_mode` (`0`/`1`/`2`, default `0`), `name_script` (`as_registered` \| `latin_if_available`, default `as_registered`), `qc_level_map` (object, default `{ "L": "low" }`) |
| `parse` | §3–§4; unknown `MSH-9` → `messageKind: 'other'`; no `MSH` → `instruments.message_malformed` |
| `extractHostQueryBarcodes` | `[QRD-8 component 1]`; empty or > 40 chars → `instruments.message_malformed` |
| `buildHostQueryReply` | §5 (`[QCK]` for `NF`, `[QCK, DSR]` for `OK`) |

Golden files (`testdata/`, synthetic): `oru-patient`, `oru-qc`, `oru-chromatogram`, `qry-found`, `qry-not-found`, `qry-no-hba1c-order`, `malformed-no-msh`, `ack-q03-mismatched-id`, plus a replay test proving byte-identical replies.

## 9. Commissioning checklist (runbook: `docs/manual/instruments/truth-h80e-commissioning.md`)

Done by the lab manager with the vendor engineer; each item is recorded in the instrument's commissioning checklist in the app (`manual_reference_confirmed`, `sample_comparison_done`, `qc_comparison_done`, `mappings_reviewed`).

1. Vendor engineer sets the analyser's static IP (same subnet as the lab PC) and, with lab staff, the LIS address and port (`[Apply] → [Set] → [Lis]`); ping test; LIS icon green.
2. Bridge agent installed on the lab PC with a **static** LAN IP; instrument created in the app with transport `tcp_server`; enrolment code issued and used (existing flow).
3. Instrument state `commissioning` (shadow): run 5 patient samples and 2 QC runs. Capture the raw messages (agent archive) and compare every value with the analyser's own printout (`sample_comparison_done`, `qc_comparison_done`). **Confirms U:** MSH-16, OBR-15 position, result-time position (OBX-13 vs OBX-14), OBX-8 semantics, QC level letters, chromatogram size.
4. Map analyte codes (`HbA1c_NGSP` → the lab's HbA1c test, etc.) and review (`mappings_reviewed`).
5. Host query in shadow: scan a registered tube; confirm `QCK OK` + `DSR`, the analyser shows the patient and runs; confirm the ACK^Q03 form (MSA-2, whether QCK is acknowledged). **Confirms U:** reply timeout, ACK policy.
6. Scan an **unregistered** tube and a tube **registered without HbA1c**; record what the analyser does on `NF`.
7. Register a patient with a Devanagari name; record whether the analyser screen renders it.
8. Pull the internet link; scan a tube; record behaviour; restore; confirm queued results upload once (no duplicates).
9. Sign off. Promotion to `verified` is a reviewed migration plus code change (CI job `c7-driver-registry-check`); `capabilities.host_query = true` on the instrument is then switched on by `instruments.instrument.manage` (aal2).

## 10. Change requests raised by this addendum

| CR | To | Type | Summary |
|---|---|---|---|
| CR-C7-015 | C7 (+ C0-0C for the event field) | port/event | `ParsedRecord` gains optional `inlineAttachment { mimeType: 'image/jpeg' \| 'image/png', base64: string }`; the ingest pipeline sends it through `ctx.uploads.accept` exactly as §6.8 step 2, then publishes the existing attachment event. No new event. |
| CR-C7-016 | C7 agent | agent spec | `SessionProfile` fields `ReplyAckPolicy` (`each`\|`last`\|`none`) and `ReplyAckMatchControlId` (bool); defaults keep today's behaviour. |
| CR-C7-017 | C7 | schema | only if commissioning shows the analyser rejects the default sender names: relax `ack_sending_app` pattern for this driver. Not raised unless needed. |

## 11. Tasks (in the task file since 2026-11-13, lane C7b, binding lead decision LD-139; H80-T06 also waits for the restyle task RS-C7)

| ID | Title | Main files |
|---|---|---|
| H80-T01 | Agent profile `truth_h80e` + `ReplyAckPolicy` / `ReplyAckMatchControlId` (CR-C7-016) | `apps/bridge-agent/internal/drivers/*`, `internal/mllp/*`, `testdata/sessions/` |
| H80-T02 | Server driver: parse patient + QC results, golden files | `drivers/truth_h80e/*`, `registry.ts` |
| H80-T03 | Host query: extract, build QCK/DSR, OK/NF rules, deterministic replay | `drivers/truth_h80e/*`, `service/hostQuery.service.ts` tests |
| H80-T04 | Inline chromatogram attachment (CR-C7-015) | `drivers/types.ts`, `service/ingest.service.ts`, attachments tests |
| H80-T05 | `g_drivers` row, options schema, registry check, simulator sessions (ORU, QRY found, QRY NF, no-order NF, Q03 id mismatch) | `db` migration via CR, `testdata/sessions/*`, API/agent e2e |
| H80-T06 | Web: instrument preset "Truth H80E" (transport `tcp_server`, options form, code-map suggestions, commissioning checklist wording) | `apps/web/src/features/instruments/*` |
| H80-T07 | Runbook + site checklist for the vendor engineer and lab manager | `docs/manual/instruments/truth-h80e-commissioning.md` |
| H80-T08 | Regression: full C7 suite green with the new driver; instrument list shows driver status `generic` and host-query toggle disabled until verified | tests only |
