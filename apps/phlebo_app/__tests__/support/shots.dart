// Test helper: real fonts + PNG capture for the screen gallery. Fonts: Poppins and Noto from lims_ui's bundled assets, and
// the Material icon font from the Flutter SDK. PNGs are written only when PHLEBO_SHOTS_DIR is set (never in CI).
import 'dart:io';
import 'dart:ui' show ImageByteFormat;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> loadTestFonts() async {
  Future<void> reg(String family, List<String> assets) async {
    final l = FontLoader(family);
    for (final a in assets) {
      l.addFont(rootBundle.load(a));
    }
    await l.load();
  }

  const dir = 'packages/lims_ui/assets/fonts';
  final poppins = [for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) '$dir/Poppins-$w.ttf'];
  await reg('Poppins', poppins);
  await reg('packages/lims_ui/Poppins', poppins);
  await reg('packages/lims_ui/Noto Sans', ['$dir/NotoSans-Regular.ttf', '$dir/NotoSans-SemiBold.ttf', '$dir/NotoSans-Bold.ttf']);
  await reg('packages/lims_ui/Noto Sans Mono', ['$dir/NotoSansMono-Regular.ttf']);
  final root = Platform.environment['FLUTTER_ROOT'];
  if (root != null) {
    final f = File('$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
    if (f.existsSync()) {
      final bytes = f.readAsBytesSync();
      final l = FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(Uint8List.fromList(bytes))));
      await l.load();
    }
  }
}

final String? shotsDir = Platform.environment['PHLEBO_SHOTS_DIR'];

/// Writes the current frame of [key]'s boundary to $PHLEBO_SHOTS_DIR/[name].png (no-op without the env var).
Future<void> shoot(WidgetTester t, GlobalKey key, String name) async {
  final dir = shotsDir;
  if (dir == null) return;
  await t.runAsync(() async {
    final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = (await image.toByteData(format: ui_png))!;
    Directory(dir).createSync(recursive: true);
    File('$dir/$name.png').writeAsBytesSync(bytes.buffer.asUint8List());
  });
}

// ignore: constant_identifier_names
const ui_png = ImageByteFormat.png;
