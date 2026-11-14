// T-L6 test support: fake ProfilesApi (E13-E19 wire JSON as plain maps), fake app config (E1), host + pump helpers.
// Synthetic data only (tenant "Synthetic Lab Alpha", names marked "(synthetic)").
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes) — all under apps/patient_app/lib/features/profiles/:
//   profiles_api.dart        abstract interface class ProfilesApi {
//                              Future<Object?> listMyProfiles();                                        // E13 GET /v1/engagement/me/profiles -> {data, pending, paused_count}
//                              Future<Object?> redeemLinkCode({required String code});                  // E14 -> Profile (201/200)
//                              Future<Object?> redeemReportLink({required String linkUrl});             // E15 -> Profile (201/200)
//                              Future<Object?> createSelfRegistration(Map<String, Object?> body);       // E16 -> SelfRegistration (202)
//                              Future<Object?> getSelfRegistration(String id);                          // E17
//                              Future<Object?> updateMyProfile({required String profileId, required String relationship, required int version}); // E18 -> Profile; If-Match: "<version>" (LD-164)
//                              Future<void> removeMyProfile({required String profileId, required int version});               // E19 -> 204; If-Match: "<version>" (LD-164)
//                            }  Each returns the decoded wire JSON of contracts/openapi/engagement.yaml and throws LimsException.
//                            TransportProfilesApi({required PatientTransport transport}) sends the Idempotency-Key header (E14/E15/E16, fresh per call).
//   profiles_providers.dart  profilesApiProvider (Provider<ProfilesApi>). A6/A9 read the app config (consent.text_version / consent.text)
//                            through the EXISTING patientAuthApiProvider.getAppConfig() (E1) — no new config endpoint.
//   profiles_screen.dart     ProfilesScreen({super.key, this.onProfileAdded})        A6;  onProfileAdded: void Function(String profileId)?
//   link_code_screen.dart    LinkCodeScreen({super.key, this.onAdded})               A7;  onAdded: void Function(String profileId)?
//   report_link_screen.dart  ReportLinkScreen({super.key, this.onAdded})             A8
//   register_screen.dart     RegisterScreen({super.key, this.onCreated})             A9;  onCreated: void Function(String profileId)?
//   A6 pushes A7/A8/A9 with Navigator (MaterialPageRoute) and forwards onProfileAdded; every screen is a Riverpod consumer.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/auth/auth_providers.dart';
import 'package:patient_app/features/auth/patient_auth_api.dart';
import 'package:patient_app/features/profiles/profiles_api.dart';
import 'package:patient_app/features/profiles/profiles_providers.dart';

import 'auth_fakes.dart' show alphaFlavour;

const kCrockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const pidSelf = '01950c16-0000-7000-8000-0000000000a1';
const pidChild = '01950c16-0000-7000-8000-0000000000a2';
const pidReport = '01950c16-0000-7000-8000-0000000000a3';
const regId = '01950c16-0000-7000-8000-0000000000b1';
const newProfileId = '01950c16-0000-7000-8000-0000000000c1';

Map<String, Object?> profile({String id = pidSelf, String name = 'Asha Test (synthetic)', String rel = 'self', String method = 'link_code', String status = 'active', String? historyFrom, int version = 1}) => {
      'profile_id': id,
      'display_name': name,
      'relationship': rel,
      'method': method,
      'status': status,
      'version': version, // LD-164: Profile.version (integer, minimum 1, required) is the E18/E19 If-Match value
      if (historyFrom != null) 'history_from': historyFrom,
    };

Map<String, Object?> selfReg({String id = regId, String rel = 'self', String status = 'queued', String? failureCode, String? profileId}) =>
    {'id': id, 'relationship': rel, 'status': status, if (failureCode != null) 'failure_code': failureCode, if (profileId != null) 'profile_id': profileId};

Map<String, Object?> listBody({List<Map<String, Object?>> data = const [], List<Map<String, Object?>> pending = const [], int paused = 0}) =>
    {'data': data, 'pending': pending, 'paused_count': paused};

Map<String, Object?> configBody({String? textVersion = '2026-01', String text = 'Synthetic consent text.'}) => {
      'features': {'app': true, 'bookings': true, 'home_collection': false, 'payments': false, 'membership': false, 'enquiries': false, 'smart_report': false},
      'min_app_version': {'android': '1.0.0', 'ios': '1.0.0'},
      'consent': textVersion == null ? <String, Object?>{} : {'text_version': textVersion, 'text': text},
      'gateways': <String>[],
      'allowed_phone_prefixes': ['+999'],
      'calendar_display': 'AD',
      'timezone': 'Asia/Kathmandu',
      'order_poll_seconds': 30,
    };

