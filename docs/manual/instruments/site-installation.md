# Instrument bridge agent — site installation and runbook

For the LIMS provider's installer and the lab's IT contact. Day-to-day monitoring is done by the lab manager on the Agents page (`/instruments/agents`). See `user-guide.md` for the screens.

The bridge agent is a Windows service (`LimsBridgeAgent`) on one lab PC. It talks to analysers over serial or the lab network, keeps every message on the PC first, then uploads it to the LIMS over outbound HTTPS only. It opens no port to the internet.

## 1. Before you start

### 1.1 Lab PC baseline (REQ-SEC-122)
- A supported Windows version with current updates.
- Antivirus installed and running.
- No unattended remote-access tools (for example TeamViewer or AnyDesk left running without someone present).
- A separate Windows account for the installer. Do not share the Administrator login with reception or lab staff.
- BitLocker enabled where the PC supports it.
- At least 500 MB free on the disk that holds the agent's queue. Below that the agent refuses new instrument messages (`disk_low`) so the analyser keeps them.
- The PC's date and time are correct. A wrong clock breaks the secure connection (`tls_verify_failed`).

### 1.2 Network checklist (REQ-SEC-120)
- Analysers and the agent PC sit on an isolated switch or VLAN. Not guest Wi-Fi.
- Serial (COM port) is preferred over network where the analyser offers both.
- The PC can reach the LIMS server on TCP 443 (through the lab proxy if one is used; pass `--proxy` at install).
- Analysers that connect to the agent (`tcp_server`) need a fixed IP and the firewall rule in section 4.

### 1.3 What the lab manager prepares in the LIMS
1. Create the agent (Agents page, "New agent").
2. Issue an enrolment code (agent detail, "Issue enrolment code"). The code is shown once, works for one PC and expires in 24 hours. Hand it to the installer outside the LIMS (typed or pasted on the PC). Do not email it in clear text or keep it in a shared note.

### 1.4 Per-instrument settings sheet
Fill one sheet per analyser from the vendor's LIS/host interface manual. Do not guess; the LIMS only lets an instrument go live when its driver is verified against an official manual.

| Item | Value |
|---|---|
| Instrument code, name, vendor, model, serial no | |
| Instrument software version (About screen) | |
| Protocol (ASTM / HL7 v2 / folder only) | |
| Serial: COM port, baud, data bits, parity, stop bits | |
| Network: host or listen address, port, allowed instrument addresses | |
| Time zone the instrument clock uses | |
| QC sample id patterns | |
| Host query supported by the manual? (yes/no) | |
| Picture/PDF export folder, file name pattern, barcode pattern | |
| Manual reference (title, version) | |

## 2. Install

Open an elevated Command Prompt (Run as administrator) and run:

```
bridge-agent install --server https://<LIMS server address> --enrolment-code <code>
```

Add `--proxy <url>` if the lab uses a proxy. The command refuses a non-https server address. It prints six steps and waits up to two minutes. Success looks like:

```
[4/6] Enrolling with https://… ...  OK  agent <AGENT CODE>
[6/6] First heartbeat ...  OK
Installed. Check "bridge-agent status" or the Agents page.
```

Then confirm:
1. `bridge-agent status` shows Service RUNNING, Auth OK, Server reachable.
2. On the Agents page the agent shows **Online** within about a minute.

If enrolment fails with "Enrolment code invalid or expired", ask the lab manager for a new code.

## 3. Commission each instrument

Do this per instrument, with the lab manager.

1. Lab manager creates the instrument (Instruments page, "New instrument") from your settings sheet, then selects **Start commissioning**. The agent opens the port within about a minute.
2. Check `bridge-agent instruments`: the link state should be `up`.
3. Send test and QC samples. Messages appear on the Messages page with outcome **Shadow**. In commissioning, messages are stored and shown but are not sent to the laboratory.
4. Review the codes on the Mappings page and map each one.
5. Go-live checklist (all four are required, plus an evidence note of at least 10 characters):
   - The official interface manual for this model and software version is on file.
   - Patient-sample comparison with the instrument printout is done.
   - QC values compared.
   - Code mappings reviewed.
