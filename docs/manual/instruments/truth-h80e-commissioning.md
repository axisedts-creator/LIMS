# Truth-H80E analyser: commissioning checklist

For the vendor engineer and the lab manager. Source: C7 addendum 08-ADDENDUM-TRUTH-H80E section 9, binding lead decision LD-139 (2026-11-13).

All names, barcodes and addresses in this runbook are synthetic examples (made-up values such as `Test Patient`, barcode `E2600000042`, IP `192.168.1.3`). Use the lab's real addresses on site. Never write real patient names in this sheet.

## How to use this sheet

- Do the nine steps in order. Print the sheet and fill in every blank.
- A blank marked `____` is a value you observe on site. Write what you saw, not what you expect.
- Items marked U are unverified. The manual does not confirm them. Only a real capture from the lab's own analyser can.
- The vendor engineer does the instrument-side work. Lab staff do the PC, the app and the sample work. The lab manager signs off.
- The driver stays in status `generic` until step 9 is signed. Host query does nothing before that.
- The app keeps four checklist flags for this instrument: `manual_reference_confirmed`, `sample_comparison_done`, `qc_comparison_done` and `mappings_reviewed`.

Site: ____ (record the lab name).

## Step 1. Static IP and LIS address on the analyser

Who: the vendor engineer, with lab staff for the LIS part.

The analyser is the TCP client. It connects out to the address typed into its LIS settings. That address is the lab PC that runs the bridge agent. It is not the cloud server.

1. The vendor engineer sets the analyser's static IP. It must be on the same subnet as the lab PC. This needs the engineer root account: `[Apply] → [Engineer] → Close Software`, then Settings, Ethernet, static. Lab staff do not do this part.
   - Observed analyser static IP: ____.
   - Observed lab PC static IP: ____.
2. With lab staff, type the LIS address and port into the analyser: `[Apply] → [Set] → [Lis]`. The LIS address is the lab PC's static LAN IP.
   - Observed LIS address typed in: ____.
   - Observed port typed in: ____.
3. The LIS settings screen also shows Enable, Duplex, Result Flag, Abnormal Results and Alarm Prompt. The manual does not explain these labels (U).
   - Record the exact labels and the value used for each (Enable, Duplex, Result Flag, Abnormal Results, Alarm Prompt): ____.
4. From the lab PC, ping the analyser's static IP.
   - Record the ping result (replies, lost, time): ____.
5. Look at the LIS icon in the analyser's navigation bar. It must turn green once the agent is listening (after step 2).
   - Record the icon colour seen: ____.

## Step 2. Bridge agent and instrument in the app

Who: lab staff, with the vendor engineer on call.

1. Install the bridge agent on the lab PC. The PC must have a static LAN IP. Run the installer with `--allow-lan-listener`. Without this flag the installer opens no inbound firewall rule, and the instrument shows `link_state = error`.
2. In the app, create the instrument with transport `tcp_server`.
   - Set the bind address to the PC's static LAN IP. Never use `0.0.0.0`.
   - Set the port to a number of 1024 or higher. Use the same port as in step 1.
   - Set the allowed peer to the analyser's IP.
3. Issue the enrolment code in the app and use it on the agent, as in the normal enrolment flow. Do not write the code on this sheet.
   - Record the agent name and the time it showed as connected: ____.

## Step 3. Shadow run: 5 patient samples and 2 QC runs

Who: lab staff run the samples. The lab manager checks the comparison.

Set the instrument state to `commissioning`. This is the shadow state: results are captured and compared, but nothing is released.

1. Run 5 patient samples and 2 QC runs on the analyser.
2. Take the raw messages from the agent archive.
3. Compare every value with the analyser's own printout. When all values match, tick `sample_comparison_done` for the patient samples and `qc_comparison_done` for the QC runs.
4. Also tick `manual_reference_confirmed` once the manual revision on file (1.5) matches the analyser's manual.
5. Confirm each U item below from the raw messages. Write the observed value.
   - MSH-16 type flag: Record the value for a patient message and for a QC message: ____.
   - OBR-15 position (detection mode): Record the field number where the detection mode really sits: ____.
   - Result-time position, OBX-13 or OBX-14: Record which one holds the 14-digit time: ____.
   - OBX-8 meaning (the manual says mark 1 is up, 0 is down): Record the values seen for a normal and an abnormal result: ____.
   - QC level letters. The manual lists only `L` for low: Record every level letter seen and its level: ____.
   - Chromatogram size: Record the size of the chromatogram message in kilobytes: ____.
   - Sender names. The reply uses LIS / LIMS as sender names (`ack_sending_app`). Record whether the analyser accepted them: ____.

