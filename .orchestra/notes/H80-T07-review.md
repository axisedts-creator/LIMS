CHANGES

1. docs/manual/instruments/truth-h80e-commissioning.md:42 — "If the installer asks for a listener, pass `--allow-lan-listener`" makes the flag optional and invents an installer prompt. 02-TRD §5.12 (line 455) / addendum §7: without the flag no inbound firewall rule is created and a `tcp_server` instrument reports `link_state = error`, so the analyser can never connect. Exact fix: replace the sentence with "Run the installer with `--allow-lan-listener`. Without this flag the installer opens no inbound firewall rule, and the instrument shows `link_state = error`."

Non-blocking notes (no change required for approval):
- Line 13 "Host query does nothing before that." sits next to step 5, which asks to confirm `QCK OK` + `DSR` in shadow. This mirrors a tension in the spec itself (addendum §8 "inert while status ≠ verified" vs §9 item 5 "host query in shadow"); a lead clarification is better than a doc guess.
- Step 3.4 places `manual_reference_confirmed` (writer's own placement; §9 names the flag but not the step). Reasonable, not invented content.

Checked: nine steps in §9 order; every U item (§1 LIS labels, MSH-16, OBR-15, OBX-13/14, OBX-8, QC level letters, chromatogram size, sender names/CR-C7-017, reply timeout, ACK policy, MSA-2, NF x2, Devanagari, offline) has a `____` blank; vendor engineer vs lab staff split (static IP = engineer root account, LIS address with lab staff); names verbatim (`tcp_server`, flags, `c7-driver-registry-check`, `instruments.instrument.manage`, aal2, `name_script`/`latin_if_available`); no DSR test list (LD-139); synthetic data only; no secrets; only owned paths + notes/tests. RLS/rate tier/error codes: N/A (docs-only).
Ran: `node --test tests/docs/H80-T07.commissioning.test.mjs` = 35 pass, 0 fail.
