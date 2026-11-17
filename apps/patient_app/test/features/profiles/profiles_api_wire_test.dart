// T-L6 — TransportProfilesApi wire (E13-E19): method, path, body and headers exactly as contracts/openapi/engagement.yaml, answers passed through untouched, errors not swallowed.
// Idempotency-Key is REQUIRED on E14/E15/E16 (x-idempotency: required; pattern ^[A-Za-z0-9_-]{1,64}$) and fresh per call; E13/E17/E18/E19 send none (E18 optional, E19 none).
// E18/E19 require `If-Match: "<version>"` (LD-164: Profile.version from E13); the header is the quoted version of the profile changed/removed, e.g. version 3 -> `"3"`.
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/features/profiles/profiles_api.dart';

import '../../support/profiles_fakes.dart';

typedef Call = ({String method, String path, Map<String, Object?>? query, Map<String, String>? headers, Object? body});

void main() {
  late List<Call> calls;
  late Object? answer;
  late ProfilesApi api;

  setUp(() {
    calls = [];
    answer = {'ok': true};
    Future<Object?> transport(String method, String path, {Map<String, Object?>? query, Map<String, String>? headers, Object? body}) async {
      calls.add((method: method, path: path, query: query, headers: headers, body: body));
      if (answer is Exception) throw answer!;
      return answer;
    }

    final PatientTransport t = transport;
    api = TransportProfilesApi(transport: t);
  });

  String? header(Call c, String name) => c.headers?.entries.where((e) => e.key.toLowerCase() == name.toLowerCase()).map((e) => e.value).firstOrNull;

  final idemPattern = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

  test('E13 GET /v1/engagement/me/profiles, no body, no query, no Idempotency-Key; the answer is returned untouched', () async {
    answer = listBody(data: [profile()], paused: 1);
    final out = await api.listMyProfiles();
    expect(calls.single.method, 'GET');
    expect(calls.single.path, '/v1/engagement/me/profiles');
    expect(calls.single.body, isNull);
    expect(calls.single.query ?? {}, isEmpty);
    expect(header(calls.single, 'Idempotency-Key'), isNull);
    expect((out as Map)['paused_count'], 1);
  });

  test('E14 POST /v1/engagement/me/profiles/redeem-code {code} with a valid Idempotency-Key', () async {
    await api.redeemLinkCode(code: 'ABCDE-FGHJK');
    final c = calls.single;
    expect([c.method, c.path], ['POST', '/v1/engagement/me/profiles/redeem-code']);
    expect(c.body, {'code': 'ABCDE-FGHJK'});
    expect(header(c, 'Idempotency-Key'), matches(idemPattern));
  });

  test('E15 POST /v1/engagement/me/profiles/redeem-report-link {link_url} with a valid Idempotency-Key', () async {
    await api.redeemReportLink(linkUrl: 'https://portal.invalid/r/abc');
    final c = calls.single;
    expect([c.method, c.path], ['POST', '/v1/engagement/me/profiles/redeem-report-link']);
    expect(c.body, {'link_url': 'https://portal.invalid/r/abc'});
    expect(header(c, 'Idempotency-Key'), matches(idemPattern));
  });

  test('E16 POST /v1/engagement/me/profiles/self-registrations: body as given, valid Idempotency-Key, a different key on every call', () async {
    final body = {
      'relationship': 'self',
      'full_name': 'Asha Test (synthetic)',
      'sex': 'female',
      'age_years': 30,
      'sms_consent': true,
      'whatsapp_consent': false,
      'consent_text_version': '2026-01',
    };
    await api.createSelfRegistration(body);
    await api.createSelfRegistration(body);
    expect(calls, hasLength(2));
    for (final c in calls) {
      expect([c.method, c.path], ['POST', '/v1/engagement/me/profiles/self-registrations']);
      expect(c.body, body);
      expect(header(c, 'Idempotency-Key'), matches(idemPattern));
    }
    expect(header(calls[0], 'Idempotency-Key'), isNot(header(calls[1], 'Idempotency-Key')), reason: 'a retry after `failed` is a new request');
  });

  test('E17 GET /v1/engagement/me/profiles/self-registrations/{id}', () async {
    answer = selfReg(status: 'created', profileId: newProfileId);
    final out = await api.getSelfRegistration(regId);
    expect([calls.single.method, calls.single.path], ['GET', '/v1/engagement/me/profiles/self-registrations/$regId']);
    expect(calls.single.body, isNull);
    expect((out as Map)['profile_id'], newProfileId);
  });

  test('E18 PATCH /v1/engagement/me/profiles/{id} {relationship}; If-Match is the quoted version of the profile (version 3 -> "3")', () async {
    await api.updateMyProfile(profileId: pidChild, relationship: 'parent', version: 3);
    final c = calls.single;
    expect([c.method, c.path], ['PATCH', '/v1/engagement/me/profiles/$pidChild']);
    expect(c.body, {'relationship': 'parent'});
    expect(header(c, 'If-Match'), '"3"');
  });

  test('E19 POST /v1/engagement/me/profiles/{id}/remove, no body; 204 (null answer) is fine; If-Match is the quoted version (version 12 -> "12")', () async {
    answer = null;
    await api.removeMyProfile(profileId: pidChild, version: 12);
    final c = calls.single;
    expect([c.method, c.path], ['POST', '/v1/engagement/me/profiles/$pidChild/remove']);
    expect(c.body, isNull);
    expect(header(c, 'If-Match'), '"12"');
  });

  test('errors are not swallowed: LimsException keeps its code on every call', () async {
    answer = LimsException(LimsErrorCodes.engagementLinkCodeInvalid);
    Future<void> code(Future<Object?> f) async {
      try {
        await f;
        fail('expected LimsException');
      } on LimsException catch (e) {
        expect(e.code, LimsErrorCodes.engagementLinkCodeInvalid);
      }
    }

    await code(api.listMyProfiles());
    await code(api.redeemLinkCode(code: 'ABCDEFGHJK'));
    await code(api.redeemReportLink(linkUrl: 'https://portal.invalid/r/x'));
    await code(api.createSelfRegistration({}));
    await code(api.getSelfRegistration(regId));
    await code(api.updateMyProfile(profileId: pidChild, relationship: 'other', version: 1));
    await code(api.removeMyProfile(profileId: pidChild, version: 1).then((_) => null));
  });

  test('the secret inputs (code, report link) travel only in the body — never in the path or query', () async {
    await api.redeemLinkCode(code: 'ABCDEFGHJK');
    await api.redeemReportLink(linkUrl: 'https://portal.invalid/r/SECRETTOKEN');
    for (final c in calls) {
      expect(c.path, isNot(contains('ABCDEFGHJK')));
      expect(c.path, isNot(contains('SECRETTOKEN')));
      expect(c.query ?? {}, isEmpty);
    }
  });
}