class FakeProfilesApi implements ProfilesApi {
  Future<Object?> Function(int call) onList = (_) async => listBody();
  Future<Object?> Function(String code)? onRedeemCode;
  Future<Object?> Function(String url)? onRedeemReport;
  Future<Object?> Function(Map<String, Object?> body, int call)? onCreate;
  Future<Object?> Function(String id, int call)? onGetReg;
  Future<Object?> Function(String id, String rel)? onUpdate;
  Future<void> Function(String id)? onRemove;

  int listCalls = 0, createCalls = 0, getRegCalls = 0;
  final redeemCodes = <String>[];
  final redeemUrls = <String>[];
  final created = <Map<String, Object?>>[];
  final updates = <({String id, String rel})>[];
  final removed = <String>[];
  final updateVersions = <int>[]; // version sent with each E18, parallel to `updates`
  final removeVersions = <int>[]; // version sent with each E19, parallel to `removed`

  @override
  Future<Object?> listMyProfiles() => onList(++listCalls);

  @override
  Future<Object?> redeemLinkCode({required String code}) {
    redeemCodes.add(code);
    return (onRedeemCode ?? (_) async => profile(id: newProfileId))(code);
  }

  @override
  Future<Object?> redeemReportLink({required String linkUrl}) {
    redeemUrls.add(linkUrl);
    return (onRedeemReport ?? (_) async => profile(id: newProfileId, method: 'report_link'))(linkUrl);
  }

  @override
  Future<Object?> createSelfRegistration(Map<String, Object?> body) {
    created.add(body);
    return (onCreate ?? (_, __) async => selfReg())(body, ++createCalls);
  }

  @override
  Future<Object?> getSelfRegistration(String id) => (onGetReg ?? (_, __) async => selfReg(status: 'created', profileId: newProfileId))(id, ++getRegCalls);

  @override
  Future<Object?> updateMyProfile({required String profileId, required String relationship, required int version}) {
    updates.add((id: profileId, rel: relationship));
    updateVersions.add(version);
    return (onUpdate ?? (id, rel) async => profile(id: id, rel: rel))(profileId, relationship);
  }

  @override
  Future<void> removeMyProfile({required String profileId, required int version}) async {
    removed.add(profileId);
    removeVersions.add(version);
    await onRemove?.call(profileId);
  }
}

/// Only E1 is used by the profile screens; the other pre-auth calls must never be made from them.
class FakeConfigApi implements PatientAuthApi {
  FakeConfigApi([Object? Function()? body]) : _body = body ?? (() => configBody());
  final Object? Function() _body;
  int configCalls = 0;
  Future<Object?>? hold;

  @override
  Future<Object?> getAppConfig() async {
    configCalls++;
    if (hold != null) await hold;
    final b = _body();
    if (b is Exception) throw b;
    return b;
  }

  @override
  Future<Object?> requestOtp({required String phoneE164}) => throw UnimplementedError('A6-A9 never call E2');

  @override
  Future<Object?> verifyOtp({required String challengeToken, required String code}) => throw UnimplementedError('A6-A9 never call E3');
}

List<Override> overrides(FakeProfilesApi api, {FakeConfigApi? config}) => [
      profilesApiProvider.overrideWithValue(api),
      patientAuthApiProvider.overrideWithValue(config ?? FakeConfigApi()),
      flavourProvider.overrideWithValue(alphaFlavour()),
    ];

Widget host(Widget screen, FakeProfilesApi api, {FakeConfigApi? config}) =>
    ProviderScope(overrides: overrides(api, config: config), child: MaterialApp(home: screen));

/// Settles futures that resolve in microtasks; never pumps long enough to fire the A9 poll timer.
Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 4; i++) {
    await t.pump();
  }
}

/// All primary (filled) buttons on screen — LD-140 says there is one per page.
Finder primaryButtons() => find.byType(FilledButton);

LimsException invalidCode({String? detail}) => LimsException(LimsErrorCodes.engagementLinkCodeInvalid, safeDetail: detail);

const kErrIcon = Icons.error_outline;

const copyInvalid = "This code didn't work. Check it or ask the lab for a new one.";
const copyTooMany = 'Too many tries. Try again in an hour.';
const copyLimit = 'You have the maximum number of profiles.';
