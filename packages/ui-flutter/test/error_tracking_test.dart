// T0D-15 / LD-24 (A33-1, binding): Flutter initialises the Sentry SDK pointing at self-hosted GlitchTip, DSN from runtime
// config, OFF when unset; beforeSend runs the shared PHI scrubber (T0A-08 logger corpus, CV §9.2): no request bodies,
// no query strings, no names/phones/MRNs, user = opaque membership id only.
// ASSUMED API (exported from package:lims_ui/lims_ui.dart):
//   SentryEvent? limsBeforeSend(SentryEvent event, Hint hint)
//   LimsErrorTracking.configure(SentryFlutterOptions options, {String? dsn, String environment, String release})
//     -> sets options.dsn only when dsn is non-blank; installs limsBeforeSend; sendDefaultPii=false; no screenshots/view hierarchy.
// Events are built with SentryEvent.fromJson so the test does not depend on constructor shapes. All data is synthetic.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

const _jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXNpZw';

Map<String, dynamic> _phiEvent() => {
      'event_id': 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      'message': {'formatted': 'sync failed phone 9812345678 barcode=BC-000123 for +977-9812345678'},
      'user': {
        'id': 'membership-0189f5e0-0000-7000-8000-000000000001',
        'email': 'sita.poudel@example.test',
        'username': 'sita.poudel',
        'name': 'Sita Poudel',
        'ip_address': '203.0.113.9',
        'data': {'patient_name': 'Sita Poudel'},
      },
      'request': {
        'url': 'https://app.example.test/v1/orders?registration_no=MRN-0042&phone=9812345678',
        'method': 'POST',
        'query_string': 'registration_no=MRN-0042&phone=9812345678',
        'data': {'patient_name': 'Sita Poudel', 'phone': '9812345678'},
        'cookies': 'sid=SECRETSESSION',
        'headers': {'Authorization': 'Bearer $_jwt', 'Cookie': 'sid=SECRETSESSION', 'Accept': 'application/json'},
      },
      'extra': {'patient_name': 'Sita Poudel', 'registration_no': 'MRN-0042', 'retry': 2},
      'contexts': {'custom': {'phone': '9812345678', 'attempt': 1}},
      'breadcrumbs': [
        {'message': 'GET /v1/reports?patient_code=MRN-0042 token $_jwt', 'category': 'http', 'data': {'url': 'https://app.example.test/v1/reports?x=MRN-0042', 'phone': '9812345678'}},
      ],
      'exception': {
        'values': [
          {'type': 'StateError', 'value': 'Bad state: otp 482913 rejected for 9812345678'},
        ],
      },
    };

const _phi = [
  'Sita Poudel', 'sita.poudel', 'sita@', '9812345678', '+977-9812345678', 'MRN-0042', 'BC-000123', '203.0.113.9',
  'SECRETSESSION', 'Bearer', _jwt, '482913',
];

String _json(SentryEvent? e) => jsonEncode(e!.toJson());

