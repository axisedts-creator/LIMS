// HC-T27 M2 Today's route (04-UI-UX §3.2). LD-140 (2026-11-13): lims_ui + tokens only, no hex, no pixel radii, no inline styles.
// Data and callbacks come from the app shell: this screen never reads the DB or the network (works in airplane mode).
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../outbox/domain/sync_summary.dart';
import '../../outbox/domain/time_labels.dart';
import '../../outbox/ui/status_pill.dart';
import '../../visit/ui/save_once.dart' show InlineNotice;
import '../domain/route_models.dart';

const _landmarkMax = 40;
const _cancelledNote = 'This visit was cancelled by the centre.';
const _emptyText = 'No visits assigned for today. Pull down to refresh.';
const _purgedText = 'Your list was cleared for security. Connect to the internet to download it again.';

(String, String, IconData) _status(String s) => switch (s) {
      'assigned' => ('neutral', 'To do', Icons.radio_button_unchecked),
      'in_progress' => ('info', 'In progress', Icons.timelapse),
      'completed' => ('success', 'Completed', Icons.check_circle_outline),
      'failed' => ('danger', 'Failed', Icons.error_outline),
      'cancelled' => ('neutral', 'Cancelled — do not visit', Icons.block),
      _ => ('neutral', s, Icons.help_outline_rounded),
    };

class RouteScreen extends StatefulWidget {
  const RouteScreen({
    super.key,
    required this.routeDate,
    required this.visits,
    required this.purged,
    this.offline = false,
    required this.sync,
    required this.onRefresh,
    required this.onOpenVisit,
    required this.onOpenHandover,
    required this.onOpenOutbox,
    required this.onOpenSettings,
    required this.onHelp,
  });

  final DateTime routeDate;
  final List<RouteVisit> visits;
  final bool purged;
  final bool offline;
  final SyncSummary sync;
  final Future<void> Function() onRefresh;
  final void Function(String visitId) onOpenVisit;
  final VoidCallback onOpenHandover;
  final VoidCallback onOpenOutbox;
  final VoidCallback onOpenSettings;
  final VoidCallback onHelp;

  @override
  State<RouteScreen> createState() => _RouteScreenState();
}

class _RouteScreenState extends State<RouteScreen> {
  bool _showCancelled = false;

  String _landmark(String s) => s.length > _landmarkMax ? '${s.substring(0, _landmarkMax)}…' : s;

  Widget _tile(BuildContext context, RouteVisit v) {
    final (tone, word, icon) = _status(v.status);
    final cancelled = v.status == 'cancelled';
    final t = Theme.of(context).textTheme;
    final tile = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      LimsListTile(
        leading: SizedBox(width: LimsTokens.space10, child: Text('${v.sequence}', style: t.titleMedium, textAlign: TextAlign.center)),
        title: v.patientName,
        subtitle: '${v.windowStart}–${v.windowEnd} · ${_landmark(v.landmark)}',
        onTap: () {
          if (cancelled) {
            setState(() => _showCancelled = true);
          } else {
            widget.onOpenVisit(v.visitId);
          }
        },
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(LimsTokens.space16, 0, LimsTokens.space4, LimsTokens.space2),
        child: Wrap(spacing: LimsTokens.space3, runSpacing: LimsTokens.space1, crossAxisAlignment: WrapCrossAlignment.center, children: [
          StatusPill(tone: tone, icon: icon, label: word),
          Text('${v.collectedTubes}/${v.expectedTubes} tubes', style: t.bodySmall),
        ]),
      ),
    ]);
    return cancelled ? Opacity(opacity: 0.6, child: tile) : tile;
  }

  @override
  Widget build(BuildContext context) {
    final visits = [...widget.visits]..sort((a, b) => a.sequence.compareTo(b.sequence));
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Today · ${formatDmy(widget.routeDate)}',
        offlineBanner: widget.offline ? const LimsOfflineBanner() : null,
        syncStatus: SyncChip(sync: widget.sync),
        actions: [
          Semantics(
            button: true,
            label: 'Help',
            child: SizedBox.square(
              dimension: LimsTokens.touchTargetFlutter,
              child: InkResponse(onTap: widget.onHelp, child: const Icon(Icons.help_outline)),
            ),
          ),
          PopupMenuButton<VoidCallback>(
            key: const ValueKey('route.menu'),
            tooltip: 'Menu',
            onSelected: (go) => go(),
            itemBuilder: (_) => [
              PopupMenuItem(value: widget.onOpenHandover, child: const Text('Handover')),
              PopupMenuItem(value: widget.onOpenOutbox, child: const Text('Outbox')),
              PopupMenuItem(value: widget.onOpenSettings, child: const Text('Settings')),
            ],
          ),
        ],
        body: RefreshIndicator(
          onRefresh: widget.onRefresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              if (_showCancelled && !widget.purged) const InlineNotice(tone: 'info', text: _cancelledNote),
              if (widget.purged)
                const LimsEmptyState(title: _purgedText, icon: Icons.lock_clock)
              else if (visits.isEmpty)
                const LimsEmptyState(title: _emptyText)
              else
                for (final v in visits) _tile(context, v),
            ],
          ),
        ),
      ),
    );
  }
}
