// Providers and wire parsing for A20 and the A5 bell (E45, E46; E13 for names). Parsing is strict: a body that is not the contract's shape is `common.internal`.
// US-EN-11.1: the wire carries ids only; nothing is stored here, every value lives in provider state for as long as a screen watches it.
// US-EN-11.2: no push. The inbox is read on open, on resume and on pull-to-refresh, never by a timer.
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';

import '../../app/providers.dart';
import '../profiles/profiles_providers.dart';
import 'notifications_api.dart';

final notificationsApiProvider = Provider<NotificationsApi>((ref) => TransportNotificationsApi(transport: ref.watch(transportProvider)));

/// One Notification of E45: ids only (kind, entity, profile link, route). The row text is local, never from the wire.
class NotificationItem {
  const NotificationItem({required this.id, required this.kind, required this.createdAt, this.entityType, this.entityId, this.profileId, this.routeId, this.readAt});

  final String id;
  final String kind;
  final String? entityType;
  final String? entityId;
  final String? profileId; // the profile (link) id of E13, never a patient id
  final String? routeId;
  final String createdAt;
  final String? readAt;

  bool get isUnread => readAt == null;
}

LimsException _bad() => LimsException(LimsErrorCodes.commonInternal);
String? _opt(Object? v) => v is String ? v : null;

List<NotificationItem> parseNotifications(Object? json) {
  final data = json is Map ? json['data'] : null;
  if (data is! List) throw _bad();
  return [
    for (final e in data)
      if (e is Map && e['id'] is String && e['kind'] is String && e['created_at'] is String)
        NotificationItem(
          id: e['id'] as String,
          kind: e['kind'] as String,
          createdAt: e['created_at'] as String,
          entityType: _opt(e['entity_type']),
          entityId: _opt(e['entity_id']),
          profileId: _opt(e['profile_id']),
          routeId: _opt(e['route_id']),
          readAt: _opt(e['read_at']),
        )
      else
        throw _bad(),
  ];
}

// Riverpod's automatic retry is off so an error shows at once; the user's [Retry] invalidates.
/// A20: the first page of E45 (newest first).
final notificationsProvider = FutureProvider.autoDispose<List<NotificationItem>>(
  (ref) async => parseNotifications(await ref.watch(notificationsApiProvider).listMyNotifications()),
  retry: (_, __) => null,
);

/// A5 bell: count of the FIRST page of E45 with unread_only=true (the screen caps it at "9+").
final unreadCountProvider = FutureProvider.autoDispose<int>(
  (ref) async => parseNotifications(await ref.watch(notificationsApiProvider).listMyNotifications(unreadOnly: true)).length,
  retry: (_, __) => null,
);

/// profile id -> display name from the app's own profile list (E13). A failed E13 is an empty map: rows then render without names.
final profileNamesProvider = FutureProvider.autoDispose<Map<String, String>>((ref) async {
  try {
    final list = parseProfileList(await ref.watch(profilesApiProvider).listMyProfiles());
    return {for (final p in list.profiles) p.id: p.name};
  } catch (_) {
    return const <String, String>{};
  }
}, retry: (_, __) => null);

/// Calls [onResume] when the app comes back to the foreground (the only background-to-foreground refresh trigger: no push, no timer).
class RefreshOnResume extends StatefulWidget {
  const RefreshOnResume({super.key, required this.onResume, required this.child});

  final VoidCallback onResume;
  final Widget child;

  @override
  State<RefreshOnResume> createState() => _RefreshOnResumeState();
}

class _RefreshOnResumeState extends State<RefreshOnResume> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) widget.onResume();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
