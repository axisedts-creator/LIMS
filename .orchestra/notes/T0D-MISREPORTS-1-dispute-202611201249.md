# T0D-MISREPORTS-1 dispute (writer) — TESTS_WRONG, three existing suites pin what this task must change
misreports1 is 141/141 green with the implementation in the tree. Three older tests in the verify chain contradict misreports1 and the binding lead text; the writer may not edit them.

1. apps/web/src/features/analytics/__tests__/an-t20.source.test.ts:85-91 "the word commission appears nowhere in C8 web paths" (an-t20: 136/137).
   misreports1.source.test.ts pins REPORT_CODES label = contract title ("Two level commission") and the column titles; LD-342 / A39-3 allow the word in "the web catalogue label".
   The only C8 web file with the word is apps/web/src/features/analytics/report-codes.ts (MIS_REPORTS rows two_level_commission and tds). Ask: narrow the case as LD-342 did for c8-openapi (keep the name, exempt exactly report-codes.ts, assert absence elsewhere).
   Same path must join services/api/src/modules/analytics/__tests__/ci/no-commission.allow (not a path this lane owns).
2. apps/web/src/features/billing/__tests__/nav-complete.billing.test.ts (acct1, acct2, finctrl1: 2 fails each): the manifest must equal the spec rows, so the additive entry billing.bill_of_the_day
   (route staff.billing.bill_of_the_day, permission analytics.collections.read, order 22, pinned by misreports1.source) is an "extra". Ask: add the row the way T0D-ACCT-1 / T0D-FINCTRL-1 did
   ({ name: 'Bill Of The Day', path: '/billing/bill-of-the-day', permission: 'analytics.collections.read', group: 'billing', order range after Daily cash 20 and before Credit parties 25 }).
3. rs-c8 (6 fails: hub and new schedule snapshots, static byte/route/permission pins): tester OPEN 2, already known; needs the lead ruling and a re-record of rs-c8.baseline.json and the two snapshots.
Green: misreports1 141/141, an-t17 30, an-t18 58, an-t19 357 (+1 skip), an-t24 87, uidash1 78, bl-t20 54, rs-c2 74; tsc clean for touched files.
