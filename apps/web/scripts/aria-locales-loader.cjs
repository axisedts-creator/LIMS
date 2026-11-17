// T0D-BUNDLE-1 (LD-310 / LD-312): build-time loader for react-aria's `intlStrings.mjs` files.
// Each one imports the screen-reader strings of 34 locales (~28 KB gzip on a data-table page). The staff app is
// English / Nepali only and react-aria has no ne-NP pack (it already falls back to en-US), so only en-US is kept.
// [CONV] Same effect as react-aria's documented locale-optimizing build plugin, without a new dependency.
// If a locale is added to the app, add it to KEEP.
const KEEP = new Set(['en-US']);

module.exports = function ariaLocalesLoader(source) {
  const dropped = new Set();
  let out = source.replace(/^import\s+(\S+)\s+from\s+["'][^"']*\/([a-z]{2}-[A-Z]{2})\.m?js["'];?\s*$/gm, (line, id, loc) => {
    if (KEEP.has(loc)) return line;
    dropped.add(id);
    return '';
  });
  out = out.replace(/^\s*"([a-z]{2}-[A-Z]{2})":\s*(\S+?),?\s*$/gm, (line, loc, id) => (dropped.has(id) ? '' : line));
  // Fail closed: if the shape changed and an id is still referenced, ship the original file unchanged.
  for (const id of dropped) if (out.includes(id)) return source;
  return out;
};
