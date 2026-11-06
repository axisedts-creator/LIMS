# LIMS — rules for every agent session
- The spec lives in `spec/` (read-only). Precedence: spec/program/00-README.md > spec/research/04-consolidated-decisions.md > spec/program/08-CR-REGISTER.md (newest addendum wins) > spec/program/03-INTERFACE-CATALOG.md > spec/program/01-CHUNK-MAP.md, 02-CONVENTIONS.md > chunk docs.
- Read ONLY what your task needs: the task brief, the plan row, and the sections it cites. Use grep to find sections; never read whole 50k-word files.
- Names (tables, routes, events, permissions, error codes) are copied verbatim from the spec. Never invent a name, version, vendor API or regulation. If something is missing: stop and write `.orchestra/cr/<task>.md` using the CR template in spec/program/04-CHANGE-REQUESTS.md.
- Edit only paths your chunk owns (spec/program/01-CHUNK-MAP.md §3). Never edit `spec/` or `.orchestra/` except the notes/cr files your role names.
- Synthetic data only. Never use real patient names or data. No secrets in files.
- Keep replies short: final message = 3–6 lines (what changed, what's left). No essays.
