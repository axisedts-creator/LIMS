// PHLEBO-UI-FULL-1 B01: the day at a glance with one primary action. LD-140: lims_ui + tokens only; data and callbacks
// come from the app shell. "On my way", distances, age and sex have no contract and are not drawn.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../app/theme.dart';
import '../../outbox/domain/sync_summary.dart';
import '../../outbox/domain/time_labels.dart';
import '../../visit/domain/visit_models.dart' show ExpectedTube;
import '../data/day_reader.dart';

const _emptyText = 'No visits assigned for today. Pull down to refresh.';
const _purgedText = 'Your list was cleared for security. Connect to the internet to download it again.';
const _kindLabels = {'recollection': 'Recollection', 'revisit': 'Revisit'};

class TodayScreen extends StatelessWidget {
  const TodayScreen({
    super.key,
    required this.day,
    required this.today,
    required this.sync,
    required this.offline,
    required this.purged,
    required this.syncing,
    required this.onRefresh,
    required this.onOpenVisit,
    required this.onOpenHandover,
    required this.onOpenOutbox,
    required this.onOpenFullList,
    required this.onHelp,
    this.message,
  });

  final DayData day;
  final DateTime today;
  final SyncSummary sync;
  final bool offline, purged, syncing;
  final String? message;
  final Future<void> Function() onRefresh;
  final void Function(String visitId) onOpenVisit;
  final VoidCallback onOpenHandover, onOpenOutbox, onOpenFullList, onHelp;

  @override
  Widget build(BuildContext context) {
    final visits = day.visits.where((v) => v.row.status != 'cancelled').toList();
    final next = day.next;
    final upcoming = [for (final v in visits) if (v.open && v.id != next?.id) v];
    final finished = [for (final v in visits) if (v.done) v];
    final netLabel = sync.waiting > 0 ? '${sync.waiting} waiting' : (syncing ? 'Syncing' : (offline ? 'Offline' : 'Online'));
    final asOf = day.dataAsOf;

    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Today · ${formatDmy(day.routeDate ?? today)}',
        offlineBanner: !offline
            ? null
            : asOf == null
                ? const LimsOfflineBanner()
                : LimsOfflineBanner(message: 'Offline — showing data from ${formatHm(asOf)}'),
        actions: [
          Semantics(
            button: true,
            label: 'Outbox, $netLabel',
            excludeSemantics: true,
            child: InkWell(
              key: const ValueKey('today.net'),
              onTap: onOpenOutbox,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: LimsTokens.touchTargetFlutter),
                child: Center(child: Pill(netLabel, tone: sync.waiting > 0 || offline ? 'warning' : 'success')),
              ),
            ),
          ),
          Semantics(
            button: true,
            label: 'Help',
            child: SizedBox.square(
              dimension: LimsTokens.touchTargetFlutter,
              child: InkResponse(onTap: onHelp, child: const Icon(Icons.help_outline)),
            ),
          ),
        ],
        body: RefreshIndicator(
          onRefresh: onRefresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(LimsTokens.space4),
            children: [
              if (message != null) ...[NoticeCard(tone: 'warning', text: message!), const SizedBox(height: LimsTokens.space3)],
              if (day.routeDate == null && purged)
                const LimsEmptyState(title: _purgedText, icon: Icons.lock_clock)
              else if (day.routeDate == null && syncing)
                const LimsLoading()
              else if (visits.isEmpty)
                const LimsEmptyState(title: _emptyText, icon: Icons.event_available)
              else ...[
                _Summary(visits: visits),
                const SizedBox(height: LimsTokens.space3),
                if (next != null) _NextStop(visit: next, onOpen: () => onOpenVisit(next.id)),
                if (next == null)
                  LimsCard(
                    child: SizedBox(
                      width: double.infinity,
                      child: Column(children: [
                        const IconBadge(icon: Icons.check_circle_outline, tone: 'success'),
                        const SizedBox(height: LimsTokens.space2),
                        Text('All stops done for today', style: Theme.of(context).textTheme.titleMedium),
                        const Text('Hand the tubes to the centre.', textAlign: TextAlign.center),
                      ]),
                    ),
                  ),
              ],
              if (day.handoverTubes.isNotEmpty) ...[
                const SizedBox(height: LimsTokens.space3),
                LimsCard(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    LimsListTile(
                      leading: const IconBadge(icon: Icons.inventory_2_outlined, tone: 'warning'),
                      title: '${day.handoverTubes.length} ${day.handoverTubes.length == 1 ? 'tube' : 'tubes'} to hand over',
                      subtitle: 'Give them to the centre staff.',
                    ),
                    LimsButton(label: 'Hand over', secondary: true, onPressed: onOpenHandover),
                  ]),
                ),
              ],
              if (upcoming.isNotEmpty) ...[
                SectionHeader('Up next', trailing: '${upcoming.length}'),
                LimsCard(child: Column(children: [for (final v in upcoming) _row(v)])),
              ],
              if (finished.isNotEmpty) ...[
                SectionHeader('Completed', trailing: '${finished.length}'),
                LimsCard(child: Column(children: [for (final v in finished) _doneRow(v)])),
              ],
              if (day.visits.isNotEmpty) ...[
                const SizedBox(height: LimsTokens.space3),
                LimsButton(label: 'See full list', secondary: true, onPressed: onOpenFullList),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _row(DayVisit v) {
    final r = v.row;
    final kind = _kindLabels[v.kind];
    final tubes = '${r.expectedTubes} ${r.expectedTubes == 1 ? 'tube' : 'tubes'}';
    return LimsListTile(
      leading: Text(r.windowStart),
      title: r.patientName,
      subtitle: [if (kind != null) kind, tubes, if (r.landmark.isNotEmpty) r.landmark].join(' · '),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => onOpenVisit(v.id),
    );
  }

  Widget _doneRow(DayVisit v) {
    final r = v.row;
    final (tone, word) = r.status == 'failed' ? ('danger', 'Missed') : (v.partial ? ('warning', 'Partly collected') : ('success', 'Collected'));
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      LimsListTile(
        title: r.patientName,
        subtitle: '${r.windowStart}–${r.windowEnd}',
        leading: Icon(r.status == 'failed' ? Icons.cancel_outlined : Icons.check_circle_outline),
      ),
      Padding(padding: const EdgeInsets.only(left: LimsTokens.space16), child: Pill(word, tone: tone)),
    ]);
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.visits});

  final List<DayVisit> visits;

  @override
  Widget build(BuildContext context) {
    final collected = visits.where((v) => v.row.status == 'completed').length;
    final missed = visits.where((v) => v.row.status == 'failed').length;
    final left = visits.length - collected - missed;
    final t = Theme.of(context).textTheme;
    final white = t.titleLarge?.copyWith(color: LimsTokens.colorAccentFg);
    return HeroCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ProgressRing(done: collected + missed, total: visits.length),
          const SizedBox(width: LimsTokens.space4),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('$collected of ${visits.length} collected', style: white),
              Text('$missed missed ${missed == 1 ? 'visit' : 'visits'} · ${left == 0 ? 'Day complete' : '$left ${left == 1 ? 'stop' : 'stops'} to go'}'),
            ]),
          ),
        ]),
        const SizedBox(height: LimsTokens.space3),
        ExcludeSemantics(
          child: Row(children: [
            for (final v in visits) ...[
              Expanded(
                child: Divider(
                  thickness: LimsTokens.space1,
                  color: switch (v.row.status) {
                    'completed' => LimsTokens.colorAccentHighlight,
                    'failed' => LimsTokens.colorToneDangerBorder,
                    'in_progress' => LimsTokens.colorAccentFg,
                    _ => LimsTokens.colorNeutral500,
                  },
                ),
              ),
              const SizedBox(width: LimsTokens.space1),
            ],
          ]),
        ),
        Text('${visits.first.row.windowStart} – ${visits.last.row.windowEnd}'),
      ]),
    );
  }
}

