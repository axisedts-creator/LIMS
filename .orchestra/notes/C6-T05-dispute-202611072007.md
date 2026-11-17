# C6-T05 dispute (writer) — test helper `src/__tests__/helpers/pdf-text.ts` cannot read Chromium 158 / Skia m158 PDFs

14/47 fail, all through `pdfText`/`pdfPages` returning raw glyph ids (e.g. `'\u0000-\u0000\u0013…'` for `J0-P1`). The PDFs are correct (verified below). Three helper defects:

1. **Nested dict cut short.** `inlineOrRef` uses `<<[\s\S]*?>>`; Skia writes `/Resources <</ProcSet [...] /ExtGState <</G3 3 0 R>> /Font <</F4 4 0 R>>>>`, so the match ends at the ExtGState `>>` and `/Font` is never found, so no ToUnicode CMap is used. Fix: balanced `<<`/`>>` scan.
2. **Every `Tj` joined with `\n`.** Skia emits one `Tj` per positioned run (`Td` at kerning pairs and per Devanagari cluster), so `norm()` gives `BODY -OK`, `ST A TIC`, `प र ी`. Fix: join runs inside one `BT…ET` block with no separator (or join by position).
3. **`/ActualText` ignored.** Skia wraps reordered/many-to-one Devanagari clusters as `/Span<</ActualText <FEFF092C093F> >> BDC … EMC` (बि); the ToUnicode of the glyphs alone gives `ब` + U+0000. AC-03.4 extraction needs the ActualText (pdftotext/pdf.js honour it). Real content stream excerpt:
   `/Span<</ActualText <FEFF09300940> >> BDC | 9.08 0 Td <0052> Tj | 6.54 0 Td <0021> Tj | EMC`

Evidence: with a corrected copy of the helper (the 3 fixes, ~25 lines; diff below) aliased in by a local vitest config, **47/47 pass** unchanged test files, typecheck clean. With the shipped helper: 33/47 pass, all 14 failures are extraction.

```diff
 function inlineOrRef(objs, text, key) {
-  const m = new RegExp(`/${key}\\s*(<<[\\s\\S]*?>>|(\\d+) 0 R)`).exec(text);
+  const m = new RegExp(`/${key}\\s*(<<|(\\d+) 0 R)`).exec(text);
   if (!m) return '';
-  return m[2] ? (objs.get(Number(m[2]))?.dict ?? '') : m[1];
+  if (m[2]) return objs.get(Number(m[2]))?.dict ?? '';
+  let depth = 0; const start = m.index + m[0].length - 2;           // balanced << >>
+  for (let i = start; i < text.length - 1; i++) {
+    if (text[i] === '<' && text[i + 1] === '<') { depth++; i++; }
+    else if (text[i] === '>' && text[i + 1] === '>') { depth--; i++; if (depth === 0) return text.slice(start, i + 1); }
+  }
+  return text.slice(start);
 }
 // pdfPages:
-    const content = refs(cont).map(...).join('\n');
+    const content = refs(cont).map(...).join('\n')
+      .replace(/\/Span\s*<<\s*\/ActualText\s*<(?:FEFF)?([0-9A-Fa-f]*)>\s*>>\s*BDC[\s\S]*?EMC/g, (_, h) => `\u0001${uni(h)}\u0001`);
+    let blk = '';
-    const tok = /…Tf|…TJ|…Tj/g;
+    const tok = /…Tf|…TJ|…Tj|\u0001([^\u0001]*)\u0001|\b(ET)\b/g;
+      if (t[4] !== undefined) blk += t[4];                              // ActualText span
+      else if (t[5] !== undefined) { lines.push(blk); blk = ''; }       // end of text block
-        lines.push(s);            /  lines.push(decode(...));
+        blk += s;                 /  blk += decode(...);
-    return lines.join('\n');
+    lines.push(blk); return lines.join('');   // ('' because a font change splits one visual line into BT blocks: "<b>X</b> परीक्षण")
```

Ask: tester applies (or equivalent, e.g. position-aware joining) to `helpers/pdf-text.ts`; no test assertion needs to change.
