# T0D-UIKIT-2 dispute (writer, after LD-438) — 3 tests contradict pinned tests; everything else is implemented and green

1. uikit2.kit.test.tsx:88-95 "completed stages carry a check" wants path d="M5 12l5 5L20 7" in each done li.
   ui-r03-kit-pass.test.tsx:656 snapshot (ui-r03-kit-pass.test.tsx.snap:19) pins the done li to exactly one svg with the `success` path
   "M12 3a9 9 0 100 18 9 9 0 000-18zM8 12l3 3 5-6", and ui-r03:304 says one svg per li. ui-r03 may not be edited (LD-438 TESTER 1).
   Ask: accept the success icon (circle + check, already a check mark) as "a check", i.e. match /l3 3 5-6|L20 7/, OR allow the ui-r03 snapshot to be updated.
2. ui-r03-kit-pass snapshot "DataTable: compact, sticky, sorted, empty" (.snap) pins the EmptyState inside DataTable to the 32px `empty` Icon.
   done_when 4 + uikit2.kit.test.tsx:149-181 require EmptyState to draw svg.lims-state-art instead. Both cannot hold. Ask: allow the snapshot update (only that svg changes).
3. apps/web/.../uikit2.shell.test.ts:67 `expect(last('box-shadow')).not.toMatch(/\d/)` contradicts line 44 of the same file, which requires
   'var(--lims-elevation-1) !important' (contains the digit 1). Ask: change line 67 to reject a literal shadow only, e.g. not.toMatch(/\d+px|rgba?\(/).
Implementation for all three already matches the side the brief asks for (state art, success icon kept, elevation-1); no further code change needed once ruled.
