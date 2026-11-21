APPROVE

Reviewed `git diff 3c4f65fbd..HEAD` (13 files, display only).

- done_when 1 (rule 2): DecisionsView and LjView use kit FilterBar (children form, LD-441 additive prop already in kit); same controls, URL params, Apply button.
- done_when 2 (rule 6): ReportView chart inside ChartCard (isEmpty + note).
- done_when 3: all QUALITY legacy entries gone from uiguard1.exceptions.ts (tester, LD-441) and from notes/T0D-UIGUARD-1-exceptions.md (writer); nothing added.
- done_when 4 (rule 7, LD-439b): `git grep "<(h[1-4]|ul|ol)[ >]"` over features/quality and app/(staff)/quality (non-test) = 0 hits.
- No route, permission, contract, API, token, kit, shell or pinned-path change. No PHI, no secrets. No rs-cN snapshot covers quality.
- Kit props used exist: Card `region`, DrawerSection without onSave (T0D-UIGUARD-1-ADMIN), ChartCard `isEmpty`/`note`, FilterBar `children`/`aria-label`.

Checks run by reviewer (apps/web, after build:nav):
- uiguard1: 36/36 pass
- quality-t21: 115 pass, 1 skip; quality-t22: 188 pass; quality-t24: 111 pass; av-t23: 136 pass

Open item for lead (not a blocking defect against done_when 1-5): the writer notes say the fuller mock pass from LD-439(a) was not done (Tabs with counts, DataTable total and pager, StatTile row on ReportView). The guard-level rules are met. If LD-439(a) needs a full mock match on all 8 quality screens before close, open a follow-up task.
Minor display note: when ReportView has no denials, the empty BarChart renders together with the ChartCard "No data yet" line and the note. This is the kit's isEmpty behaviour and does not block.
