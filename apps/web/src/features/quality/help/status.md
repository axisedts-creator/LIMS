# QC status

## Purpose
Shows, for every instrument and analyte that has a QC plan, whether its quality control is currently trustworthy. When a pair is Out of control, patient results for it are held in Lab until released.

## Fields
- **Status**: In control, Warning, Out of control or No QC data. The violated rules follow the status, for example "Out of control · 1-3s".
- **Last in-control QC**: the last accepted run, in Nepal time (UTC+05:45).
- **Open failures**: rejected runs that still need action. Open the number to see them.
- **QC overdue**: Overdue means the planned QC interval has passed; "Patients since QC" counts the patient results released since the last QC.

## Rules
The list refreshes every 15 seconds while this tab is visible. If the connection drops, the last data stays on screen with the time it is from. Pressing Enter on a row opens its Levey-Jennings chart.

## Freshness
Figures can be up to 15 seconds old. "Updated" next to the title shows when they were read.
