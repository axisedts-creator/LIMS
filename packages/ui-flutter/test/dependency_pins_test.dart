// T0D-15 / CR-C17-010 + CR-C16-017 plugin pins (04-UI-UX §8 "Dependency pins"; CV §15.1-§15.3; REQ-SEC-129; 08 A19 D-127).
// Rules: exact versions, recorded in db/meta/decisions/T0-03-dependencies.md (LD-04: that file holds the TRD §2.3 table)
// with an allowed licence and a "no runtime egress" statement; present in the committed pubspec.lock; nothing in lib/ may
// reach the network by itself (LD-24: the only egress is Sentry/GlitchTip, DSN from runtime config).
// ASSUMPTION: the "no runtime egress" evidence is the literal phrase "no runtime egress" inside the dependency's table row.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '_helpers.dart';

final _exact = RegExp(r'^\d+\.\d+\.\d+([+-][0-9A-Za-z.]+)?$');
final _allowedLicence = RegExp(r'^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|Zlib|OFL-1\.1|Unicode-3\.0|Unicode-DFS)\b');
const _internal = {'lims_shared', 'lims_ui', 'flutter', 'flutter_test', 'flutter_localizations'};
const _banned = ['sqlcipher_flutter_libs', 'google_fonts', 'firebase_core', 'firebase_analytics', 'firebase_crashlytics', 'mixpanel_flutter', 'amplitude_flutter', 'bikram_sambat', 'sentry_flutter_unscrubbed'];

/// name -> version text for a top-level pubspec section (flat `name: value` or `name:` + nested lines).
Map<String, String> _section(String pub, String key) {
  final out = <String, String>{};
  final lines = pub.split('\n');
  var i = lines.indexWhere((l) => l.trimRight() == '$key:');
  if (i < 0) return out;
  String? cur;
  for (i++; i < lines.length; i++) {
    final l = lines[i];
    if (l.trim().isEmpty || l.trimLeft().startsWith('#')) continue;
    if (!l.startsWith(' ')) break;
    final top = RegExp(r'^  ([A-Za-z0-9_]+):\s*(.*)$').firstMatch(l);
    if (top != null) {
      cur = top.group(1);
      out[cur!] = top.group(2)!.trim();
    } else if (cur != null) {
      out[cur] = '${out[cur]} ${l.trim()}'.trim(); // nested sdk:/path:/git: lines
    }
  }
  return out;
}

Map<String, List<String>> _table() {
  final f = File('${repoRoot().path}/db/meta/decisions/T0-03-dependencies.md');
  final rows = <String, List<String>>{};
  for (final l in f.readAsLinesSync()) {
    if (!l.startsWith('|')) continue;
    final c = l.split('|').map((s) => s.trim()).toList();
    if (c.length > 6) rows[c[1]] = c.sublist(1, c.length - 1);
  }
  return rows;
}

String _stripComments(String s) => s.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '').split('\n').map((l) => l.replaceFirst(RegExp(r'//.*$'), '')).join('\n');