## Step 4. Map the analyte codes

Who: lab staff, checked by the lab manager.

1. Map each analyte code to the lab's own test. Start with `HbA1c_NGSP` for the lab's HbA1c test.
2. Map the other codes the lab wants to keep: `HbA1c_IFCC`, `HbF`, `HbA1`, `eAG`, `A1ab`, `HbLA1C+`, `HbA0`, `A1A`, `A1B` and `Chromatogram`.
3. The lab manager reviews the mappings and ticks `mappings_reviewed`.
   - Record the number of codes mapped and the date reviewed: ____.

## Step 5. Host query in shadow

Who: lab staff scan, the vendor engineer watches the analyser.

1. Register a synthetic patient with an HbA1c order in the app. Print the barcode label.
2. Scan the registered tube on the analyser.
3. Confirm the server answers `QCK OK` and then the `DSR`. Confirm the analyser shows the patient and runs the sample.
   - Observed analyser behaviour after the scan: ____.
4. The DSR carries identity and a detection mode. It has no test list, because the H80E runs one assay.
5. Confirm the analyser's `ACK^Q03` form. The manual's example has an MSA-2 that does not match the DSR id, and the server does not require a match.
   - Record the MSA-2 value seen in the ACK^Q03: ____.
6. Confirm these U items.
   - Reply timeout: Record how long the analyser waits for the QCK, in seconds: ____.
   - ACK policy: Does the analyser acknowledge the QCK as well as the DSR? Record the answer: ____.

## Step 6. Unregistered tube and tube without HbA1c (NF)

Who: lab staff scan, the vendor engineer watches the analyser.

When the server finds no pending HbA1c order, it answers `NF`. The analyser's reaction is U. It may refuse, run anyway, or show a prompt.

1. Scan an unregistered tube (a barcode the app does not know).
   - Observed analyser behaviour for an unregistered tube: ____.
2. Register a second synthetic patient with a test other than HbA1c. Scan that tube.
   - Observed analyser behaviour for a tube registered without HbA1c: ____.

## Step 7. Devanagari name

Who: lab staff.

1. Register a synthetic patient whose made-up name is written in Devanagari. Scan the tube.
2. Look at the analyser screen.
   - Record whether the name shows correctly (yes, boxes, blank, other): ____.
3. If it does not show, set the instrument option `name_script` to `latin_if_available`. Register a Latin form of the name and scan again.
   - Record the result with the Latin form: ____.

## Step 8. Internet link pulled and restored

Who: lab staff, with the vendor engineer watching the analyser.

With no internet, the agent sends no reply to a host query. The analyser times out. Result messages are queued on the lab PC and upload later.

1. Pull the internet link on the lab PC. Keep the LAN to the analyser up.
2. Scan a registered tube.
   - Observed analyser behaviour with the internet pulled: ____.
3. Run one synthetic sample on the analyser while offline.
4. Restore the internet link. Wait for the queue to empty.
5. Check that the queued result arrives in the app once, and that the app shows no duplicates.
   - Record the number of copies of that result seen in the app: ____.

## Step 9. Sign off

Who: the lab manager and the vendor engineer.

1. Check that every blank above is filled and every flag in the app is ticked.
2. Sign below.
   - Lab manager name (record): ____.
   - Vendor engineer name (record): ____.
   - Date of sign-off (record): ____.
3. Promotion to `verified` is not done by this sheet. It is a reviewed migration plus a code change. The CI job `c7-driver-registry-check` must pass.
4. Only after that, someone with the permission `instruments.instrument.manage` (aal2) switches on `capabilities.host_query = true` for this instrument.
5. If the analyser rejected the default sender names in step 3, tell the program lead. A change request (CR-C7-017) is needed before sign-off.