class _NextStop extends StatelessWidget {
  const _NextStop({required this.visit, required this.onOpen});

  final DayVisit visit;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final r = visit.row;
    final t = Theme.of(context).textTheme;
    final containers = {for (final tube in visit.view?.tubes ?? const <ExpectedTube>[]) tube.container.isEmpty ? tube.typeDisplay : tube.container};
    final kind = _kindLabels[visit.kind];
    return LimsCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('NEXT STOP · ${r.windowStart}', style: t.labelMedium?.copyWith(color: LimsTokens.colorAccentDefault)),
        const SizedBox(height: LimsTokens.space2),
        Row(children: [
          PersonAvatar(name: r.patientName),
          const SizedBox(width: LimsTokens.space3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(r.patientName, style: t.titleLarge),
              if (r.landmark.isNotEmpty) Text(r.landmark, maxLines: 2, overflow: TextOverflow.ellipsis, style: t.bodySmall),
            ]),
          ),
        ]),
        const SizedBox(height: LimsTokens.space3),
        Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space2, children: [
          for (final c in containers) Pill(c),
          if (kind != null) Pill(kind, tone: 'warning'),
        ]),
        if (visit.note != null) ...[const SizedBox(height: LimsTokens.space2), Text(visit.note!, style: t.bodySmall)],
        const SizedBox(height: LimsTokens.space3),
        LimsButton(label: visit.started ? 'Continue visit' : 'Open visit', onPressed: onOpen),
      ]),
    );
  }
}
