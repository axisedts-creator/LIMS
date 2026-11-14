# Getein Metis analyser: commissioning checklist

For the vendor engineer and the lab manager. Source: C7 addendum 09-ADDENDUM-GETEIN-METIS section 9, binding lead decision LD-163 (2026-11-14).

All names, barcodes and addresses in this runbook are synthetic examples (made-up values such as `Test Patient`, barcode `MT2600000042`, IP `192.168.1.3`). Use the lab's real addresses on site. Never write real patient names in this sheet.

## How to use this sheet

- Do the nine steps in order. Print the sheet and fill in every blank.
- A blank marked `____` is a value you observe on site. Write what you saw, not what you expect.
- Items marked U1 to U15 are unverified. The protocol document does not confirm them. Only a real capture from the lab's own analyser can.
- The vendor engineer does the analyser-side work. Lab staff do the PC, the app and the sample work. The lab manager signs off.
- The driver stays in status `generic` until step 9 is signed. Host query does nothing before that.
- Only the single-barcode host query is answered. The sample-number-range and time-range queries are answered `NF` (not found).

Site: ____ (record the lab name).

## Step 1. Static IP and LIS address on the analyser

Who: the vendor engineer, with lab staff for the LIS part.

The address typed into the analyser is the lab PC that runs the bridge agent. It is never the cloud server. The analyser speaks plain MLLP with no TLS.

1. The vendor engineer sets the analyser's static IP. It must be on the same subnet as the lab PC. Lab staff do not do this part.
   - Observed analyser static IP: ____.
   - Observed lab PC static IP: ____.
2. The vendor engineer sets the analyser's LIS settings. With lab staff, type the LIS address and the port into the analyser. The LIS address is the lab PC's static LAN IP.
   - Observed LIS address typed in: ____.
   - Observed port typed in: ____.
3. U1: does the analyser connect out to the LIS address you typed, or does it listen and wait for the LIS to connect? Ask the vendor engineer and watch the first connection.
   - Record the observed answer for U1 (connects out or listens): ____.
4. If the analyser listens, stop here. The agent has no client-side connection. A change request, CR-C7-021, is needed first. Tell the program lead.

## Step 2. Bridge agent and instrument in the app

Who: lab staff, with the vendor engineer on call.

1. Install the bridge agent on the lab PC. The PC must have a static LAN IP.
2. In the app, create the instrument with transport `tcp_server`.
   - Set the listen address to the PC's static LAN IP, never to all addresses.
   - Set the port to a number of 1024 or higher. Use the same port as in step 1.
   - Set the allowed peer to the analyser's IP.
3. Issue the enrolment code in the app and use it on the agent, as in the normal enrolment flow. Do not write the code on this sheet.
   - Record the agent name and the time it showed as connected: ____.

## Step 3. Shadow run: 5 patient samples and 2 QC runs per level

Who: lab staff run the samples. The lab manager checks the comparison.

Set the instrument state to `commissioning`. This is the shadow state: results are captured and compared, but nothing is released.

1. Run 5 patient samples on the analyser. Run 2 QC runs per level in use.
2. Take the raw messages from the agent archive.
3. Compare every value with the analyser's own printout.
4. Confirm each U item below from the raw messages. Write the observed value.
   - U3: does the analyser accept our reply with the sender names LIS and LIMS, without resending or complaining? Record what you saw: ____.
   - U4: time format in the result time fields. Is it with slashes, such as 2026/11/14 09:30:00, or 14 digits? Record the value seen: ____.
   - U5: are the item id and the abbreviation in the fields the examples use, or swapped? Record the values seen for one result: ____.
   - U8: after an analyser restart, does the message control id start again at 1? Record the ids before and after: ____.
   - U12: meaning and order of the four QC fields. Record each field and what it holds: ____.
   - U13: how a retest relates to the original result. Record what you saw for one retest: ____.

## Step 4. Read the analyser's item list and map the tests

Who: lab staff, checked by the lab manager.

The list of items this unit runs is read from the analyser itself. Do not take it from the manual and do not guess. Look at the analyser's own item list on its screen and copy the ids.

1. Copy every item id the lab runs from the analyser's own item list.
   - U2: record the item ids and names the analyser itself shows: ____.
2. Map each id to the lab's test in the app.
3. The lab manager reviews the mapping before step 5.

## Step 5. Host query in shadow

Who: lab staff scan. The vendor engineer watches the analyser.

Keep the instrument in the shadow state. Scan a registered tube, one that exists in the app with at least one test mapped to this analyser.

1. Confirm the analyser gets `QCK OK` and then a `DSR` reply.
2. Confirm the analyser shows the sample and runs the listed tests.
3. Look at the `ACK^Q03` the analyser sends back. Note whether the analyser acknowledges the QCK.
4. Record the answers below.
   - U7: how long does the analyser wait for QCK and DSR, and does it acknowledge QCK? Record the time and what you saw: ____.
   - U9: does the analyser need the sample number as well as the barcode? Record the observed answer: ____.
   - U14: control ids, the echoed query and sample numbering in our replies. Record anything the analyser rejected or changed: ____.

## Step 6. Unregistered tube and tube without a mapped test

Who: lab staff. The vendor engineer watches the analyser.

1. Scan an unregistered tube. The reply is `NF`.
2. Scan a tube registered without any test mapped to this analyser. The reply is `NF` too.
3. Record what the analyser does each time.
   - U6: what does the analyser do on `NF`? Record the behaviour for both tubes: ____.

## Step 7. Range downloads and LIS-pushed requests

Who: lab staff try the downloads. The vendor engineer answers the last question.

1. On the analyser, try the sample-number-range download once. Then try the time-range download once. The app answers `NF` to both.
2. Record what the analyser shows after `NF`.
   - U15: is the time-range query by receiving time or by test time? Record the observed answer: ____.
3. Ask the vendor engineer whether this unit accepts a LIS-pushed sample request.
   - U11: record the answer the vendor engineer gave: ____.
4. Decide with the lab manager whether the lab needs these downloads. If yes, CR-C7-022 is needed. It is not built in release 1.
   - Record the decision and the date: ____.

## Step 8. Devanagari name and calibration

Who: lab staff, with the vendor engineer watching the analyser.

1. Register a synthetic patient with a Devanagari name and scan the tube.
   - U10: does the analyser screen render the Devanagari name? Record what the screen shows: ____.
2. Run a calibration if the lab does one. A calibration result arrives and is archived. It makes no events and no patient result.
   - Record whether a calibration run arrived and was archived: ____.

## Step 9. Offline test and sign off

Who: lab staff run the test. The lab manager and the vendor engineer sign.

With no internet, the agent sends no reply to a host query. The analyser times out. Result messages are queued on the lab PC and upload later.

1. Pull the internet link on the lab PC. Keep the LAN to the analyser up.
2. Scan a registered tube.
   - Observed analyser behaviour with the internet pulled: ____.
3. Restore the internet link. Wait for the queue to empty.
4. Check that the queued results arrive in the app once. There must be no duplicates.
   - Record the number of copies of each result seen in the app: ____.
5. Check that every blank above is filled. Then sign below.
   - Lab manager name (record): ____.
   - Vendor engineer name (record): ____.
   - Date of sign-off (record): ____.
6. Promotion to `verified` is not done by this sheet. It is a reviewed migration plus a code change.
7. Only after that, someone with the permission `instruments.instrument.manage` (aal2) switches on `capabilities.host_query = true` for this instrument.
