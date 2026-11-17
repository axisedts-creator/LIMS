// HC-T21 done_when: "app builds for dev/staging; no `badCertificateCallback` (CI grep)". REQ-SEC-104/105/107, REQ-SEC-129.
// Static guards over apps/phlebo_app (cwd = package root when run via `flutter test`):
//   - no badCertificateCallback / HttpOverrides / raw HttpClient( outside core/net/pinned_http.dart (comments ignored)
//   - pinned_http.dart uses SecurityContext(withTrustedRoots: false)
//   - no secrets/keys in lib/ (REQ-SEC-107)
//   - pubspec: name phlebo_app, workspace member, same SDK pins as the root, exact dependency pins, in the root workspace list
//   - Android productFlavors dev/staging/prod exist (the only build-level proof available without an Android SDK)
// ASSUMPTION: the Android flavour declaration is in android/app/build.gradle.kts or build.gradle (flutter create layout).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

Directory _appDir() {
  var d = Directory.current;
  for (var i = 0; i < 4; i++) {
    final f = File('${d.path}/pubspec.yaml');
    if (f.existsSync() && RegExp(r'^name:\s*phlebo_app\s*$', multiLine: true).hasMatch(f.readAsStringSync())) return d;
    d = d.parent;
  }
  throw StateError('apps/phlebo_app/pubspec.yaml (name: phlebo_app) not found from ${Directory.current.path}');
}

String _stripComments(String s) => s.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '').split('\n').map((l) => l.replaceFirst(RegExp(r'//.*$'), '')).join('\n');

List<File> _dart(Directory d) =>
    d.existsSync() ? d.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];

String _rel(Directory app, File f) => f.path.substring(app.path.length + 1).replaceAll('\\', '/');

void main() {
  final app = _appDir();
  final lib = Directory('${app.path}/lib');
  final libFiles = _dart(lib);

  test('lib/ has the skeleton files named in the plan row', () {
    for (final p in ['main.dart', 'core/net/pinned_http.dart', 'core/net/api_factory.dart', 'app/flavor.dart', 'app/router.dart', 'app/app.dart']) {
      expect(File('${lib.path}/$p').existsSync(), isTrue, reason: 'lib/$p');
    }
  });

  test('CI grep: no badCertificateCallback anywhere in lib/ (REQ-SEC-105)', () {
    final hits = [for (final f in libFiles) if (_stripComments(f.readAsStringSync()).contains('badCertificateCallback')) _rel(app, f)];
    expect(hits, isEmpty);
  });

  test('CI grep also covers test-side escape hatches: no HttpOverrides, no raw HttpClient( outside pinned_http.dart', () {
    final hits = <String>[];
    for (final f in libFiles) {
      final code = _stripComments(f.readAsStringSync());
      final rel = _rel(app, f);
      if (code.contains('HttpOverrides')) hits.add('$rel: HttpOverrides');
      if (rel != 'lib/core/net/pinned_http.dart' && RegExp(r'\bHttpClient\s*\(').hasMatch(code)) hits.add('$rel: HttpClient(');
    }
    expect(hits, isEmpty);
  });

  test('pinned_http.dart builds SecurityContext(withTrustedRoots: false) (TRD §12)', () {
    final code = _stripComments(File('${lib.path}/core/net/pinned_http.dart').readAsStringSync());
    expect(code, matches(RegExp(r'SecurityContext\(\s*withTrustedRoots:\s*false\s*\)')));
    expect(code, isNot(contains('SecurityContext.defaultContext')));
    expect(code, isNot(contains('withTrustedRoots: true')));
  });

  test('no secrets in lib/ (REQ-SEC-107): no private keys, JWTs, key/secret/password literals', () {
    final bad = RegExp(r'(BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|(api[_-]?key|secret|passw(or)?d|client[_-]?secret)\s*[:=]\s*[\x27"][^\x27"]{4,})', caseSensitive: false);
    final hits = [for (final f in libFiles) if (bad.hasMatch(f.readAsStringSync())) _rel(app, f)];
    expect(hits, isEmpty);
  });

  group('pubspec', () {
    final pub = File('${app.path}/pubspec.yaml').readAsStringSync();
    final root = File('${app.parent.parent.path}/pubspec.yaml').readAsStringSync();

    test('workspace member with the root SDK pins, not published', () {
      expect(pub, matches(RegExp(r'^resolution:\s*workspace\s*$', multiLine: true)));
      expect(pub, matches(RegExp(r'^publish_to:\s*none\s*$', multiLine: true)));
      for (final k in ['sdk', 'flutter']) {
        final rootV = RegExp('^  $k:\\s*(\\S+)\\s*\$', multiLine: true).firstMatch(root)!.group(1);
        expect(RegExp('^  $k:\\s*(\\S+)\\s*\$', multiLine: true).firstMatch(pub)?.group(1), rootV, reason: 'environment.$k');
      }
    });

    test('root pubspec lists apps/phlebo_app in workspace:', () {
      expect(root, matches(RegExp(r'^\s*-\s*apps/phlebo_app\s*$', multiLine: true)));
    });

    test('dependencies: exact pins only (REQ-SEC-129), internal packages via workspace, no banned analytics/crash SaaS', () {
      final deps = RegExp(r'^  ([A-Za-z0-9_]+):\s*(\S+)\s*$', multiLine: true);
      final dependencies = pub.split(RegExp(r'^dev_dependencies:', multiLine: true)).first;
      final exact = RegExp(r'^\d+\.\d+\.\d+([+-][0-9A-Za-z.]+)?$');
      const allowed = {'sdk:', 'any'};
      for (final m in deps.allMatches(dependencies)) {
        final name = m.group(1)!, v = m.group(2)!;
        if (name == 'flutter' || name == 'sdk' || name == 'environment') continue;
        if (name == 'lims_shared' || name == 'lims_ui') {
          expect(v, 'any', reason: '$name is a workspace member');
          continue;
        }
        if (allowed.contains(v)) continue;
        expect(v, matches(exact), reason: 'dependency $name must be an exact version, got "$v"');
      }
      for (final banned in ['firebase_core', 'firebase_analytics', 'firebase_crashlytics', 'mixpanel_flutter', 'amplitude_flutter', 'google_fonts', 'sqlcipher_flutter_libs']) {
        expect(dependencies, isNot(contains('$banned:')), reason: banned);
      }
      expect(dependencies, contains('lims_ui:'));
      expect(dependencies, contains('lims_shared:'));
      expect(dependencies, contains('go_router:'));
    });
  });

  test('Android productFlavors declare dev, staging, prod (builds for dev/staging)', () {
    final candidates = [File('${app.path}/android/app/build.gradle.kts'), File('${app.path}/android/app/build.gradle')];
    final f = candidates.where((c) => c.existsSync()).firstOrNull;
    expect(f, isNotNull, reason: 'android/app/build.gradle(.kts) missing');
    final g = f!.readAsStringSync();
    expect(g, contains('productFlavors'));
    for (final name in ['dev', 'staging', 'prod']) {
      expect(g, matches(RegExp('(create\\(["\']$name["\']\\)|\\b$name\\s*\\{|["\']$name["\']\\s*\\{)')), reason: 'flavor $name');
    }
  });
}
