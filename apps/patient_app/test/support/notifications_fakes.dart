// T-P5 test support: fake NotificationsApi (E45/E46 wire JSON as plain maps), wire builders, host + pump helpers. Synthetic data only.
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes) — all under apps/patient_app/lib/features/notifications/:
//   notifications_api.dart        abstract interface class NotificationsApi {
//                                   Future<Object?> listMyNotifications({bool unreadOnly = false, String? cursor, int? limit}); // E45 GET /v1/engagement/me/notifications -> {data:[Notification], page:{limit,next_cursor?}}
//                                   Future<Object?> markMyNotificationsRead({required List<String> ids});                        // E46 POST .../bulk-mark-read {ids} -> {results:[{id, outcome: updated|not_found}]}
//                                 }  Each returns the decoded wire JSON of contracts/openapi/engagement.yaml and throws LimsException.
//                                 TransportNotificationsApi({required PatientTransport transport}); `unread_only` is sent only when requested (true), `cursor`/`limit` only when given.
//   notifications_providers.dart  notificationsApiProvider (Provider<NotificationsApi>); NotificationItem { id, kind, entityType?, entityId?, profileId?, routeId?, createdAt, readAt? }.
//   notifications_screen.dart     NotificationsScreen({super.key, this.onOpen})   A20;  onOpen: void Function(NotificationItem)?   a Riverpod consumer.
//                                 Names of profiles come from the app's own profile list: profilesApiProvider.listMyProfiles() (E13), joined on profile_id (02-TRD §4.9); the row text is
//                                 rendered from LOCAL message keys (04-UI-UX A20), never from the wire; booking numbers are never taken from the notification row.
//   notification_bell.dart        NotificationBell({super.key, this.onPressed})   bell + unread badge for the A5 app bar (04-UI-UX §1.1): E45 unread_only=true, count of the FIRST page, capped "9+".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/features/notifications/notifications_api.dart';
import 'package:patient_app/features/notifications/notifications_providers.dart';
import 'package:patient_app/features/profiles/profiles_providers.dart';

import 'profiles_fakes.dart';

const nSelf = pidSelf; // profile "Asha Test (synthetic)"
const nChild = pidChild; // profile "Ravi Test (synthetic)"
const nUnknownProfile = '01950c16-0000-7000-8000-0000000000ff';
String nid(int n) => '01950c16-0000-7000-8000-${(0x1000 + n).toRadixString(16).padLeft(12, '0')}';
String eid(int n) => '01950c16-0000-7000-8000-${(0x2000 + n).toRadixString(16).padLeft(12, '0')}';

Map<String, Object?> nWire({
  required String id,
  String kind = 'report_ready',
  String? entityType = 'order',
  String? entityId,
  String? profileId = nSelf,
  String? routeId = 'patient_app.report',
  String createdAt = '2026-11-04T10:00:00.000Z',
  String? readAt,
  Map<String, Object?> extra = const {},
}) =>
    {
      'id': id,
      'kind': kind,
      if (entityType != null) 'entity_type': entityType,
      if (entityId != null) 'entity_id': entityId,
      if (profileId != null) 'profile_id': profileId,
      if (routeId != null) 'route_id': routeId,
      'created_at': createdAt,
      if (readAt != null) 'read_at': readAt,
      ...extra,
    };

Map<String, Object?> pageOf(List<Map<String, Object?>> data, {String? next, int limit = 50}) => {'data': data, 'page': {'limit': limit, if (next != null) 'next_cursor': next}};

/// In-memory inbox behind E45/E46: list honours `unreadOnly`; mark sets read_at for ids it owns and answers not_found for the rest (07-SECURITY §6.5).
class FakeNotificationsApi implements NotificationsApi {
  FakeNotificationsApi(List<Map<String, Object?>> items) : items = [for (final i in items) Map.of(i)];

  final List<Map<String, Object?>> items;
  Future<Object?> Function(int call)? onListOverride;
  Future<Object?> Function(List<String> ids, int call)? onMarkOverride;
  Future<void>? hold;

  int listCalls = 0, markCalls = 0;
  final unreadOnlyArgs = <bool>[];
  final cursors = <String?>[];
  final marked = <List<String>>[];

  @override
  Future<Object?> listMyNotifications({bool unreadOnly = false, String? cursor, int? limit}) async {
    final call = ++listCalls;
    unreadOnlyArgs.add(unreadOnly);
    cursors.add(cursor);
    if (hold != null) await hold;
    if (onListOverride != null) return onListOverride!(call);
    return pageOf([for (final i in items) if (!unreadOnly || i['read_at'] == null) Map.of(i)]);
  }

  @override
  Future<Object?> markMyNotificationsRead({required List<String> ids}) async {
    final call = ++markCalls;
    marked.add(List.of(ids));
    if (onMarkOverride != null) return onMarkOverride!(ids, call);
    final own = {for (final i in items) i['id'] as String: i};
    return {
      'results': [
        for (final id in ids)
          if (own.containsKey(id)) () {
            own[id]!['read_at'] ??= '2026-11-05T04:15:00.000Z';
            return {'id': id, 'outcome': 'updated'};
          }() else {'id': id, 'outcome': 'not_found'},
      ],
    };
  }
}

FakeProfilesApi profilesFake({bool fail = false}) => FakeProfilesApi()
  ..onList = (_) async => fail
      ? throw Exception('profiles unavailable')
      : listBody(data: [profile(id: nSelf, name: 'Asha Test (synthetic)'), profile(id: nChild, name: 'Ravi Test (synthetic)', rel: 'child')]);

Widget hostWith(Widget screen, FakeNotificationsApi api, {FakeProfilesApi? profiles}) => ProviderScope(
      overrides: [notificationsApiProvider.overrideWithValue(api), profilesApiProvider.overrideWithValue(profiles ?? profilesFake())],
      child: MaterialApp(home: screen),
    );

Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 6; i++) {
    await t.pump(const Duration(milliseconds: 200));
  }
}
