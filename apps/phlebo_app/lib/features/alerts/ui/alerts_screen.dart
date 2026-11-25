// Alerts tab: changes from the centre found at the last sync, grouped by day. No push: the list refreshes with the sync.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/date_labels.dart';
import '../../../ui/phlebo_kit.dart';
import '../domain/alert_models.dart';

(IconData, String) alertLook(AlertKind k) => switch (k) {
      AlertKind.assigned => (Icons.assignment_ind_outlined, 'info'),
      AlertKind.changed => (Icons.swap_vert, 'neutral'),
      AlertKind.cancelled => (Icons.block, 'danger'),
      AlertKind.recollection => (Icons.replay, 'warning'),
      AlertKind.message => (Icons.chat_bubble_outline, 'info'),
      AlertKind.handover => (Icons.inventory_2_outlined, 'warning'),
      AlertKind.sync => (Icons.sync_problem, 'warning'),
      AlertKind.wipe => (Icons.phonelink_erase, 'danger'),
    };

class AlertsScreen extends StatelessWidget {
  const AlertsScreen({super.key, required this.alerts, required this.now, required this.onOpen, this.onMarkAllRead, this.offline = false});

  final List<PhleboAlert> alerts;
  final DateTime now;
  final ValueChanged<PhleboAlert> onOpen;
  final VoidCallback? onMarkAllRead;
  final bool offline;

  @override
  Widget build(BuildContext context) {
    final sorted = [...alerts]..sort((a, b) => b.at.compareTo(a.at));
    final unread = sorted.where((a) => a.unread).length;
    final groups = <String, List<PhleboAlert>>{};
    for (final a in sorted) {
      groups.putIfAbsent(relativeDay(a.at, now), () => []).add(a);
    }
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Alerts',
        offlineBanner: offline ? const LimsOfflineBanner(message: 'Offline. Alerts update when you reconnect.') : null,
        actions: [
          if (unread > 0 && onMarkAllRead != null)
            TextButton(onPressed: onMarkAllRead, style: TextButton.styleFrom(foregroundColor: LimsTokens.colorAccentFg), child: const Text('Mark all read')),
        ],
        body: sorted.isEmpty
            ? const LimsEmptyState(
                title: 'No alerts',
                message: 'New visits, changes and messages from the centre show up here after each sync.',
                icon: Icons.notifications_none,
              )
            : ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
                for (final e in groups.entries) ...[
                  PhleboSectionTitle(e.key, trailing: e.key == 'Today' && unread > 0 ? '$unread new' : null),
                  PhleboListCard(children: [for (final a in e.value) _AlertRow(alert: a, onOpen: onOpen)]),
                  const SizedBox(height: LimsTokens.space3),
                ],
              ]),
      ),
    );
  }
}

class _AlertRow extends StatelessWidget {
  const _AlertRow({required this.alert, required this.onOpen});

  final PhleboAlert alert;
  final ValueChanged<PhleboAlert> onOpen;

  @override
  Widget build(BuildContext context) {
    final (icon, tone) = alertLook(alert.kind);
    final t = Theme.of(context).textTheme;
    return Semantics(
      button: true,
      label: '${alert.unread ? 'New. ' : ''}${alert.title}. ${alert.body}',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => onOpen(alert),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: LimsTokens.touchTargetFlutter),
          child: Padding(
            padding: const EdgeInsets.all(LimsTokens.space4),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              PhleboIconTile(icon, tone: tone),
              const SizedBox(width: LimsTokens.space3),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(alert.title, style: t.titleSmall?.copyWith(fontWeight: alert.unread ? FontWeight.w700 : FontWeight.w500))),
                    Text(clock12(alert.at), style: t.labelSmall?.copyWith(color: LimsTokens.colorNeutral600)),
                  ]),
                  Text(alert.body, style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
                ]),
              ),
              if (alert.unread) ...[
                const SizedBox(width: LimsTokens.space2),
                const Padding(padding: EdgeInsets.only(top: LimsTokens.space1), child: Icon(Icons.circle, size: LimsTokens.space2, color: LimsTokens.colorAccentDefault)),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}
