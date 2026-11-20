Title: CR-C1-ADMINPAGE-LAB-1: no department-list operation readable with lab.worklist.read, so three lab roles get permission-denied on /lab/worklists
From chunk: C1            To owner: founder / 11-ROLE-MATRIX owner (option a) | C0-0C contracts/openapi/lab.yaml + C5 (option b)
Type: api (or role-matrix data)
Blocking? no for ADMINPAGE-LAB-1 delivery (page ships; administrator and the other lab roles hold both permissions); yes for "lab staff reach /lab/worklists from the menu" for the three roles below.
Problem: C5 04-UI-UX section 1 gates /lab/worklists on `lab.worklist.read` and asks it to list the departments the user may work in. contracts/openapi/lab.yaml has no department-list operation, so the page uses C3 `listDepartments` (GET /v1/catalog/departments, contracts/openapi/catalog.yaml:316, `x-permission: catalog.test.read`). In services/api/src/modules/identity/role-packs/role-packs.data.yaml the roles `corp_laboratory_user`, `std_consulting_pathologist` and `std_account` hold `lab.worklist.read` but NOT `catalog.test.read`: they see the "Worklists" nav entry and the page shows the permission-denied state (API 403). The brief forbids a permission or registry change, so the writer cannot fix it.
Proposed change (exact): one of
 (a) add `catalog.test.read` to `corp_laboratory_user`, `std_consulting_pathologist` and `std_account` in spec/program/11-ROLE-MATRIX.data.yaml and the pack data (read-only catalog permission, no PHI); OR
 (b) additive lab-side operation, e.g. GET /v1/lab/departments (`x-permission: lab.worklist.read`, `x-context: tenant`, `x-idempotency: none`) returning the departments the caller may work in (also closes the spec gap "departments the user may work in"); the page then switches to it.
Backward compatible? yes — (a) adds a holding; (b) adds a new endpoint.
Tenant/security impact: (a) widens catalog read to three roles (catalog data only, no PHI, tenant RLS unchanged); (b) new tenant-scoped read surface under existing RLS, no PHI.
IRD/regulatory impact: none.
Alternatives considered: gate the page on `catalog.test.read` too (rejected: deviates from the C5 section 1 permission and hides the page from these lab roles); hide the nav entry for those roles (rejected: same outcome, no reach).
Tests that will prove it: role-pack test that each of the three roles can read departments; ADMINPAGE-LAB-1 worklists component test renders the department list (not permission-denied) for a user holding only the role's permissions.
