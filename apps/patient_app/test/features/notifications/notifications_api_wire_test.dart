// T-P5 — TransportNotificationsApi wire (E45 listMyNotifications, E46 markMyNotificationsRead): method, path, query and body exactly as contracts/openapi/engagement.yaml;
// answers passed through untouched; errors not swallowed. E45 has no Idempotency-Key (x-idempotency: none); E46's is optional, so none is required here.
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/features/notifications/notifications_api.dart';

import '../../support/notifications_fakes.dart';

typedef Call = ({String method, String path, Map<String, Object?>? query, Map<String, String>? headers, Object? body});

void main() {
  late List<Call> calls;
  late Object? answer;
  late NotificationsApi api;

  setUp(() {
    calls = [];
    answer = {'ok': true};
    Future<Object?> transport(String method, String path, {Map<String, Object?>? query, Map<String, String>? headers, Object? body}) async {
      calls.add((method: method, path: path, query: query, headers: headers, body: body));
      if (answer is Exception) throw answer!;
      return answer;
    }

    final PatientTransport t = transport;
    api = TransportNotificationsApi(transport: t);
  });

  test('E45 GET /v1/engagement/me/notifications: no body; no query when nothing is asked; the answer is returned untouched', () async {
    answer = pageOf([nWire(id: nid(1))]);
    final out = await api.listMyNotifications();
    final c = calls.single;
    expect([c.method, c.path], ['GET', '/v1/engagement/me/notifications']);
    expect(c.body, isNull);
    expect(c.query ?? {}, isEmpty);
    expect(c.headers?.keys.map((k) => k.toLowerCase()) ?? <String>[], isNot(contains('idempotency-key')));
    expect(((out as Map)['data'] as List).single, containsPair('id', nid(1)));
  });

  test('E45 unread_only=true is sent as a query value that serialises to "true"; cursor and limit only when given', () async {
    await api.listMyNotifications(unreadOnly: true, cursor: 'c3ludGhldGlj', limit: 20);
    final q = calls.single.query!;
    expect(q['unread_only'].toString(), 'true');
    expect(q['cursor'], 'c3ludGhldGlj');
    expect(q['limit'].toString(), '20');
    expect(calls.single.body, isNull);
  });

  test('E45 with unreadOnly false does not send unread_only=false as a filter-on value', () async {
    await api.listMyNotifications(unreadOnly: false);
    expect(calls.single.query?['unread_only']?.toString(), anyOf(isNull, 'false'));
  });

  test('E46 POST /v1/engagement/me/notifications/bulk-mark-read {ids}; nothing else in the body', () async {
    answer = {'results': [{'id': nid(1), 'outcome': 'updated'}, {'id': nid(2), 'outcome': 'not_found'}]};
    final out = await api.markMyNotificationsRead(ids: [nid(1), nid(2)]);
    final c = calls.single;
    expect([c.method, c.path], ['POST', '/v1/engagement/me/notifications/bulk-mark-read']);
    expect(c.body, {'ids': [nid(1), nid(2)]});
    expect((out as Map)['results'], hasLength(2));
  });

  test('errors are not swallowed (E45 and E46 both rethrow the LimsException)', () async {
    answer = LimsException('common.internal');
    await expectLater(api.listMyNotifications(), throwsA(isA<LimsException>()));
    await expectLater(api.markMyNotificationsRead(ids: [nid(1)]), throwsA(isA<LimsException>()));
  });
}
