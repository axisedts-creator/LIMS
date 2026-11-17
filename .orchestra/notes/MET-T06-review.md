APPROVE

# MET-T06 review (reviewer)
- Diff 385df97e..HEAD: runbook `docs/manual/instruments/getein-metis-commissioning.md`, test `tests/docs/MET-T06.commissioning.test.mjs`, own notes. Owned paths only; no spec/contract/H80E change.
- Nine steps match addendum 09 §9 in order and content; U1..U15 each a `____` blank in the step §0 table assigns (U1:1, U2:4, U3/4/5/8/12/13:3, U7/9/14:5, U6:6, U11/15:7, U10:8).
- Vendor engineer (static IP, LIS settings, LIS-push question) vs lab staff split stated per step; step 4 says the item list is read from the analyser itself.
- Transport details (tcp_server, bind to LAN IP never all addresses, port >= 1024, allowed peer, no TLS), offline no-reply (§7, AC-10.6), CR-C7-021/022, verified via migration + `instruments.instrument.manage` (aal2) all trace to addendum §1/§7/§9. LD-163 cited. Nothing invented.
- Synthetic data only (Test Patient, MT2600000042, 192.168.1.3); enrolment code explicitly not written on sheet; no secrets.
- RLS/permissions/idempotency/rate tier/error codes: not applicable (doc task).
- Ran `node --test tests/docs/MET-T06.commissioning.test.mjs`: 40 pass, 0 fail.
