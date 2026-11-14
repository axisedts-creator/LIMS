# RS-C15 debug (debugger round 1)
- Cause 1: snapshot file missing -> 8 snapshot fails. Fix: recorded with -u rs-c15.screens (LD-170); static+screens now 16/16 under CI=true.
- Cause 2: remaining 6 behaviour fails are test defects (FilterBar options counted as status chips; toBeChecked without jest-dom; Tab expected into grid cells). No impl change. See RS-C15-dispute.md.