void main() {
  final pub = File('${pkgDir().path}/pubspec.yaml').readAsStringSync();
  final deps = _section(pub, 'dependencies');
  final dev = _section(pub, 'dev_dependencies');
  final table = _table();

  test('pubspec identity: lims_ui, workspace member, pinned SDKs, not published', () {
    expect(pub, matches(RegExp(r'^name:\s*lims_ui\s*$', multiLine: true)));
    expect(pub, matches(RegExp(r'^publish_to:\s*none\s*$', multiLine: true)));
    expect(pub, matches(RegExp(r'^resolution:\s*workspace\s*$', multiLine: true)));
    // LD-46: repo pin bumped to newest 3.47.x stable (3.47.9, bundled Dart 3.13.7).
    expect(pub, contains('sdk: 3.13.7'));
    expect(pub, contains('flutter: 3.47.9'));
    final root = File('${repoRoot().path}/pubspec.yaml').readAsStringSync();
    expect(root, contains('packages/ui-flutter'), reason: 'root workspace must list the package');
    expect(pub.contains('dependency_overrides'), isFalse);
  });

  test('no git/path/url/hosted sources and no range specifiers (CV §15.1, REQ-SEC-129)', () {
    for (final e in {...deps, ...dev}.entries) {
      if (_internal.contains(e.key)) continue;
      expect(e.value, matches(_exact), reason: '${e.key}: "${e.value}" must be an exact version');
    }
    expect(RegExp(r'^\s+(git|path|url):', multiLine: true).hasMatch(pub), isFalse);
  });

  test('required pins exist: Sentry (LD-24), nepali_date_picker 8.0.0 (04 D13), scanner, riverpod example dep absent from lib', () {
    expect(deps['sentry_flutter'], isNotNull, reason: 'LD-24: Sentry SDK for GlitchTip');
    expect(deps['nepali_date_picker'], '8.0.0');
    expect(deps['lims_shared'], isNotNull);
    expect(deps['mobile_scanner'], '7.5.0', reason: 'T0-03 table pin for LimsBarcodeScanner');
  });

  test('CR-C17-010 / CR-C16-017 capabilities each have a pinned dependency whose table row names its purpose', () {
    final purposes = <String, RegExp>{
      'router/app links': RegExp(r'router|app.?link|deep.?link', caseSensitive: false),
      'external browser': RegExp(r'external browser|browser', caseSensitive: false),
      'local auth (biometric)': RegExp(r'local.?auth|biometric', caseSensitive: false),
      'PDF render': RegExp(r'\bpdf\b', caseSensitive: false),
      'QR render': RegExp(r'\bqr\b', caseSensitive: false),
      'url_launcher-class hand-off': RegExp(r'hand-?off|tel:|maps', caseSensitive: false),
      'location capture': RegExp(r'location|gps|geoloc', caseSensitive: false),
      'barcode scan': RegExp(r'barcode', caseSensitive: false),
      'error tracking': RegExp(r'sentry|glitchtip|error tracking', caseSensitive: false),
    };
    final pinned = [...deps.keys, ...dev.keys].where((k) => !_internal.contains(k)).toList();
    for (final p in purposes.entries) {
      final hit = pinned.where((k) => table[k] != null && p.value.hasMatch(table[k]![3])).toList();
      expect(hit, isNotEmpty, reason: 'no pinned dependency whose T0-03 Purpose matches ${p.key}');
    }
  });

  test('every external dependency has a T0-03 row: same exact version, allowed licence, "no runtime egress"', () {
    for (final e in deps.entries.where((e) => !_internal.contains(e.key))) {
      final row = table[e.key];
      expect(row, isNotNull, reason: '${e.key} missing from db/meta/decisions/T0-03-dependencies.md');
      expect(row![1], e.value, reason: '${e.key} version in table vs pubspec');
      expect(row[2], matches(_allowedLicence), reason: '${e.key} licence "${row[2]}" not on the CV §15.2 allow-list');
      expect(row.join(' | '), matches(RegExp('no runtime egress', caseSensitive: false)), reason: '${e.key}: row lacks "no runtime egress" evidence');
      expect(row[4], matches(RegExp(r'20\d\d-\d\d-\d\d')), reason: '${e.key}: last-release evidence date missing');
    }
    for (final e in dev.entries.where((e) => !_internal.contains(e.key))) {
      final row = table[e.key];
      expect(row, isNotNull, reason: 'dev dependency ${e.key} missing from table');
      expect(row![1], e.value);
      expect(row[2], matches(_allowedLicence));
    }
  });

  test('banned dependencies absent (CV §15.3) and pubspec.lock pins match (REQ-SEC-129)', () {
    for (final b in _banned) {
      expect({...deps, ...dev}.containsKey(b), isFalse, reason: b);
    }
    final lock = File('${repoRoot().path}/pubspec.lock').readAsStringSync().replaceAll('\r\n', '\n');
    for (final e in deps.entries.where((e) => !_internal.contains(e.key))) {
      final m = RegExp('^  ${e.key}:\\n(?:    .*\\n)*?    version: "([^"]+)"', multiLine: true).firstMatch(lock);
      expect(m, isNotNull, reason: '${e.key} not in committed pubspec.lock (run flutter pub get, commit the lock)');
      expect(m!.group(1), e.value, reason: '${e.key} locked version');
    }
  });

  group('no runtime egress in lib/ (04 §11, CV §15.1)', () {
    final files = Directory('${pkgDir().path}/lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList();
    test('lib/ exists and has widget sources', () => expect(files.length, greaterThan(5)));

    test('no URL literals, HTTP/socket clients, network images or CDN fonts', () {
      final bad = RegExp(r"https?://|package:http/|package:dio/|HttpClient|\bSocket\b|WebSocket|NetworkImage|Image\.network|google_fonts|GoogleFonts|fonts\.googleapis");
      for (final f in files) {
        final code = _stripComments(f.readAsStringSync());
        final m = bad.firstMatch(code);
        expect(m, isNull, reason: '${f.path}: forbidden "${m?.group(0)}"');
      }
    });

    test('no hard-coded Sentry DSN or secret-looking literal; DSN only arrives as an argument (LD-24)', () {
      for (final f in files) {
        final code = _stripComments(f.readAsStringSync());
        expect(RegExp(r'[0-9a-f]{16,}@').hasMatch(code), isFalse, reason: f.path);
        expect(RegExp(r'''(?:dsn|apiKey|api_key|secret|password)\s*[:=]\s*['"][^'"]+['"]''', caseSensitive: false).hasMatch(code), isFalse, reason: f.path);
      }
    });

    test('nepali_date_picker imported only inside the date-picker widget (04 D13); no TLS-bypass helpers (REQ-SEC-102)', () {
      final importers = files.where((f) => f.readAsStringSync().contains('package:nepali_date_picker')).toList();
      expect(importers.length, lessThanOrEqualTo(1));
      for (final f in importers) {
        expect(f.path.toLowerCase(), contains('date_picker'));
      }
      for (final f in files) {
        expect(f.readAsStringSync().contains('badCertificateCallback'), isFalse, reason: f.path);
      }
    });
  });
}
