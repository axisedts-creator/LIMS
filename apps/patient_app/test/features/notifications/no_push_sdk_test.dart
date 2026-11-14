// T-P5 — "no push SDK in dependency tree (CI script)" (06-PLAN T-P5; PRD US-EN-11.2: push is not approved, B11, so no push SDK is in the binary; 02-TRD §4.9; 07-SECURITY §6.6 mobile row
// "no push/analytics SDK (dependency tree check)"; REQ-SEC-106). This is the CI check: `flutter test test/features/notifications/no_push_sdk_test.dart` runs from apps/patient_app and fails
// when a push / remote-messaging package or its platform wiring appears in pubspec.yaml, pubspec.lock (the resolved tree, transitive packages included), Android Gradle / manifest files,
// iOS Podfile / Info.plist / entitlements, or the Firebase config files. Passes today (a regression guard); the scanner itself is proven below against planted fixtures so it can never pass vacuously.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Package names (pub) that deliver push messages or pull in a push transport. Matched as whole package names.
final pushPackages = RegExp(
  r'^(firebase_messaging(_[a-z_]+)?|firebase_core(_[a-z_]+)?|firebase_[a-z_]+|flutter_apns(_[a-z_]+)?|apns[a-z_]*|fcm[a-z_]*|onesignal[a-z_]*|pusher[a-z_]*|push[a-z_]*|'
  r'awesome_notifications(_[a-z_]+)?|flutter_local_notifications(_[a-z_]+)?|airship[a-z_]*|urbanairship[a-z_]*|braze[a-z_]*|appboy[a-z_]*|leanplum[a-z_]*|moengage[a-z_]*|clevertap[a-z_]*|'
  r'flutter_vapid[a-z_]*|web_push[a-z_]*|notification_listener_service|huawei_push|huawei_hms_[a-z_]+|jpush_flutter|getui[a-z_]*|mi_push[a-z_]*|unifiedpush[a-z_]*)$',
);

/// Platform markers: Android / iOS wiring that only exists when a push transport is present.
final pushMarkers = RegExp(
  r'com\.google\.gms\.google-services|google-services|firebase-messaging|firebase-bom|com\.google\.firebase|FirebaseMessaging|FirebaseApp|GoogleService-Info|'
  r'aps-environment|remote-notification|UNUserNotificationCenter|PushKit|onesignal|OneSignal|com\.huawei\.agconnect|hms\.push|jpush|unifiedpush|pusher-push|com\.urbanairship|com\.braze|com\.appboy',
  caseSensitive: false,
);

/// pubspec.yaml: dependency / dev_dependency / dependency_override keys; pubspec.lock: top-level package entries (two-space indent).
Set<String> packageNames(String text, {required bool lock}) {
  final names = <String>{};
  final re = lock ? RegExp(r'^ {2}([a-z0-9_]+):\s*$', multiLine: true) : RegExp(r'^ {2}([a-z0-9_]+):', multiLine: true);
  for (final m in re.allMatches(text)) {
    names.add(m.group(1)!);
  }
  return names;
}

List<String> offenders(Iterable<String> names) => [for (final n in names) if (pushPackages.hasMatch(n)) n];

List<File> platformFiles() {
  final out = <File>[];
  void walk(Directory d, {int depth = 0}) {
    if (!d.existsSync() || depth > 6) return;
    for (final e in d.listSync(followLinks: false)) {
      final name = e.uri.pathSegments.where((s) => s.isNotEmpty).last;
      if (e is Directory) {
        if (name == 'build' || name == '.gradle' || name == '.dart_tool' || name == 'Pods' || name == '.git') continue;
        walk(e, depth: depth + 1);
      } else if (e is File) {
        if (RegExp(r'(\.gradle(\.kts)?|AndroidManifest\.xml|Podfile(\.lock)?|Info\.plist|\.entitlements|\.pbxproj|google-services\.json|GoogleService-Info\.plist|settings\.gradle|gradle\.properties)$').hasMatch(name)) out.add(e);
      }
    }
  }

  walk(Directory('android'));
  walk(Directory('ios'));
  return out;
}

