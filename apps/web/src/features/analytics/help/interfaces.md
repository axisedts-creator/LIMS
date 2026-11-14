# Instrument interfaces

## Purpose
Shows whether analysers and their agents are connected and how many messages they exchange.

## Metrics
- **Interface messages (M90)**: messages per instrument, with patient records, QC records, unmatched, quarantined and duplicates. Unmatched and quarantined messages need attention.
- **Agents by state (M91)**: Online, Offline, Backlog or Degraded, with last heartbeat, version and queue. This is a live view of now.

Instrument names come from the instrument directory; "(inactive)" marks instruments that are switched off. Where you may read agents, each agent links to its page.

## Periods and business day
Messages are counted per business day. A business day runs 00:00–24:00 Nepal time (UTC+05:45). The header shows the period in A.D. and B.S. Agent states ignore the period.

## Freshness
Agent states are live. Message counts show "Updated {time} (Nepal time)". "Data may be out of date" means changes are still being processed.

## Centre scope
You only see instruments and agents at centres you have access to. Users with access to all centres see all of them.
