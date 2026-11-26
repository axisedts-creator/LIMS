// PHLEBO-UI-FULL-1 preview entry point: the real app against a pretend centre, for trying the screens on a phone.
//   flutter run --flavor dev -t lib/main_preview.dart
// Debug builds only. Every launch starts clean: new temporary databases, keys held in memory. Synthetic data only.
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'app/app.dart';
import 'app/controller.dart';
import 'app/router.dart';
import 'app/shell.dart';
import 'core/db/keys.dart';
import 'core/platform/boot_id.dart';
import 'core/platform/monotonic_clock.dart';
import 'core/platform/phone.dart';
import 'preview/preview_api.dart';

class _MemoryKeys implements SecureKeyStore {
  final _values = <String, String>{};

  @override
  Future<String?> read(String key) async => _values[key];
  @override
  Future<void> write(String key, String value) async => _values[key] = value;
  @override
  Future<void> delete(String key) async => _values.remove(key);
}

class _PreviewPhone extends RealPhone {
  Directory? _dir;

  @override
  Future<Directory> dataDirectory() async => _dir ??= await (await super.dataDirectory()).createTemp('preview_');
}

void main() {
  if (!kDebugMode) throw StateError('the preview runs in debug builds only');
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AppController(
    phone: _PreviewPhone(),
    keyStore: _MemoryKeys(),
    apiBuilder: (_, __, ___) => PreviewApi(DateTime.now),
    clock: PlatformMonotonicClock(),
    bootId: PlatformBootIdSource(),
    appVersion: '0.0.0',
  );
  final router = buildRouter(controller);
  runApp(PhleboApp(
    router: router,
    gate: (child) => PhaseGate(
      controller: controller,
      versionLabel: 'PREVIEW, demo data. Any email and password.',
      onSignedOut: () => resetNavigation(router),
      child: child,
    ),
  ));
  unawaited(controller.start());
}
