// Formula dependency graph (02-TRD §7.2 steps 1–5): cycle path, chain depth and dependency order. Pure; iterative (a deep chain cannot overflow the stack, AB-17)
// and memoised by the DFS colours (a ladder with 2^40 paths is 80 nodes). Codes are plain Map keys, never object properties.
export type GraphResult =
  | { readonly cycle: readonly string[] }
  | { readonly cycle?: undefined; readonly chainDepth: number; readonly dependencyOrder: readonly string[] };

/**
 * `edges`: input codes of the OTHER formula analytes (published + scheduled); the entry of `root` is replaced by `rootInputs` (its candidate).
 * Cycle: path `root -> … -> X -> … -> X` found from the root (first === last). Otherwise `chainDepth` = formula analytes on the longest path incl. the root
 * (leaves, i.e. codes without an entry, count 0) and `dependencyOrder` = every reachable code, inputs before the analytes that read them, root last.
 */
export function analyzeFormulaGraph(input: {
  root: string; rootInputs: readonly string[]; edges: ReadonlyMap<string, readonly string[]>;
}): GraphResult {
  const { root } = input;
  const rootInputs = [...new Set(input.rootInputs)];
  const inputsOf = (code: string): readonly string[] | undefined => (code === root ? rootInputs : input.edges.get(code));

  const GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  const depth = new Map<string, number>();
  const order: string[] = [];
  const path: string[] = [];                                       // the grey nodes, in DFS order
  const stack: Array<{ code: string; kids: readonly string[]; next: number }> = [];

  const enter = (code: string) => {
    colour.set(code, GREY); path.push(code);
    stack.push({ code, kids: inputsOf(code) ?? [], next: 0 });
  };
  enter(root);
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (top.next < top.kids.length) {
      const kid = top.kids[top.next++]!;
      const c = colour.get(kid);
      if (c === GREY) return { cycle: [...path.slice(path.indexOf(kid)), kid] };
      if (c === undefined) enter(kid);
      continue;
    }
    // post-order: every input is already done
    const formula = inputsOf(top.code) !== undefined;
    let longest = 0;
    for (const k of top.kids) longest = Math.max(longest, depth.get(k)!);
    depth.set(top.code, formula ? 1 + longest : 0);
    colour.set(top.code, BLACK); order.push(top.code);
    path.pop(); stack.pop();
  }
  return { chainDepth: depth.get(root)!, dependencyOrder: order };
}
