# Instruments — user guide

Screens under **Instruments** in the staff menu. What you see depends on your permissions; buttons you cannot use are hidden or read-only. Site installation of the PC software is in `site-installation.md`.

| Page | Route | Needs |
|---|---|---|
| Agents | `/instruments/agents` | `instruments.agent.read` (manage: `instruments.agent.manage`) |
| Instruments | `/instruments/instruments` | `instruments.instrument.read` (manage: `instruments.instrument.manage`) |
| Messages | `/instruments/messages` | `instruments.message.read` (reprocess/re-match: `instruments.message.rematch`) |
| Settings | `/instruments/settings` | `instruments.instrument.read` (edit: `instruments.instrument.manage`) |

## How it fits together

An **agent** is software on a lab PC. Each **instrument** (analyser) is attached to one agent. The agent receives analyser messages, keeps them safely, and uploads them. The LIMS archives each message, reads the results, and sends them to the laboratory module.

## Agents

List columns: Agent code, Name, Centre, Health, Last heartbeat, Version, Queue, Clock offset, Status. The list refreshes every 30 seconds.

**Health**
- Online — talking to the server normally.
- Backlog — queue is above the threshold.
- Instrument silent — a live instrument sent nothing within its silence window.
- Offline — no heartbeat for over three minutes.

**Status**: pending_enrolment, active, revoked, retired.

**Create an agent**: "New agent" (`Alt+A`). Agent code is 2–32 characters, A–Z, 0–9 and `-`. Choose the centre. Then open the agent and issue an enrolment code.

**Issue enrolment code** (`Alt+E` on the agent page): confirm, then copy the code from the window. It is shown **once**, works for one PC and expires in 24 hours; earlier unused codes stop working. You cannot close the window until you tick "I have copied this code". If the agent still has messages waiting, a warning tells you that enrolling another PC stops the old one from uploading them.

**Other actions** (manage only): Request command (Upload logs, Refresh configuration, Restart service, Re-upload since…), Revoke, Retire, Edit.
- **Revoke**: the PC stops uploading at once. Messages already on the PC stay there until it is re-enrolled; results are not lost. The status shows "Not authorised — re-enrol".
- **Retire**: only when all its instruments are retired. Cannot be undone.

Tabs: Overview, Instruments, Health history, Credentials, Commands & logs. Banners warn about a rejected configuration, a failed update, a clock offset above the warning level, or a network address change in the last 24 hours ("If you didn't move the PC, revoke it").

## Instruments

List columns include Driver (Generic / Verified / Sketch — not for live use), State, Link state, Last message and **Unmapped codes** (links to Mappings).

**State**: Draft → Commissioning (no results sent) → Live → Suspended (no results sent) → Retired. Retire is possible from any state.

**Add an instrument**: "New instrument" (`Alt+I`). Sections: Identity, Connection, Driver, Advanced link settings, Capabilities, Monitoring. Code is 2–32 characters (A–Z, 0–9, `-`) and cannot be changed later; the agent cannot be changed later either. Use the values from the instrument's interface manual. "Worklist download" is not available yet. Saving shows "Saved. The agent picks this up within a minute." Someone else editing at the same time gives a conflict message; reload and retry.

**Start commissioning**: the agent opens the connection. Messages arrive with outcome **Shadow**: stored and visible, not sent to the laboratory.

**Go live**: tick all four checks and write an evidence note (at least 10 characters):
1. The official interface manual for this model and software version is on file.
2. Patient-sample comparison with the instrument printout is done.
3. QC values compared.
4. Code mappings reviewed.

The instrument cannot go live if its driver is not verified. You may be asked to confirm with your authenticator.

**Suspend** (reason 3–300 characters): results stop going to the laboratory, new messages are kept as Shadow. **Resume** returns to Live. **Retire**: also deactivate the instrument's code mappings.

## Mappings

Open from an instrument (`Alt+P`). The left panel lists **observed codes**: codes the instrument has sent, with class (Patient / QC / Calibrator), count and Mapped/Unmapped. The right panel lists mappings (direction, instrument code, test, analyte, unit conversion, flag map, active).

You need `catalog.instrument_code_map.manage` to add, edit, deactivate or copy mappings. Without it you see "Mappings are visible to users who can manage them." and the observed codes stay read-only. Saving may ask for authenticator confirmation. A duplicate gives "This code is already mapped for this instrument."

On a live instrument, an unmapped code is reported to the laboratory as an exception. Once you map it, the laboratory re-applies it.

## Messages

Default view: last 24 hours; the range is at most 31 days. Filters: Instrument, Agent, Centre, Kind (data, host query, attachment, incomplete), Has QC records, Latest outcome, Has unmapped.

**Find by barcode**: press `/`, scan or type the barcode, press Enter. The barcode is sent in the request body, never in the address bar. Clear returns to the list.

**Outcome**: Parsed, Shadow, Quarantined (message could not be read; raw kept), Rejected (capability not enabled). The **Rejected uploads** tab lists uploads refused by the server, with reason code.

### Message detail
Shows instrument, agent, protocol, times, size, warnings, a timeline of runs, and the records (class, barcode, code, value, unit, flags, mapping, emit status, event id).

- **Show raw** (`Alt+R`): opens the original message. Viewing is recorded in the audit log. Copy is disabled and the panel clears when closed.
- **Reprocess** (`Alt+P`, needs `instruments.message.rematch`): parses the original again with the current driver and sends it to the laboratory. Pick a reason. Results already applied are not duplicated; approved results are never changed. Outcomes: Applied, Already received, Not matched (see lab exceptions), Locked (approved — amend in Lab), On QC hold.
- **Re-match…** (on a record): fix a wrong barcode. The original is shown; enter the new barcode (it must differ), a reason, and an optional note.
- **Attachment** (file-drop picture/PDF): the Open button works only when the file is clean. A file that did not pass scanning is not available.
- Parsed rows older than 90 days are not kept. A banner offers "Show a preview parse" of the original message; nothing is stored.

## Settings

Default backlog threshold, backlog oldest-pending seconds, clock warning seconds, agent local retention hours, and an optional update window (HH:MM). Read-only without `instruments.instrument.manage`. If someone else saved first: "Someone else changed these settings. Reload to see them."

Raw analyser messages are kept for the period set in the lab's retention settings (Administration), at least one year. Legal retention is not yet confirmed.

## Common questions

- **Why does Commissioning show messages but no results in Lab?** By design: Shadow messages are not sent.
- **An instrument shows "Instrument silent".** Check the analyser is on and set to send, the cable or network, and the agent's Instruments tab for the last error code.
- **The agent shows Offline.** Follow the alert table in `site-installation.md`, section 6. Results wait on the PC and upload when it reconnects.
- **I lost the enrolment code.** Issue a new one. The old one stops working.
