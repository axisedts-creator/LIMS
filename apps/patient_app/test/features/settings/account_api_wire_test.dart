// T-AC1 - TransportAccountApi wire (E10 getMyAccount, E11 updateMyAccount, E12 deleteMyAccount): method, path, headers and body exactly as contracts/openapi/engagement.yaml
// (E10 x-idempotency none; E11 optional + If-Match; E12 required + If-Match, body {confirm:true}); answers passed through untouched; errors not swallowed.
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/features/settings/account_api.dart';

import '../../support/settings_fakes.dart';

typedef Call = ({String method, String path, Map<String, Object?>? query, Map<String, String>? headers, Object? body});

void main() {
  late List<Call> calls;
  late Object? answer;
  late AccountApi api;

  setUp(() {
    calls = [];
    answer = accountWire();
    Future<Object?> transport(String method, String path, {Map<String, Object?>? query, Map<String, String>? headers, Object? body}) async {
      calls.add((method: method, path: path, query: query, headers: headers, body: body));
      if (answer is Exception) throw answer!;
      return answer;
    }

    final PatientTransport t = transport;
    api = TransportAccountApi(transport: t);
  });

  Map<String, String> lower(Call c) => {for (final e in (c.headers ?? <String, String>{}).entries) e.key.toLowerCase(): e.value};

  test('E10 GET /v1/engagement/me: no body, no query, no If-Match / Idempotency-Key; the answer is returned untouched', () async {
    final out = await api.getMyAccount();
    final c = calls.single;
    expect([c.method, c.path], ['GET', '/v1/engagement/me']);
    expect(c.body, isNull);
    expect(c.query ?? {}, isEmpty);
    expect(lower(c).keys, isNot(contains('if-match')));
    expect(lower(c).keys, isNot(contains('idempotency-key')));
    expect(out, accountWire());
  });

  test('E11 PATCH /v1/engagement/me {reminders_opt_out} with If-Match "<version>" (quoted decimal); nothing else in the body', () async {
    await api.updateMyAccount(version: 3, remindersOptOut: true);
    final c = calls.single;
    expect([c.method, c.path], ['PATCH', '/v1/engagement/me']);
    expect(c.body, {'reminders_opt_out': true});
    expect(lower(c)['if-match'], '"3"');
  });

  test('E11 sends false as false (not omitted, not null)', () async {
    await api.updateMyAccount(version: 7, remindersOptOut: false);
    expect(calls.single.body, {'reminders_opt_out': false});
    expect(lower(calls.single)['if-match'], '"7"');
  });

  test('E12 POST /v1/engagement/me/delete {confirm:true} with If-Match "<version>" and a non-empty Idempotency-Key', () async {
    answer = null;
    await api.deleteMyAccount(version: 3);
    final c = calls.single;
    expect([c.method, c.path], ['POST', '/v1/engagement/me/delete']);
    expect(c.body, {'confirm': true});
    expect(lower(c)['if-match'], '"3"');
    expect(lower(c)['idempotency-key'], isNotNull);
    expect(lower(c)['idempotency-key'], isNotEmpty);
  });

  test('E12 Idempotency-Key is fresh per call (a retry after a failure is a new request, never a replay of a half-done one)', () async {
    answer = null;
    await api.deleteMyAccount(version: 3);
    await api.deleteMyAccount(version: 3);
    expect(lower(calls[0])['idempotency-key'], isNot(lower(calls[1])['idempotency-key']));
  });

  test('errors are not swallowed: LimsException from the transport reaches the caller (E11 and E12)', () async {
    answer = LimsException(LimsErrorCodes.commonVersionConflict);
    await expectLater(api.updateMyAccount(version: 3, remindersOptOut: true), throwsA(isA<LimsException>()));
    await expectLater(api.deleteMyAccount(version: 3), throwsA(isA<LimsException>()));
  });

  test('the account id, phone or any personal value never ends up in a URL (path is the fixed /me form)', () async {
    await api.getMyAccount();
    await api.updateMyAccount(version: 3, remindersOptOut: true);
    await api.deleteMyAccount(version: 3);
    for (final c in calls) {
      expect(c.path, anyOf('/v1/engagement/me', '/v1/engagement/me/delete'));
      expect(c.query ?? {}, isEmpty);
    }
  });
}
