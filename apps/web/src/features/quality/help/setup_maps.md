# QC set-up: Maps

## Purpose
A map tells the system which of your lots an analyser means when it sends a control id.

## Fields
- **Control id**: exactly as the analyser sends it, for example QC-L2.
- **Lot as sent**: leave empty to match any lot of that control id.
- **Lot**: the material, level and lot the values belong to.

## Rules
If the instrument list cannot be read, type the instrument ID instead. Deactivating a map stops new values from being assigned through it.
