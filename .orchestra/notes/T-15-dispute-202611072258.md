# T-15 dispute — one test case is unsatisfiable by a literal match
Test: `integration/referrers.service.test.ts:576` (REQ-SEC-082 `it.each`), case `['r_s', []]`, fixture `ESC()` line 573: doctor AB3 `display_name: 'Under_score Man'`.
Why wrong: name_normalised = `under_score man`, which literally contains `r_s` (unde-**r_s**-core). The test's own premise is "q is matched literally", and the neighbouring case `['er_s', ['AB3']]` relies on exactly that substring. A literal match of `r_s` must return AB3 (an unescaped `_` would additionally match AB4 `Underxscore`, which is what the case means to rule out).
Expected by the spec rule (02-TRD #60, name contains normalised q): `['AB3']`. The test says `[]`.
Evidence: with the implementation, 266/267 pass; this is the only failure (`expected [ 'AB3' ] to deeply equal []`).
Suggested fix (tester): `['r_s', ['AB3']]`, or use a probe that is in no name, e.g. `['x_s', []]` (unescaped `_` would match `Underxscore`/`xs`).
Writer did NOT touch the test and did NOT bend the search to hide AB3.
