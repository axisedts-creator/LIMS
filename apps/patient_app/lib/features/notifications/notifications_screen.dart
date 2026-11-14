// A20 Notifications (04-UI-UX A20; 03-APP-FLOW §10.1; US-EN-11.1-11.3). One LimsListTile per notification in API order (newest first). The row text comes from LOCAL message
// keys by kind (patient_app.notification.<kind>) with the profile name taken from the app's own E13 list; nothing on the wire is rendered as text, and booking numbers are never
// taken from the row (the app resolves them itself when [onOpen] navigates). No push: refresh on open, on resume and on pull-to-refresh, never by timer.
// "Mark all read" sends the visible unread ids in one E46 call; a per-id not_found is not an error. LD-140: lims_ui widgets and tokens only; one primary button per page.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import 'notifications_providers.dart';

/// kind -> (text before the optional " for {profile}", icon). Texts are the 04-UI-UX A20 keys; booking kinds have no number here.
const _kinds = <String, (String, IconData, bool)>{
  'report_ready': ('A new report is ready', Icons.description_outlined, true),
  'sample_recollection': ('The lab needs a new sample', Icons.science_outlined, true),
  'booking_confirmed': ('Booking confirmed', Icons.event_available_outlined, false),
  'booking_cancelled': ('Booking cancelled', Icons.event_busy_outlined, false),
  'booking_reminder': ('Reminder: booking soon', Icons.alarm_outlined, false),
  'payment_completed': ('Payment received', Icons.payments_outlined, false),
  'follow_up_reminder': ('Time for a follow-up test', Icons.event_repeat_outlined, true),
  'enquiry_reply': ('The lab replied to your message', Icons.chat_bubble_outline, false),
  'profile_paused': ('Access to a profile is paused', Icons.pause_circle_outline, false),
};
const _unknown = ('You have a new notification', Icons.notifications_none, false);

String _text(NotificationItem n, Map<String, String> names) {
  final (text, _, withProfile) = _kinds[n.kind] ?? _unknown;
  final name = n.profileId == null ? null : names[n.profileId];
  return withProfile && name != null ? '$text for $name' : text;
}

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key, this.onOpen});

  /// Called with the tapped row; the app resolves its own destination from kind / entity / route ids.
  final void Function(NotificationItem)? onOpen;

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  bool _marking = false;

  Future<void> _markAll(List<NotificationItem> items) async {
    if (_marking) return;
    final ids = [for (final i in items) if (i.isUnread) i.id];
    if (ids.isEmpty) return;
    _marking = true;
    try {
      await ref.read(notificationsApiProvider).markMyNotificationsRead(ids: ids);
    } catch (_) {
      // the list stays as it is; the user can try again
    } finally {
      _marking = false;
      ref.invalidate(notificationsProvider);
      ref.invalidate(unreadCountProvider);
    }
  }

  Future<void> _pull() async {
    try {
      ref.invalidate(notificationsProvider);
      await ref.read(notificationsProvider.future);
    } catch (_) {
      // the error state shows on the next build
    }
  }

  @override
  Widget build(BuildContext context) {
    final inbox = ref.watch(notificationsProvider);
    final names = ref.watch(profileNamesProvider).value ?? const <String, String>{};
    final items = inbox.value;
    return RefreshOnResume(
      onResume: () {
        ref.invalidate(notificationsProvider);
        ref.invalidate(profileNamesProvider);
      },
      child: LimsScaffold(
        title: 'Notifications',
        actions: [if (items != null && items.any((i) => i.isUnread)) LimsButton(label: 'Mark all read', secondary: true, onPressed: () => _markAll(items))],
        body: inbox.when(
          loading: () => const LimsLoading(),
          error: (_, __) => LimsErrorState(
            title: 'Could not load your notifications',
            message: 'Check your connection and try again.',
            onRetry: () => ref.invalidate(notificationsProvider),
          ),
          data: (list) => list.isEmpty
              ? const LimsEmptyState(title: "You're all caught up", message: 'New updates will show here.')
              : RefreshIndicator(
                  onRefresh: _pull,
                  child: ListView.separated(
                    physics: const AlwaysScrollableScrollPhysics(),
                    itemCount: list.length,
                    separatorBuilder: (_, __) => const Divider(height: LimsTokens.space0),
                    itemBuilder: (_, i) => _Row(list[i], _text(list[i], names), widget.onOpen),
                  ),
                ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.n, this.text, this.onOpen);

  final NotificationItem n;
  final String text;
  final void Function(NotificationItem)? onOpen;

  @override
  Widget build(BuildContext context) => LimsListTile(
        leading: Icon((_kinds[n.kind] ?? _unknown).$2),
        title: text,
        trailing: n.isUnread ? const LimsStatusChip(kind: 'generic', status: 'unread', label: 'New', tone: 'info') : null,
        onTap: () => onOpen?.call(n),
      );
}
