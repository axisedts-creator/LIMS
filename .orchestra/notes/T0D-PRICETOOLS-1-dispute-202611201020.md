# T0D-PRICETOOLS-1 dispute (debugger)
Failing verify test: `catalog/__tests__/emptytbl2.other.test.tsx` "quality LjView (chart with no values)" line 145 expects text /Chart component pending/.
Contradicts: LD-353 rule 8 ("no development notes"); `quality/__tests__/uidash1.quality.test.tsx:7` and `quality-t21.lj.test.tsx:145,151` assert the text is absent. LjView no longer renders it (T0D-UIDASH-1), not this task.
Not caused by T0D-PRICETOOLS-1: no price list/catalog price file touched. Same class as the other pre-existing fails (emptytbl1/2, web-t33 createDoctor, rs-c3 baseline) in impl note. Needs arbiter for T0D-EMPTYTBL-2 test.