6. Lab manager selects **Go live** and confirms with the authenticator if asked. From the next message, results go to the laboratory.

If the driver shows "Sketch — not for live use" or is not verified, the instrument cannot go live. Contact the LIMS provider.

## 4. Firewall (network-listening instruments only)

If an instrument connects to the agent (`tcp_server`), run on the PC:

```
bridge-agent firewall enable
```

This adds an inbound rule for the agent program only. `bridge-agent firewall disable` removes it. The agent accepts connections only from the instrument addresses listed in the instrument's configuration.

## 5. Command reference

All commands need an elevated prompt except `version`. Exit codes: 0 success, 1 usage error, 2 operation failed, 3 not elevated. Add `--json` for machine-readable output.

| Command | Use |
|---|---|
| `bridge-agent status` | Service, auth, last heartbeat, queue counts, disk, instruments |
| `bridge-agent instruments` | Link state per instrument |
| `bridge-agent queue` | Counts by state, oldest pending, rejected items with error codes |
| `bridge-agent test-connection` | DNS, TCP 443, TLS, server time, auth; says which step failed |
| `bridge-agent flush` | Upload now |
| `bridge-agent diagnostics --out <file.zip>` | Status, redacted config, 7 days of logs. Never contains queue payloads, token or code |
| `bridge-agent enrol --enrolment-code <code>` | Re-enrol (new code) |
| `bridge-agent firewall enable\|disable` | Section 4 |
| `bridge-agent uninstall [--purge]` | Remove the service. `--purge` is refused while pending or rejected items exist unless you type `--force-discard-pending` |
| `bridge-agent version` | Agent, launcher, build, config version |

The CLI never prints barcodes, values, patient names or file names.

## 6. When an alert fires

Health states on the Agents page: **Online**, **Backlog**, **Instrument silent**, **Offline**.

| Symptom | Likely cause | Do this |
|---|---|---|
| **Offline** | PC off, service stopped, no network, or credentials revoked | Check the PC is on. `bridge-agent status`. `bridge-agent test-connection` and read which step failed. Offline does not lose results: the agent keeps acknowledging instruments and uploads when it reconnects |
| **Backlog** | Messages waiting longer or in larger number than the thresholds | `bridge-agent queue`; `bridge-agent flush`. Check the connection. Thresholds are in Settings |
| **Instrument silent** | No message inside the instrument's silence window (inside its active hours) | Check cable or network, instrument is on and set to send, `bridge-agent instruments` for the last error |
| `auth_rejected` / "Not authorised — re-enrol" | Agent was revoked or its token was replaced | Lab manager issues a new code; run `bridge-agent enrol --enrolment-code <code>`. Messages kept on the PC upload afterwards |
| `tls_verify_failed` | Wrong PC date/time, proxy interfering, certificate problem | Fix date/time and proxy. Do not bypass the check |
| `disk_low` | Under 500 MB free | Free disk space now. The analyser keeps results meanwhile |
| `firewall_rule_missing` | Network-listening instrument, rule is off | `bridge-agent firewall enable` |
| `config_rejected` | A configuration failed its signature check and was not applied | Contact LIMS provider support. Do not edit files on the PC |
| Banner "network address changed recently" | PC moved, or the token is in use elsewhere | If nobody moved the PC, the lab manager revokes the agent |

If the cause is unclear, run `bridge-agent diagnostics --out <file.zip>` and send the zip to LIMS provider support. The lab manager can also request "Upload logs" from the agent detail page.

## 7. Replace the PC

1. Lab manager opens the old agent and checks the queue. If it still holds messages, get the old PC online first so they upload. Re-enrolling another PC stops the old PC from uploading them.
2. Lab manager issues a new enrolment code for the **same agent**.
3. Install on the new PC (section 2) with the new code. The old PC's token is revoked automatically.
4. Check `bridge-agent status` on the new PC and the Agents page.
5. Uninstall the agent from the old PC (`bridge-agent uninstall`).

An instrument cannot be moved to a different agent. To do that, retire it and create a new one on the target agent, then copy its mappings ("Copy from instrument…").

## 8. Retire an agent

Retire every instrument on it first, then **Retire** on the agent detail page. Retired agents cannot be re-enrolled.
