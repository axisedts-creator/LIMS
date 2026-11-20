# T0D-SALES-1 walk (writer): LIMS partner and home collection screens vs the ElabAssist sales screens

Source: the ElabAssist list in the task brief (C:/LIMS-state/elabassist-sales-20261117.md, as quoted in the inbox; the file itself is outside this lane's read scope) and the LIMS page files under apps/web/src/app/(staff)/partners and /homecollection on lane/C0-0L. Code walk, not a live click-through.

| LIMS screen (route) | ElabAssist screen it replaces | What is missing after this task |
|---|---|---|
| /partners (Partners list) and /partners/[partner_id] | Affiliation master (collection centre / partner lab) | per party commercial settings, onboarding approval queue (T0D-PARTYSET-1) |
| /partners/referrers | doctor / referrer master (referral side) | doctor master fields, masked PAN / national id (T0D-PARTYSET-1) |
| /partners/pickups, /partners/manifests | partner sample pickup | none for sales |
| /partners/settings | per client settings (partly) | per party settings with runtime effects (T0D-PARTYSET-1) |
| NEW /partners/sales/designations | Sales Designation (levels 1 to 8) | nothing; levels unique per tenant are enforced by the server |
| NEW /partners/sales/representatives | Sales Representative (designation, manager) + its manager tree | deactivate-with-reassign in one step is not in the contract; the tree reads one page of 200 nodes |
| NEW /partners/sales/clients | Sales Client List (party, outstanding, last bill, representative) | a tenant-wide client list op (the screen fans out one call per representative); RepresentativeClient has no assignment version (If-Match sent as "1"); both raised for a CR |
| NEW /partners/sales/areas | Services In Area | Activate for an inactive area (no contract op); areas are free text district and area, not pincodes (LD-321) |
| /homecollection/devices (Phlebotomy phones) + NEW row action "Collector settings" | Collection Boy: Allow Collection and Allow Pickup | there is no collector form and no read op for the stored flags, so the dialog starts from the API default (both on) and sends only the changed boxes |
| /homecollection/dispatch, /visits, /handovers, /settings | home collection dispatch and route screens | unchanged by this task |

Still missing in LIMS (not in this task): franchise approval queue and per client commercial settings (T0D-PARTYSET-1), collection centre scheme (catalogue / price list side), sales representative and collection boy reports (T0D-MISREPORTS-1), offline queueing of sales writes (LD-319 offline wave; all sales writes are online only today).