void main() {
  group('limsBeforeSend (LD-24 scrubber)', () {
    test('removes every PHI/secret string from a synthetic event', () {
      final out = limsBeforeSend(SentryEvent.fromJson(_phiEvent()), Hint());
      expect(out, isNotNull, reason: 'event is still reported, only scrubbed');
      final s = _json(out);
      for (final p in _phi) {
        expect(s.contains(p), isFalse, reason: 'leaked "$p" in $s');
      }
    });

    test('request: no body, no query string, no cookies, no auth header; path/method kept', () {
      final r = limsBeforeSend(SentryEvent.fromJson(_phiEvent()), Hint())!.request;
      expect(r?.data, isNull);
      expect(r?.queryString, isNull);
      expect(r?.cookies, isNull);
      final hdr = (r?.headers ?? {}).keys.map((k) => k.toLowerCase());
      expect(hdr, isNot(contains('authorization')));
      expect(hdr, isNot(contains('cookie')));
      expect(r?.url ?? '', isNot(contains('?')));
      expect(r?.method, 'POST');
    });

    test('user is the opaque membership id only', () {
      final u = limsBeforeSend(SentryEvent.fromJson(_phiEvent()), Hint())!.user;
      expect(u?.id, 'membership-0189f5e0-0000-7000-8000-000000000001');
      expect(u?.email, isNull);
      expect(u?.username, isNull);
      expect(u?.name, isNull);
      expect(u?.ipAddress, isNull);
      expect(u?.data == null || u!.data!.isEmpty, isTrue);
    });

    test('keeps what an engineer needs: exception type, event id, benign extra', () {
      final e = limsBeforeSend(SentryEvent.fromJson(_phiEvent()), Hint())!;
      expect(e.exceptions?.first.type, 'StateError');
      expect(e.eventId.toString(), contains('a1b2c3d4'));
      expect(_json(e), contains('"retry":2'));
    });

    test('idempotent and tolerant: no user/request/exception; empty event; second pass unchanged', () {
      final bare = SentryEvent.fromJson({'event_id': 'a1b2c3d4e5f60718293a4b5c6d7e8f90'});
      expect(() => limsBeforeSend(bare, Hint()), returnsNormally);
      final once = limsBeforeSend(SentryEvent.fromJson(_phiEvent()), Hint())!;
      final twice = limsBeforeSend(once, Hint())!;
      expect(_json(twice), _json(once));
    });

    test('scrubber is not bypassed by header/key case variants or nested maps', () {
      final ev = _phiEvent();
      (ev['request'] as Map)['headers'] = {'AUTHORIZATION': 'Bearer $_jwt', 'set-cookie': 'sid=SECRETSESSION'};
      (ev['extra'] as Map)['nested'] = {'deep': {'Phone': '9812345678', 'PATIENT_NAME': 'Sita Poudel'}};
      final s = _json(limsBeforeSend(SentryEvent.fromJson(ev), Hint()));
      for (final p in ['Sita Poudel', '9812345678', 'SECRETSESSION', _jwt]) {
        expect(s.contains(p), isFalse, reason: p);
      }
    });
  });

  group('LimsErrorTracking.configure (LD-24 wiring)', () {
    for (final dsn in <String?>[null, '', '   ']) {
      test('SDK disabled when DSN is ${dsn == null ? 'null' : "'$dsn'"}', () {
        final o = SentryFlutterOptions();
        LimsErrorTracking.configure(o, dsn: dsn);
        expect(o.dsn == null || o.dsn!.trim().isEmpty, isTrue, reason: 'empty DSN = SDK off, no network');
      });
    }

    test('DSN from runtime config; PII off; scrubber installed; no screenshots/hierarchy; no default DSN', () {
      final fresh = SentryFlutterOptions();
      expect(fresh.dsn == null || fresh.dsn!.isEmpty, isTrue);
      final o = SentryFlutterOptions();
      LimsErrorTracking.configure(o, dsn: 'https://publickey@glitchtip.lims.example.invalid/1', environment: 'staging', release: 'lims_ui@0.0.0');
      expect(o.dsn, 'https://publickey@glitchtip.lims.example.invalid/1');
      expect(o.sendDefaultPii, isFalse);
      expect(o.attachScreenshot, isFalse);
      expect(o.attachViewHierarchy, isFalse);
      expect(o.beforeSend, isNotNull);
      expect(o.environment, 'staging');
      expect(o.release, 'lims_ui@0.0.0');
      // the installed hook is the scrubber: feeding PHI through it yields a clean event
      final cleaned = o.beforeSend!(SentryEvent.fromJson(_phiEvent()), Hint());
      expect(_json(cleaned as SentryEvent?).contains('9812345678'), isFalse);
    });

    test('configure with empty DSN still installs the scrubber (defence in depth)', () {
      final o = SentryFlutterOptions();
      LimsErrorTracking.configure(o, dsn: '');
      expect(o.beforeSend, isNotNull);
    });
  });
}
