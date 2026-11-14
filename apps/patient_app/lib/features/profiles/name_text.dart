// A9 full name: trimmed and put in Unicode NFC (04-UI-UX A9 "LimsTextField (NFC)"), so "e" + combining acute and the single letter "é" are the same name.
// ponytail: the app has no normaliser package (exact pins only), so this composes the common Latin letter + mark pairs (Latin-1 and Latin Extended-A);
// every other script passes through as typed. Replace with a vetted NFC package once one is pinned (T-L6-impl.md open point).
const _marks = <int, (String, String)>{
  0x0300: ('AEIOUaeiou', 'ÀÈÌÒÙàèìòù'),
  0x0301: ('AEIOUYaeiouyCcLlNnRrSsZz', 'ÁÉÍÓÚÝáéíóúýĆćĹĺŃńŔŕŚśŹź'),
  0x0302: ('AEIOUaeiouCcGgHhJjSsWwYy', 'ÂÊÎÔÛâêîôûĈĉĜĝĤĥĴĵŜŝŴŵŶŷ'),
  0x0303: ('ANOIUanoiu', 'ÃÑÕĨŨãñõĩũ'),
  0x0304: ('AEIOUaeiou', 'ĀĒĪŌŪāēīōū'),
  0x0308: ('AEIOUYaeiouy', 'ÄËÏÖÜŸäëïöüÿ'),
  0x030A: ('AaUu', 'ÅåŮů'),
  0x030C: ('CDENRSTZcdenrstz', 'ČĎĚŇŘŠŤŽčďěňřšťž'),
  0x0327: ('CSTGKLNRcstgklnr', 'ÇŞŢĢĶĻŅŖçşţģķļņŗ'),
};

String normaliseName(String raw) {
  final out = <int>[];
  for (final r in raw.trim().runes) {
    final pair = _marks[r];
    if (pair != null && out.isNotEmpty) {
      final i = pair.$1.runes.toList().indexOf(out.last);
      if (i >= 0) {
        out[out.length - 1] = pair.$2.runes.elementAt(i);
        continue;
      }
    }
    out.add(r);
  }
  return String.fromCharCodes(out);
}
