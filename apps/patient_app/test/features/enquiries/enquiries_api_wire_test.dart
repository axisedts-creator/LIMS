// T-N1 — TransportEnquiriesApi wire (E48-E51 + T3b): method, path, query, body and headers exactly as contracts/openapi/engagement.yaml; answers passed through untouched; errors not swallowed.
// E49 and E51: Idempotency-Key REQUIRED (x-idempotency: required; ^[A-Za-z0-9_-]{1,64}$), fresh per call; E51 If-Match: "<version>"; E48/E50/T3b send neither.
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/features/enquiries/enquiries_api.dart';

import '../../support/enquiries_fakes.dart';

typedef Call = ({String method, String path, Map<String, Object?>? query, Map<String, String>? headers, Object? body});

void main() {
  late List<Call> calls;
  late Object? answer;
  late EnquiriesApi api;

  setUp(() {
    calls = [];
    answer = {'ok': true};
    Future<Object?> transport(String method, String path, {Map<String, Object?>? query, Map<String, String>? headers, Object? body}) async {
      calls.add((method: method, path: path, query: query, headers: headers, body: body));
      if (answer is Exception) throw answer!;
      return answer;
    }

    final PatientTransport t = transport;
    api = TransportEnquiriesApi(transport: t);
  });

  String? header(Call c, String name) => c.headers?.entries.where((e) => e.key.toLowerCase() == name.toLowerCase()).map((e) => e.value).firstOrNull;
  final idem = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

  test('E48 GET /v1/engagement/me/enquiries: no body, no Idempotency-Key, no query unless asked; the answer is returned untouched', () async {
    answer = pageOf([summaryWire(id: enqId(1))]);
    final out = await api.listMyEnquiries();
    final c = calls.single;
    expect([c.method, c.path], ['GET', '/v1/engagement/me/enquiries']);
    expect(c.body, isNull);
    expect(c.query ?? {}, isEmpty);
    expect(header(c, 'Idempotency-Key'), isNull);
    expect(((out as Map)['data'] as List).single, containsPair('id', enqId(1)));
    await api.listMyEnquiries(cursor: 'c3ludGhldGlj', limit: 20);
    expect(calls.last.query!['cursor'], 'c3ludGhldGlj');
    expect(calls.last.query!['limit'].toString(), '20');
  });

  test('E49 POST /v1/engagement/me/enquiries {category_code, subject, message} (+ profile_id only when given) with a fresh valid Idempotency-Key', () async {
    await api.createMyEnquiry(categoryCode: 'report', subject: 'S', message: 'M');
    await api.createMyEnquiry(categoryCode: 'booking', subject: 'S2', message: 'M2', profileId: eSelf);
    expect([calls[0].method, calls[0].path], ['POST', '/v1/engagement/me/enquiries']);
    expect(calls[0].body, {'category_code': 'report', 'subject': 'S', 'message': 'M'});
    expect(calls[1].body, {'category_code': 'booking', 'subject': 'S2', 'message': 'M2', 'profile_id': eSelf});
    expect(header(calls[0], 'Idempotency-Key'), matches(idem));
    expect(header(calls[1], 'Idempotency-Key'), matches(idem));
    expect(header(calls[0], 'Idempotency-Key'), isNot(header(calls[1], 'Idempotency-Key')));
    expect(calls[0].query ?? {}, isEmpty); // text never in the URL
  });

  test('E50 GET /v1/engagement/me/enquiries/{id}: no body, no Idempotency-Key', () async {
    await api.getMyEnquiry(id: enqId(1));
    final c = calls.single;
    expect([c.method, c.path], ['GET', '/v1/engagement/me/enquiries/${enqId(1)}']);
    expect(c.body, isNull);
    expect(header(c, 'Idempotency-Key'), isNull);
  });

  test('E51 POST /v1/engagement/me/enquiries/{id}/messages {message} with If-Match "<version>" and a valid Idempotency-Key; nothing else in the body or URL', () async {
    await api.replyMyEnquiry(id: enqId(1), message: 'Synthetic reply', version: 4);
    final c = calls.single;
    expect([c.method, c.path], ['POST', '/v1/engagement/me/enquiries/${enqId(1)}/messages']);
    expect(c.body, {'message': 'Synthetic reply'});
    expect(header(c, 'If-Match'), '"4"');
    expect(header(c, 'Idempotency-Key'), matches(idem));
    expect(c.query ?? {}, isEmpty);
  });

  test('T3b GET /v1/engagement/me/coded-sets/enquiry_categories', () async {
    answer = categoriesWire;
    final out = await api.listMyCodedSet('enquiry_categories');
    expect([calls.single.method, calls.single.path], ['GET', '/v1/engagement/me/coded-sets/enquiry_categories']);
    expect(((out as Map)['data'] as List), hasLength(3));
  });

  test('errors are not swallowed (every call rethrows the LimsException: 409 invalid transition, 409 version conflict)', () async {
    answer = LimsException('engagement.enquiry_invalid_transition');
    await expectLater(api.replyMyEnquiry(id: enqId(1), message: 'x', version: 1), throwsA(isA<LimsException>()));
    await expectLater(api.createMyEnquiry(categoryCode: 'report', subject: 's', message: 'm'), throwsA(isA<LimsException>()));
    await expectLater(api.listMyEnquiries(), throwsA(isA<LimsException>()));
    await expectLater(api.getMyEnquiry(id: enqId(1)), throwsA(isA<LimsException>()));
    await expectLater(api.listMyCodedSet('enquiry_categories'), throwsA(isA<LimsException>()));
  });
}
