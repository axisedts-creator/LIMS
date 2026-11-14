# FD-T08 test dispute (writer)
Test: `__tests__/orders/orders.static.test.ts` lines 21-26, `it.each(['getOrder','listOrders'])` -> `await import(\`../../handlers/${name}.js\`)`.
Why wrong: a variable dynamic import with a `.js` suffix cannot resolve to the `.ts` sources under vite/vitest: it fails with `Unknown variable dynamic import: ../../handlers/getOrder.js` for ANY implementation (files exist, `handler` exported, wired in handlers/index.ts). The sibling suites (quote/registration static) use literal paths, which resolve.
Fix (tester): two literal imports, e.g. `import('../../handlers/getOrder.js')` / `import('../../handlers/listOrders.js')` (or `it.each` over `[name, () => import(literal)]`).
Also (env, not blocking): the first test (`order.service.ts exports ...`) times out at the default 5s on a cold import; passes with `--testTimeout=60000` (same on quote.static: first service import). Give it `{ timeout: 60_000 }` like the DB suites.

## 2. read.test.ts "filters: status (stored values), source, ..." (line 192)
`mk({ order: { source: 'home_collection' } }, 4)` seeds an order with `source='home_collection'` and no `source_ref_id`; the DB rejects the fixture itself: `new row for relation "orders" violates check constraint "orders__source_ref__ck"` (thrown in `scenario()` -> `seed`, before any handler runs). Any implementation fails here.
Fix (tester): give that order a `source_ref_id: uid()` (the constraint ties non-front_desk sources to a ref id), or use a `source` value the constraint allows without one. The `source` filter assertion (line 202) is otherwise unexercised by the suite.
