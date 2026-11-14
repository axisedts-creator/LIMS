# Unassigned QC

## Purpose
QC values that arrived from an instrument but could not be assigned to a QC run, with the reason and the fix.

## Fields
- **Control id, Lot, Level**: exactly as the instrument sent them.
- **Status**: for example Unmapped control (add a control map), No plan (create a QC plan), No target (add a target), Not mapped in catalog (map the instrument code in Instruments › Code maps).

## Rules
Fix buttons need the manage permission and open the set-up form already filled with the instrument and the raw id. Once fixed, the value is assigned automatically and leaves this list.