void main() {
  group('the scanner works (never passes vacuously)', () {
    test('catches planted packages in a pubspec.yaml / pubspec.lock shape', () {
      const yaml = 'dependencies:\n  flutter:\n    sdk: flutter\n  firebase_messaging: 15.0.0\n  onesignal_flutter: 5.0.0\n  go_router: 18.1.3\n';
      expect(offenders(packageNames(yaml, lock: false)), unorderedEquals(['firebase_messaging', 'onesignal_flutter']));
      const lock = 'packages:\n  _flutterfire_internals:\n    dependency: transitive\n  firebase_core:\n    dependency: transitive\n  flutter_riverpod:\n    dependency: "direct main"\n';
      expect(offenders(packageNames(lock, lock: true)), ['firebase_core']);
    });
    test('catches platform markers', () {
      for (final s in ["classpath 'com.google.gms:google-services:4.4.0'", 'implementation "com.google.firebase:firebase-messaging"', '<key>aps-environment</key>', 'onesignal']) {
        expect(pushMarkers.hasMatch(s), isTrue, reason: s);
      }
      expect(pushMarkers.hasMatch('implementation "androidx.core:core-ktx:1.12.0"'), isFalse);
    });
    test('does not flag the packages this app really uses', () {
      expect(offenders(['flutter', 'flutter_riverpod', 'flutter_secure_storage', 'go_router', 'local_auth', 'sentry_flutter', 'url_launcher', 'lims_shared', 'lims_ui', 'flutter_test', 'integration_test']), isEmpty);
    });
  });

  group('the dependency tree of apps/patient_app has no push SDK', () {
    test('pubspec.yaml declares none', () {
      final f = File('pubspec.yaml');
      expect(f.existsSync(), isTrue);
      final names = packageNames(f.readAsStringSync(), lock: false);
      expect(names, contains('flutter_riverpod'), reason: 'the scan read the real pubspec.yaml');
      expect(offenders(names), isEmpty);
    });

    test('pubspec.lock (resolved tree, transitive included) has none', () {
      final f = File('pubspec.lock');
      expect(f.existsSync(), isTrue, reason: 'the resolved tree must be committed and scanned');
      final names = packageNames(f.readAsStringSync(), lock: true);
      expect(names, contains('flutter_riverpod'), reason: 'the scan read the real pubspec.lock');
      expect(offenders(names), isEmpty);
    });

    test('the workspace packages the app depends on (lims_shared, lims_ui) declare none', () {
      for (final p in ['../../packages/shared-dart/pubspec.yaml', '../../packages/ui-flutter/pubspec.yaml']) {
        final f = File(p);
        expect(f.existsSync(), isTrue, reason: p);
        expect(offenders(packageNames(f.readAsStringSync(), lock: false)), isEmpty, reason: p);
      }
    });

    test('Android / iOS build files carry no push wiring (google-services plugin, firebase-messaging, aps-environment, ...)', () {
      final files = platformFiles();
      expect(files, isNotEmpty, reason: 'the scan found the platform build files');
      for (final f in files) {
        expect(pushMarkers.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has push wiring');
      }
    });

    test('no Firebase config file is shipped (google-services.json, GoogleService-Info.plist)', () {
      final names = platformFiles().map((f) => f.uri.pathSegments.last).toSet();
      expect(names.intersection({'google-services.json', 'GoogleService-Info.plist'}), isEmpty);
    });

    test('no Dart source in lib/ imports a push / messaging package', () {
      final dart = Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'));
      expect(dart, isNotEmpty);
      final imp = RegExp(r'''import\s+['"]package:([a-z0-9_]+)/''');
      for (final f in dart) {
        for (final m in imp.allMatches(f.readAsStringSync())) {
          expect(pushPackages.hasMatch(m.group(1)!), isFalse, reason: '${f.path} imports ${m.group(1)}');
        }
      }
    });
  });
}
