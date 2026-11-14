// T-N1 test support: fake EnquiriesApi (E48-E51 + T3b wire JSON as plain maps), wire builders, host + pump helpers. Synthetic data only.
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes) — all under apps/patient_app/lib/features/enquiries/:
//   enquiries_api.dart        abstract interface class EnquiriesApi {
//                               Future<Object?> listMyEnquiries({String? cursor, int? limit});                                              // E48 GET /v1/engagement/me/enquiries -> {data:[EnquirySummary], page}
//                               Future<Object?> createMyEnquiry({required String categoryCode, required String subject, required String message, String? profileId}); // E49 POST same path -> 201 Enquiry
//                               Future<Object?> getMyEnquiry({required String id});                                                         // E50 GET .../{id} -> Enquiry (messages[], version)
//                               Future<Object?> replyMyEnquiry({required String id, required String message, required int version});        // E51 POST .../{id}/messages {message}; If-Match "<version>" -> Enquiry
//                               Future<Object?> listMyCodedSet(String setName);                                                             // T3b GET /v1/engagement/me/coded-sets/{set_name} -> {data:[{code,display,sort_order}]}
//                             }  Each returns the decoded wire JSON of contracts/openapi/engagement.yaml and throws LimsException. TransportEnquiriesApi({required PatientTransport transport}):
//                             E49 and E51 send a fresh Idempotency-Key (x-idempotency: required); E48/E50/T3b send none; E51 sends If-Match as the quoted version, e.g. 4 -> `"4"`.
//   enquiries_providers.dart  enquiriesApiProvider (Provider<EnquiriesApi>).
//   enquiries_screen.dart     EnquiriesScreen({super.key, this.onOpen, this.onNew})  A22 list; onOpen: void Function(String enquiryId)?, onNew: VoidCallback?  (Riverpod consumer)
//   new_enquiry_screen.dart   NewEnquiryScreen({super.key, this.onCreated})          A22 new; onCreated: void Function(String enquiryId)?
//   enquiry_thread_screen.dart EnquiryThreadScreen({super.key, required this.enquiryId})  A22 thread
//   All three: LimsSecureScreen (PHI, 04-UI-UX §1) > LimsScaffold; profile names for "About" come from profilesApiProvider.listMyProfiles() (E13), profile ids on the wire are link ids.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/features/enquiries/enquiries_api.dart';
import 'package:patient_app/features/enquiries/enquiries_providers.dart';
import 'package:patient_app/features/profiles/profiles_providers.dart';

import 'profiles_fakes.dart';

const eSelf = pidSelf; // profile "Asha Test (synthetic)"
String enqId(int n) => '01950c16-0000-7000-8000-${(0x3000 + n).toRadixString(16).padLeft(12, '0')}';

Map<String, Object?> msg(String kind, String body, {String at = '2026-11-04T10:00:00.000Z'}) => {'author_kind': kind, 'body': body, 'created_at': at};

Map<String, Object?> summaryWire({required String id, String category = 'report', String subject = 'Where is my report? (synthetic)', String status = 'open', String? profileId, String at = '2026-11-04T10:00:00.000Z', int version = 1}) =>
    {'id': id, 'category_code': category, 'subject': subject, 'status': status, if (profileId != null) 'profile_id': profileId, 'last_message_at': at, 'version': version};

Map<String, Object?> threadWire({required String id, String status = 'open', int version = 3, List<Map<String, Object?>>? messages, String subject = 'Where is my report? (synthetic)', String? profileId}) => {
      ...summaryWire(id: id, status: status, version: version, subject: subject, profileId: profileId),
      'messages': messages ?? [msg('patient', 'Synthetic question text.')],
    };

Map<String, Object?> pageOf(List<Map<String, Object?>> data, {String? next, int limit = 50}) => {'data': data, 'page': {'limit': limit, if (next != null) 'next_cursor': next}};
const categoriesWire = {'data': [{'code': 'booking', 'display': 'Booking', 'sort_order': 1}, {'code': 'report', 'display': 'Report', 'sort_order': 2}, {'code': 'other', 'display': 'Other', 'sort_order': 9}]};

typedef Created = ({String category, String subject, String message, String? profileId});
typedef Replied = ({String id, String message, int version});

class FakeEnquiriesApi implements EnquiriesApi {
  FakeEnquiriesApi({List<Map<String, Object?>>? threads}) : threads = {for (final t in threads ?? <Map<String, Object?>>[]) t['id'] as String: Map.of(t)};

  final Map<String, Map<String, Object?>> threads;
  Future<Object?> Function(int call)? onListOverride;
  Future<Object?> Function(Created c)? onCreateOverride;
  Future<Object?> Function(Replied r, int call)? onReplyOverride;
  Future<Object?> Function(String id, int call)? onGetOverride;
  Future<void>? hold;

  int listCalls = 0, getCalls = 0, replyCalls = 0;
  final created = <Created>[];
  final replied = <Replied>[];
  final codedSets = <String>[];

  @override
  Future<Object?> listMyEnquiries({String? cursor, int? limit}) async {
    final call = ++listCalls;
    if (hold != null) await hold;
    if (onListOverride != null) return onListOverride!(call);
    return pageOf([for (final t in threads.values) {...t}..remove('messages')]);
  }

  @override
  Future<Object?> createMyEnquiry({required String categoryCode, required String subject, required String message, String? profileId}) async {
    final c = (category: categoryCode, subject: subject, message: message, profileId: profileId);
    created.add(c);
    if (onCreateOverride != null) return onCreateOverride!(c);
    final id = enqId(100 + created.length);
    final t = threadWire(id: id, version: 1, subject: subject, messages: [msg('patient', message)], profileId: profileId)..['category_code'] = categoryCode;
    threads[id] = t;
    return t;
  }

  @override
  Future<Object?> getMyEnquiry({required String id}) async {
    final call = ++getCalls;
    if (hold != null) await hold;
    if (onGetOverride != null) return onGetOverride!(id, call);
    final t = threads[id];
    if (t == null) throw LimsException('common.not_found');
    return {...t};
  }

  @override
  Future<Object?> replyMyEnquiry({required String id, required String message, required int version}) async {
    final call = ++replyCalls;
    final r = (id: id, message: message, version: version);
    replied.add(r);
    if (onReplyOverride != null) return onReplyOverride!(r, call);
    final t = threads[id];
    if (t == null) throw LimsException('common.not_found');
    if (t['status'] == 'closed') throw LimsException('engagement.enquiry_invalid_transition');
    if (t['version'] != version) throw LimsException('common.version_conflict');
    t['messages'] = [...(t['messages'] as List), msg('patient', message, at: '2026-11-05T04:15:00.000Z')];
    t['status'] = 'open';
    t['version'] = version + 1;
    return {...t};
  }

  @override
  Future<Object?> listMyCodedSet(String setName) async {
    codedSets.add(setName);
    return categoriesWire;
  }
}

FakeProfilesApi profilesFake() => FakeProfilesApi()..onList = (_) async => listBody(data: [profile(id: eSelf, name: 'Asha Test (synthetic)')]);

Widget hostWith(Widget screen, FakeEnquiriesApi api, {FakeProfilesApi? profiles}) => ProviderScope(
      overrides: [enquiriesApiProvider.overrideWithValue(api), profilesApiProvider.overrideWithValue(profiles ?? profilesFake())],
      child: MaterialApp(home: screen),
    );

Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 6; i++) {
    await t.pump(const Duration(milliseconds: 200));
  }
}
