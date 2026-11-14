// T0D-15 test helpers. ASSUMED public API (spec names widgets/props only; see .orchestra/notes/T0D-15-tests.md):
//   import 'package:lims_ui/lims_ui.dart'  -> LimsTheme, LimsTokens (re-export of src/tokens.g.dart), all Lims* widgets.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

/// Pump root for widgets: Material app using LimsTheme.light(); optional text scale.
Widget host(Widget child, {double textScale = 1.0}) => MaterialApp(
      theme: LimsTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(textScale), size: const Size(360, 800)),
        child: Scaffold(body: SingleChildScrollView(child: child)),
      ),
    );

/// Package root regardless of cwd.
Directory pkgDir() {
  var d = Directory.current;
  for (var i = 0; i < 4; i++) {
    final f = File('${d.path}/pubspec.yaml');
    if (f.existsSync() && RegExp(r'^name:\s*lims_ui\s*$', multiLine: true).hasMatch(f.readAsStringSync())) return d;
    d = d.parent;
  }
  return Directory('${Directory.current.path}/packages/ui-flutter');
}

Directory repoRoot() => pkgDir().parent.parent;

Map<String, dynamic> tokensJson() =>
    jsonDecode(File('${repoRoot().path}/packages/ui/tokens/tokens.json').readAsStringSync()) as Map<String, dynamic>;

/// Colour from "#RRGGBB".
Color hex(String s) => Color(0xFF000000 | int.parse(s.substring(1), radix: 16));

/// Status table parsed from the web StatusChip (04 §1.3 mapping, the component AC-0D-9.2 names).
/// Returns kind -> status -> (tone, label).
Map<String, Map<String, (String, String)>> webStatusMap() {
  final src = File('${repoRoot().path}/packages/ui/src/components/StatusChip/StatusChip.tsx').readAsStringSync();
  final out = <String, Map<String, (String, String)>>{};
  String? kind;
  for (final line in src.split('\n')) {
    final k = RegExp(r'^  (\w+): \{\s*$').firstMatch(line);
    if (k != null) {
      kind = k.group(1);
      out[kind!] = {};
      continue;
    }
    final r = RegExp(r"^    (\w+): \['(\w+)', '([^']+)'\]").firstMatch(line);
    if (r != null && kind != null) out[kind]![r.group(1)!] = (r.group(2)!, r.group(3)!);
  }
  return out;
}
