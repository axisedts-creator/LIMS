// T-A1 — interceptors around the generated client's LimsTransport: auth, version headers, request id,
// 401 refresh-once, 426 -> A1 (US-EN-02.2, US-EN-20.1, review C16 #20). Synthetic data only.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/core/session/session_controller.dart';

import 'support/rig.dart';

typedef Call = ({String method, String path, Map<String, String> headers});

void main() {
  late Rig rig;
  late List<Call> calls;
  late ValueNotifier<bool> updateRequired;
  late Future<Object?> Function(int n, Call c) innerBehaviour;
  late Future<Object?> Function(String method, String path, {Map<String, String>? headers, Object? body, Map<String, Object?>? query}) send;

  setUp(() async {
    rig = await Rig.create();
    calls = [];
    updateRequired = ValueNotifier(false);
    innerBehaviour = (n, c) async => <String, Object?>{'ok': true};
    send = buildPatientTransport(
      inner: (method, path, {query, headers, body}) {
        final c = (method: method, path: path, headers: Map<String, String>.of(headers ?? const {}));
        calls.add(c);
        return innerBehaviour(calls.length, c);
      },
      session: rig.controller,
      appVersion: '1.4.0',
      platform: 'android',
      updateRequired: updateRequired,
    );
  });
  tearDown(() => rig.dispose());

  LimsException tokenExpired() => LimsException(LimsErrorCodes.authTokenExpired);

  test('adds Bearer JWT, app version/platform headers and a UUIDv7 X-Request-Id', () async {
    await rig.signIn();
    await send('GET', '/v1/engagement/profiles');
    final h = calls.single.headers;
    expect(h['Authorization'], 'Bearer ${jwt(0)}');
    expect(h['X-Lims-App-Version'], '1.4.0');
    expect(h['X-Lims-App-Platform'], 'android');
    expect(isUuidv7(h['X-Request-Id']!), isTrue);
  });

  test('every request gets a fresh request id', () async {
    await rig.signIn();
    await send('GET', '/a');
    await send('GET', '/b');
    expect(calls[0].headers['X-Request-Id'], isNot(calls[1].headers['X-Request-Id']));
  });

  test('a caller-supplied Authorization (pre-auth OTP credential) is not overridden', () async {
    await send('POST', '/v1/engagement/auth/otp-challenges/verify', headers: {'Authorization': 'Bearer c.demo_lab.challenge'});
    expect(calls.single.headers['Authorization'], 'Bearer c.demo_lab.challenge');
    expect(rig.identity.resolveCalls, 0, reason: 'signed-out calls never trigger a refresh');
  });

  test('refreshes before sending when the JWT expires within 120 s', () async {
    await rig.signIn();
    rig.advance(const Duration(minutes: 58, seconds: 30));
    await send('GET', '/v1/engagement/orders');
    expect(rig.identity.resolveCalls, 1);
    expect(calls.single.headers['Authorization'], 'Bearer ${jwt(1)}');
  });

  group('401 auth.token_expired', () {
    test('refreshes once and retries the original call once with the new JWT', () async {
      await rig.signIn();
      innerBehaviour = (n, c) async => n == 1 ? throw tokenExpired() : <String, Object?>{'ok': true};
      final r = await send('GET', '/v1/engagement/orders');
      expect(r, {'ok': true});
      expect(rig.identity.resolveCalls, 1);
      expect(calls.map((c) => c.headers['Authorization']).toList(), ['Bearer ${jwt(0)}', 'Bearer ${jwt(1)}']);
    });

    test('the rotated session token is already stored when the retry is sent (review C16 #20)', () async {
      await rig.signIn();
      String? storedAtRetry;
      innerBehaviour = (n, c) async {
        if (n == 1) throw tokenExpired();
        storedAtRetry = await rig.store.read();
        return <String, Object?>{};
      };
      await send('GET', '/x');
      expect(storedAtRetry, tok('S1'));
    });

    test('rotation on every refresh: second expiry presents S1, not S0', () async {
      await rig.signIn();
      var stale = jwt(0);
      innerBehaviour = (n, c) async {
        if (c.headers['Authorization'] == 'Bearer $stale') throw tokenExpired();
        return <String, Object?>{};
      };
      await send('GET', '/one'); // jwt(0) stale -> refresh #1 (token S0 -> S1)
      stale = jwt(1);
      await send('GET', '/two'); // jwt(1) stale -> refresh #2 must present S1
      expect(rig.identity.resolveHeaders.map((h) => h['X-Lims-Patient-Session']).toList(), [tok('S0'), tok('S1')]);
    });

    test('never loops: a second 401 token_expired after the retry is surfaced; one refresh, two inner calls', () async {
      await rig.signIn();
      innerBehaviour = (n, c) async => throw tokenExpired();
      await expectLater(send('GET', '/x'), throwsA(isA<LimsException>().having((e) => e.code, 'code', 'auth.token_expired')));
      expect(rig.identity.resolveCalls, 1);
      expect(calls.length, 2);
    });

    test('single-flight across calls: 5 concurrent 401s trigger one resolve', () async {
      await rig.signIn();
      final seen = <String>{};
      innerBehaviour = (n, c) async {
        final a = c.headers['Authorization']!;
        if (a == 'Bearer ${jwt(0)}') throw tokenExpired();
        seen.add(a);
        return <String, Object?>{};
      };
      final gate = Completer<void>();
      rig.identity.hold = gate.future;
      final all = Future.wait([for (var i = 0; i < 5; i++) send('GET', '/p$i')]);
      await Future<void>.delayed(Duration.zero);
      gate.complete();
      await all;
      expect(rig.identity.resolveCalls, 1);
      expect(seen, {'Bearer ${jwt(1)}'});
    });

    test('signed out: 401 token_expired is surfaced without a refresh attempt', () async {
      innerBehaviour = (n, c) async => throw tokenExpired();
      await expectLater(send('GET', '/x'), throwsA(isA<LimsException>()));
      expect(rig.identity.resolveCalls, 0);
      expect(calls.length, 1);
    });
  });

  group('failures on the single retry after a refresh (review item 1)', () {
    test('retry answers auth.session_expired -> store wiped, status signedOut, error surfaced', () async {
      await rig.signIn();
      innerBehaviour = (n, c) async => n == 1 ? throw tokenExpired() : throw LimsException(LimsErrorCodes.authSessionExpired);
      await expectLater(send('GET', '/x'), throwsA(isA<LimsException>().having((e) => e.code, 'code', 'auth.session_expired')));
      expect(calls.length, 2);
      expect(await rig.storage.readAll(), isEmpty);
      expect(rig.controller.status.value, SessionStatus.signedOut);
    });

    test('retry answers 426 -> update-required signal set, error surfaced, session kept', () async {
      await rig.signIn();
      innerBehaviour = (n, c) async => n == 1 ? throw tokenExpired() : throw LimsException(LimsErrorCodes.engagementAppVersionUnsupported);
      await expectLater(send('GET', '/x'), throwsA(isA<LimsException>().having((e) => e.code, 'code', 'engagement.app_version_unsupported')));
      expect(updateRequired.value, isTrue);
      expect(calls.length, 2);
      expect(await rig.store.read(), tok('S1'));
    });
  });

  test('401 auth.session_expired from refresh wipes and surfaces; the original call is not retried', () async {
    await rig.signIn();
    rig.identity.failWith = (_) => LimsException(LimsErrorCodes.authSessionExpired);
    innerBehaviour = (n, c) async => throw tokenExpired();
    await expectLater(send('GET', '/x'), throwsA(isA<LimsException>().having((e) => e.code, 'code', 'auth.session_expired')));
    expect(calls.length, 1);
    expect(await rig.storage.readAll(), isEmpty);
  });

  test('a direct 401 auth.session_expired from any call wipes the session', () async {
    await rig.signIn();
    innerBehaviour = (n, c) async => throw LimsException(LimsErrorCodes.authSessionExpired);
    await expectLater(send('GET', '/x'), throwsA(isA<LimsException>()));
    expect(await rig.storage.readAll(), isEmpty);
    expect(rig.identity.resolveCalls, 0);
  });

  group('426 engagement.app_version_unsupported -> A1 (US-EN-20.1)', () {
    test('raises the update-required signal and rethrows; no refresh, no retry', () async {
      await rig.signIn();
      innerBehaviour = (n, c) async => throw LimsException(LimsErrorCodes.engagementAppVersionUnsupported);
      await expectLater(
        send('GET', '/v1/engagement/orders'),
        throwsA(isA<LimsException>().having((e) => e.code, 'code', 'engagement.app_version_unsupported')),
      );
      expect(updateRequired.value, isTrue);
      expect(calls.length, 1);
      expect(rig.identity.resolveCalls, 0);
    });

    test('426 does not wipe the session (user updates, then continues)', () async {
      await rig.signIn();
      innerBehaviour = (n, c) async => throw LimsException(LimsErrorCodes.engagementAppVersionUnsupported);
      await send('GET', '/x').then<void>((_) {}, onError: (_) {});
      expect(await rig.store.read(), tok('S0'));
    });

    test('other errors leave the signal off', () async {
      await rig.signIn();
      innerBehaviour = (n, c) async => throw LimsException(LimsErrorCodes.commonInternal);
      await send('GET', '/x').then<void>((_) {}, onError: (_) {});
      expect(updateRequired.value, isFalse);
    });
  });
}
