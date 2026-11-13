# HC-T04 dispute (non-blocking)
`services/api/src/modules/homecollection/__tests__/boot.test.ts:39` has `const IMPLEMENTED: readonly string[] = [];` (HC-T01 test). The two stub tests ("in dev every stub answers 501", "staging/production a stub ... common.internal") iterate every op not in that list, so they now fail for the three ops HC-T04 implements.
Need (tester role): set `IMPLEMENTED = ['getHomecollectionSettings', 'updateHomecollectionSettings', 'listHomecollectionReasons']`. The writer may not edit test files.
Also seen: "boots and mounts every homecollection operation (26 of 26)" timed out at 30 s here (not analysed; may be environmental).
