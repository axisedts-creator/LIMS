# Consumption rules

Rules say how much of which item one event uses. Kinds: per test, per analyte result, per rerun, per QC observation, per calibration, per analyser-day. Screen: /inventory/rules.

- Choose "New rule", pick kind, test, analyte, analyser (or "Any analyser"), item and quantity.
- Read the inline guidance for the kind you chose, then press Preview to see what would be deducted.
- To change a quantity choose "Change quantity". The old rule stops now. Earlier deductions are not changed.
- Rerun detection depends on the analyser driver reporting reruns. This is UNVERIFIED per analyser model (B2: exact models and manuals not received), so a rerun rule may deduct nothing on some analysers.

- How consumption is counted: see the help page consumption_model.
