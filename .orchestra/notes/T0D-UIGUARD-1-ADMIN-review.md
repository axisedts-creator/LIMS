APPROVE
Reviewed `git diff 2447b8b99..HEAD` (39 files, within the 40-file limit) for T0D-UIGUARD-1-ADMIN.
- Display only: rs-c2.static is green, so the data/action files are byte-identical and the API paths, permission codes, field names and routes equal the baseline. The URL filters keep the old GET parameter names, and the server whitelists are unchanged (users `sort=display_name` was already in SORT). Gates untouched.
- Frame draws PageHeader (title, caption, actions, help). Failed reads keep the title row (FailedPage/Frame). Empty lists keep the header row (Grid `empty`). NotAvailable is used on access-review and roles/packs.
- Registry: the tester deleted the ADMIN rule 7 lines and the pinned `/admin/*` lines, and the mirror notes match. Nothing was added. features/admin/auth, platform and tokens are untouched.
- Kit change: Drawer `DrawerSection.onSave` is now optional. It is additive and named in the notes (LD-441).
- Checks run: build:nav ok; uiguard1 36/36, rs-c2 74/74, t20 192/192; tsc reports no errors in the touched files.
- Known leftovers already in the writer notes (not defects of this task): several primary Approve buttons on support access when more than one request is pending (this existed before), and no captions on the detail screens.
