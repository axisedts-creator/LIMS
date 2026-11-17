# T0D-TESTMGMT-1 item (1): ElabAssist screen -> LIMS screen that exists today, and what is missing
Source: C:/LIMS-state/elabassist-testmgmt-20261117.md (read only walk) and the code at HEAD 4afe47aea. API fields exist since T0C-TESTMGMT-1; handlers since T0B-TESTMGMT-1.
| ElabAssist | LIMS today | Missing (this task builds, route stays) |
| Test Details (tests + parameters) | /catalog/tests list (CATTESTS-1) and /catalog/tests/{id} tabs General, Analytes, Ranges, Critical | two pane screen ?view=details, reorder, Add space, Remove, Add existing |
| Add / Edit Test | New test dialog (5 fields) and TestGeneralForm (6 fields) | all 24+7 fields in 4 sections, Copy test, live preview, suggestions |
| Add / Edit Test Parameter | AnalyteEditor (code, name, print name, sub heading, 5 result types, unit, decimals, method, value set, formula) | 8 more result types, default value, high low, long text, flags, trend name, font, display type, live formula check with usable parameters |
| Reference Range Manage | RangesTab (9 columns, version strip, publish dialog) | 16 columns, third gender, age unit hour, lab, instrument, default, auto approved, critical in the same grid, preview, publish only for the permission |
| Test Category | none | ?view=categories (list, New category, deactivate) |
| Test Group | /catalog/specimens (specimen types) | none: kept as is (already the group) |
| Test Profile | /catalog/panels and /{id} (MembersEditor with one picker) | two list picker (Add, Add all, Remove, Remove all) |
| Test Unit | /catalog/units (CATUNITS-1) | none |
| Notes | /catalog/comment-codes | Type, Default template, Text format |
| Popular Test | none | ?view=popular |
| Complete Test List | /catalog/tests table (CATTESTS-1) | Short name, Category, Price columns |
| Rate Master, Test Rate Card | /catalog/price-lists (+ simulator, surcharges, tax) | out of scope: LD-318 follow-up (2), rate card equations wait for the founder |
