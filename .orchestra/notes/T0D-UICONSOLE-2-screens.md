# T0D-UICONSOLE-2 screens
| Route | Template | Changed | Left, and why |
|---|---|---|---|
| /lab/verification | 2 CONSOLE | h1 = menu "Verify"; one FilterBar (Flagged only); tiles Pending / Flagged / Oldest wait; SplitConsole: queue per registration (Priority, Registration no, Patient, Analyte count, Flags, Waiting time), detail = patient strip + results table + audit line; sticky bar S / V / R / H; 501 = console with Not available yet; error.tsx keeps the title | Department / centre filter, waiting time (dash) and Hold (disabled): no contract field / operation, CR .orchestra/cr/T0D-UICONSOLE-2.md |
| /lab/approval | 2 CONSOLE | same console, primary "Approve N (A)", waiting time from verified_at | Hold disabled, department / centre filter: same CR |
