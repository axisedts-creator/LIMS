// T-A1 — US-EN-02.1/2/3/5, review C16 #20. Synthetic data only.
import 'dart:async';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/session/session_controller.dart';
import 'package:patient_app/core/session/session_store.dart';

import 'support/rig.dart';

void main() {
  late Rig rig;
  setUp(() async => rig = await Rig.create());
  tearDown(() => rig.dispose());

  group('storage (US-EN-02.1)', () {
    test('only the session token is persisted, under the spec key; the access JWT stays in memory', () async {
      await rig.signIn();
      await rig.controller.refresh();
      final all = await rig.storage.readAll();
      expect(SessionStore.key, 'lims.patient.session_token');
      expect(all, {SessionStore.key: tok('S1')});
      expect(all.values.any((v) => v.contains('eyJ')), isFalse, reason: 'JWT must never be persisted');
      expect(rig.controller.accessToken, jwt(1));
    });

    test('restore() picks the stored token up: signed in, no JWT yet', () async {
      await rig.store.write(tok('S0'));
      await rig.controller.restore();
      expect(rig.controller.status.value, SessionStatus.signedIn);
      expect(rig.controller.accessToken, isNull);
    });

    test('restore() with nothing stored is signed out', () async {
      await rig.controller.restore();
      expect(rig.controller.status.value, SessionStatus.signedOut);
    });
  });

  group('refresh (US-EN-02.2)', () {
    test('freshAccessToken keeps a JWT that expires in more than 120 s', () async {
      await rig.signIn();
      rig.advance(const Duration(minutes: 57)); // 3 min left
      expect(await rig.controller.freshAccessToken(), jwt(0));
      expect(rig.identity.resolveCalls, 0);
    });

    test('freshAccessToken refreshes a JWT that expires within 120 s', () async {
      await rig.signIn();
      rig.advance(const Duration(minutes: 58, seconds: 30)); // 90 s left
      expect(await rig.controller.freshAccessToken(), jwt(1));
      expect(rig.identity.resolveCalls, 1);
    });

    test('refresh sends the stored session token in X-Lims-Patient-Session', () async {
      await rig.signIn();
      await rig.controller.refresh();
      expect(rig.identity.resolveHeaders.single['X-Lims-Patient-Session'], tok('S0'));
    });

    test('single-flight: 5 concurrent refreshes make exactly one resolve call', () async {
      await rig.signIn();
      final gate = Completer<void>();
      rig.identity.hold = gate.future;
      final all = Future.wait([for (var i = 0; i < 5; i++) rig.controller.refresh()]);
      await Future<void>.delayed(Duration.zero);
      gate.complete();
      await all;
      expect(rig.identity.resolveCalls, 1);
      expect(rig.controller.accessToken, jwt(1));
    });

    test('single-flight clears after completion: a later refresh makes a new call', () async {
      await rig.signIn();
      await rig.controller.refresh();
      await rig.controller.refresh();
      expect(rig.identity.resolveCalls, 2);
    });

    test('the stored token is the rotated one by the time refresh() returns, and the next refresh uses it', () async {
      await rig.signIn();
      await rig.controller.refresh();
      expect(await rig.store.read(), tok('S1'));
      await rig.controller.refresh();
      expect(await rig.store.read(), tok('S2'));
      expect(rig.identity.resolveHeaders.map((h) => h['X-Lims-Patient-Session']).toList(), [tok('S0'), tok('S1')]);
    });

    test('a transient failure keeps the session, and the next refresh is not stuck behind the failed one', () async {
      await rig.signIn();
      rig.identity.failWith = (c) => c == 1 ? const SocketException('offline') : null;
      await expectLater(rig.controller.refresh(), throwsA(isA<SocketException>()));
      expect(rig.controller.status.value, SessionStatus.signedIn);
      expect(await rig.store.read(), tok('S0'), reason: 'old token kept when no rotation happened');
      await rig.controller.refresh();
      expect(rig.controller.accessToken, jwt(2));
    });

    test('a server error (common.internal) does not wipe the session', () async {
      await rig.signIn();
      rig.identity.failWith = (_) => LimsException(LimsErrorCodes.commonInternal);
      await expectLater(rig.controller.refresh(), throwsA(isA<LimsException>()));
      expect(rig.controller.status.value, SessionStatus.signedIn);
      expect(await rig.store.read(), tok('S0'));
    });
  });

  group('wipe on auth.session_expired (US-EN-02.3)', () {
    test('wipes secure storage, memory and temp files, signs out, and surfaces the error', () async {
      await rig.signIn();
      File('${rig.tempDir.path}/report.pdf').writeAsBytesSync([1, 2, 3]);
      rig.identity.failWith = (_) => LimsException(LimsErrorCodes.authSessionExpired);
      await expectLater(
        rig.controller.refresh(),
        throwsA(isA<LimsException>().having((e) => e.code, 'code', 'auth.session_expired')),
      );
      expect(await rig.storage.readAll(), isEmpty);
      expect(rig.controller.accessToken, isNull);
      expect(rig.controller.status.value, SessionStatus.signedOut);
      expect(rig.tempDir.listSync(), isEmpty);
    });

    test('every concurrent waiter gets the error and resolve is still called once', () async {
      await rig.signIn();
      rig.identity.failWith = (_) => LimsException(LimsErrorCodes.authSessionExpired);
      final results = await Future.wait([
        for (var i = 0; i < 3; i++) rig.controller.refresh().then<Object?>((_) => null, onError: (Object e) => e),
      ]);
      expect(results.every((e) => e is LimsException && e.code == 'auth.session_expired'), isTrue);
      expect(rig.identity.resolveCalls, 1);
    });

    test('no further resolve calls once signed out (no loop)', () async {
      await rig.signIn();
      rig.identity.failWith = (_) => LimsException(LimsErrorCodes.authSessionExpired);
      await rig.controller.refresh().then<void>((_) {}, onError: (_) {});
      await rig.controller.refresh().then<void>((_) {}, onError: (_) {});
      expect(rig.identity.resolveCalls, 1);
    });
  });

  group('logout (US-EN-02.5)', () {
    test('calls logoutPatientSession with the session token, deletes token, memory state and temp PDFs', () async {
      await rig.signIn();
      File('${rig.tempDir.path}/a.pdf').writeAsBytesSync([1]);
      File('${rig.tempDir.path}/b.pdf').writeAsBytesSync([2]);
      await rig.controller.logout();
      expect(rig.identity.logoutHeaders.single['X-Lims-Patient-Session'], tok('S0'));
      expect(await rig.storage.readAll(), isEmpty);
      expect(rig.controller.accessToken, isNull);
      expect(rig.controller.status.value, SessionStatus.signedOut);
      expect(rig.tempDir.listSync(), isEmpty);
    });

    test('logout wipes locally even when the server call fails (fail closed)', () async {
      await rig.signIn();
      rig.identity.logoutFailWith = (_) => const SocketException('offline');
      await rig.controller.logout().then<void>((_) {}, onError: (_) {});
      expect(await rig.storage.readAll(), isEmpty);
      expect(rig.controller.status.value, SessionStatus.signedOut);
    });

    test('logout when already signed out makes no server call and does not throw', () async {
      await rig.controller.logout();
      expect(rig.identity.logoutCalls, 0);
    });
  });

  test('SessionStore.wipe removes the key; read returns null afterwards', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final s = SessionStore(const FlutterSecureStorage());
    await s.write(tok('S0'));
    expect(await s.read(), tok('S0'));
    await s.wipe();
    expect(await s.read(), isNull);
  });
}
