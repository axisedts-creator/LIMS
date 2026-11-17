// HC-T22 static guards over apps/phlebo_app/lib/core/db (REQ-SEC-102/103, TRD §2 pins, §3.4 layout, §7.1; CI row c17-db-forensics).
// cwd = package root when run via `flutter test`.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

Directory _appDir() {
  var d = Directory.current;
  for (var i = 0; i < 4; i++) {
    final f = File('${d.path}/pubspec.yaml');
    if (f.existsSync() && RegExp(r'^name:\s*phlebo_app\s*$', multiLine: true).hasMatch(f.readAsStringSync())) return d;
    d = d.parent;
  }
  throw StateError('apps/phlebo_app/pubspec.yaml not found from ${Directory.current.path}');
}

String _stripComments(String s) => s.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '').split('\n').map((l) => l.replaceFirst(RegExp(r'//.*$'), '')).join('\n');

void main() {
  final app = _appDir();
  final db = Directory('${app.path}/lib/core/db');
  List<File> dbFiles() => db.existsSync() ? db.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
  String code(String name) => _stripComments(File('${db.path}/$name').readAsStringSync());

  test('core/db has keys.dart, cache_db.dart, outbox_db.dart, wipe.dart (TRD §3.4)', () {
    for (final n in ['keys.dart', 'cache_db.dart', 'outbox_db.dart', 'wipe.dart']) {
      expect(File('${db.path}/$n').existsSync(), isTrue, reason: 'lib/core/db/$n');
    }
  });

  test('keys are generated with Random.secure() only — no seeded/insecure Random (TRD §7.1)', () {
    final k = code('keys.dart');
    expect(k, contains('Random.secure()'));
    for (final f in dbFiles()) {
      expect(RegExp(r'\bRandom\s*\(').hasMatch(_stripComments(f.readAsStringSync())), isFalse, reason: '${f.path}: Random(seed) / Random() is not secure');
    }
  });

  test('DB keys go to flutter_secure_storage only (REQ-SEC-102): adapter present, no prefs/file/log sinks in core/db', () {
    final all = dbFiles().map((f) => _stripComments(f.readAsStringSync())).join('\n');
    expect(all, contains('package:flutter_secure_storage/'));
    for (final bad in [r'shared_preferences', r'SharedPreferences', r'\bdebugPrint\s*\(', r'\bprint\s*\(', r'\blog\s*\(', r'developer\.log', r'\bSentry\.']) {
      expect(RegExp(bad).hasMatch(all), isFalse, reason: 'core/db must not use $bad (key/PHI leak sink)');
    }
  });

  test('no banned / plaintext DB paths: no sqlcipher_flutter_libs import, no unencrypted NativeDatabase without a key', () {
    final all = dbFiles().map((f) => _stripComments(f.readAsStringSync())).join('\n');
    expect(all, isNot(contains('sqlcipher_flutter_libs')));
    expect(all, matches(RegExp(r"PRAGMA\s+key", caseSensitive: false)), reason: 'DB must be keyed with PRAGMA key = "x\'<64 hex>\'" (05-SCHEMA Part B)');
    expect(all, isNot(matches(RegExp(r'PRAGMA\s+(rekey|key)\s*=\s*[\x27"]{2}', caseSensitive: false))), reason: 'empty key = plaintext DB');
  });

  group('pubspec pins (CV §15.1 exact; TRD §2)', () {
    final pub = File('${app.path}/pubspec.yaml').readAsStringSync();
    final deps = pub.split(RegExp(r'^dev_dependencies:', multiLine: true)).first;
    String? v(String n) => RegExp('^  $n:\\s*(\\S+)\\s*\$', multiLine: true).firstMatch(deps)?.group(1);

    test('drift 2.35.3 exact', () => expect(v('drift'), '2.35.3'));
    test('sqlite3 is a direct dependency pinned exactly to 3.x.y (SQLCipher hook needs package:sqlite3 >=3)', () {
      expect(v('sqlite3'), isNotNull, reason: 'sqlite3: missing');
      expect(v('sqlite3'), matches(RegExp(r'^3\.\d+\.\d+$')));
    });
    test('flutter_secure_storage pinned exactly', () {
      expect(v('flutter_secure_storage'), isNotNull, reason: 'flutter_secure_storage: missing');
      expect(v('flutter_secure_storage'), matches(RegExp(r'^\d+\.\d+\.\d+$')));
    });
    test('sqlite3 build hook selects an encrypted source (sqlcipher or sqlite3mc) in the app or root pubspec', () {
      final root = File('${app.parent.parent.path}/pubspec.yaml').readAsStringSync();
      final re = RegExp(r'^\s*source:\s*(sqlcipher|sqlite3mc)\s*$', multiLine: true);
      expect(re.hasMatch(pub) || re.hasMatch(root), isTrue, reason: 'hooks.user_defines.sqlite3.source must be sqlcipher|sqlite3mc');
    });
  });
}
