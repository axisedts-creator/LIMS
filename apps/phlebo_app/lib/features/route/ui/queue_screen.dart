// Today home (board M5 "Queue" + wireframe pack Home rhythm): day progress hero, the next stop with its one primary action,
// the rest of the day, what is done, and a handover prompt. The complete ordered list (with cancelled stubs) is RouteScreen,
// opened from "See full list". Data and callbacks come from the app shell: this screen never reads the DB or the network.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../../../ui/visit_labels.dart';
import '../../outbox/domain/sync_summary.dart';
import '../../outbox/domain/time_labels.dart';
import '../domain/route_models.dart';

const _emptyText = 'No visits assigned for today. Pull down to refresh.';
const _purgedText = 'Your list was cleared for security. Connect to the internet to download it again.';
const _cancelledNote = 'This visit was cancelled by the centre.';

class QueueScreen extends StatefulWidget {
  const QueueScreen({
    super.key,
    required this.routeDate,
    required this.visits,
    required this.purged,
    required this.sync,
    required this.onRefresh,
    required this.onOpenVisit,
    required this.onOpenAll,
    required this.onOpenOutbox,
    required this.onHelp,
    this.onStartTravel,
    this.onOpenHandover,
    this.handoverTubes = 0,
    this.offline = false,
    this.dataAsOf,
    this.loading = false,
  });

  final DateTime routeDate;
  final List<RouteVisit> visits;
  final bool purged;
  final SyncSummary sync;
  final Future<void> Function() onRefresh;
  final void Function(String visitId) onOpenVisit;
  final VoidCallback onOpenAll;
  final VoidCallback onOpenOutbox;
  final VoidCallback onHelp;

  /// "On my way": starts live location sharing and tells the patient. Null = the host has no travel step (CTA says "Open visit").
  final void Function(String visitId)? onStartTravel;
  final VoidCallback? onOpenHandover;

  /// Collected tubes that were not handed over yet.
  final int handoverTubes;
  final bool offline;
  final DateTime? dataAsOf;
  final bool loading;

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  bool _showCancelled = false;

  List<RouteVisit> get _sorted => [...widget.visits]..sort((a, b) => a.sequence.compareTo(b.sequence));

  @override
  Widget build(BuildContext context) {
    final all = _sorted;
    final live = all.where((v) => v.status != 'cancelled').toList();
    final active = live.where((v) => !v.isClosed).toList();
    final done = live.where((v) => v.isClosed).toList();
    final cancelled = all.where((v) => v.status == 'cancelled').toList();
    final next = active.isEmpty ? null : active.first;
    final up = active.length > 1 ? active.sublist(1) : const <RouteVisit>[];
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Today · ${formatDmy(widget.routeDate)}',
        offlineBanner: !widget.offline
            ? null
            : widget.dataAsOf == null
                ? const LimsOfflineBanner()
                : LimsOfflineBanner(message: 'Offline — showing data from ${formatHm(widget.dataAsOf!)}'),
        actions: [
          PhleboNetChip(offline: widget.offline, waiting: widget.sync.waiting, onTap: widget.onOpenOutbox),
          Semantics(
            button: true,
            label: 'Help',
            child: SizedBox.square(dimension: LimsTokens.touchTargetFlutter, child: InkResponse(onTap: widget.onHelp, child: const Icon(Icons.help_outline))),
          ),
        ],
        body: RefreshIndicator(
          onRefresh: widget.onRefresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(LimsTokens.space4),
            children: [
              if (widget.purged)
                const LimsEmptyState(title: _purgedText, icon: Icons.lock_clock)
              else if (all.isEmpty && widget.loading)
                const LimsLoading()
              else if (all.isEmpty)
                const LimsEmptyState(title: _emptyText, icon: Icons.event_available_outlined)
              else ...[
                _Hero(live: live, now: widget.routeDate),
                const SizedBox(height: LimsTokens.space4),
                if (next != null)
                  _NextStop(visit: next, onOpen: widget.onOpenVisit, onStartTravel: widget.onStartTravel)
                else
                  _AllDone(done: done.length, missed: done.where((v) => v.status == 'failed').length),
                if (widget.handoverTubes > 0 && widget.onOpenHandover != null) ...[
                  const SizedBox(height: LimsTokens.space3),
                  _HandoverPrompt(tubes: widget.handoverTubes, onOpen: widget.onOpenHandover!),
                ],
                if (up.isNotEmpty) ...[
                  const SizedBox(height: LimsTokens.space3),
                  PhleboSectionTitle('Up next', trailing: '${up.length}'),
                  PhleboListCard(children: [for (final v in up) _UpRow(visit: v, onOpen: widget.onOpenVisit)]),
                ],
                if (done.isNotEmpty) ...[
                  const SizedBox(height: LimsTokens.space3),
                  PhleboSectionTitle('Completed', trailing: '${done.length}'),
                  PhleboListCard(children: [for (final v in done) _DoneRow(visit: v, onOpen: widget.onOpenVisit)]),
                ],
                if (cancelled.isNotEmpty) ...[
                  const SizedBox(height: LimsTokens.space3),
                  PhleboSectionTitle('Cancelled by the centre', trailing: '${cancelled.length}'),
                  if (_showCancelled) ...[const PhleboNotice(tone: 'info', text: _cancelledNote), const SizedBox(height: LimsTokens.space2)],
                  PhleboListCard(children: [
                    for (final v in cancelled)
                      PhleboRow(
                        leading: const Icon(Icons.block, color: LimsTokens.colorNeutral600),
                        title: v.patientName,
                        subtitle: 'Cancelled — do not visit',
                        titleColor: LimsTokens.colorNeutral600,
                        chevron: false,
                        onTap: () => setState(() => _showCancelled = true),
                      ),
                  ]),
                ],
                const SizedBox(height: LimsTokens.space2),
                TextButton(onPressed: widget.onOpenAll, child: const Text('See full list')),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.live, required this.now});

  final List<RouteVisit> live;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final done = live.where((v) => v.status == 'completed').length;
    final missed = live.where((v) => v.status == 'failed').length;
    final left = live.where((v) => !v.isClosed).length;
    final nextId = live.where((v) => !v.isClosed).map((v) => v.visitId).firstOrNull;
    final segs = [
      for (final v in live)
        switch (v.status) {
          'completed' => PhleboSegment.done,
          'failed' => PhleboSegment.missed,
          _ => v.visitId == nextId ? PhleboSegment.current : PhleboSegment.todo,
        },
    ];
    final km = live.where((v) => !v.isClosed).fold<double>(0, (a, v) => a + (v.distanceKm ?? 0));
    final span = live.isEmpty ? '' : '${live.first.windowStart} – ${live.last.windowEnd}';
    return PhleboHero(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhleboProgressRing(done: done + missed, total: live.length),
          const SizedBox(width: LimsTokens.space4),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('$done of ${live.length} collected', style: t.titleLarge?.copyWith(color: LimsTokens.colorAccentFg, fontWeight: FontWeight.w700)),
              Text(
                [if (missed > 0) '$missed missed ${missed == 1 ? 'visit' : 'visits'}', left > 0 ? '$left ${left == 1 ? 'stop' : 'stops'} to go' : 'Day complete'].join(' · '),
                style: t.bodyMedium?.copyWith(color: LimsTokens.colorAccentSubtle),
              ),
            ]),
          ),
        ]),
        const SizedBox(height: LimsTokens.space4),
        PhleboSegmentBar(segments: segs),
        const SizedBox(height: LimsTokens.space2),
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(span, style: t.labelMedium?.copyWith(color: LimsTokens.colorAccentSubtle)),
          if (km > 0) Text('${km.toStringAsFixed(1)} km to go', style: t.labelMedium?.copyWith(color: LimsTokens.colorAccentSubtle)),
        ]),
      ]),
    );
  }
}

class _NextStop extends StatelessWidget {
  const _NextStop({required this.visit, required this.onOpen, required this.onStartTravel});

  final RouteVisit visit;
  final void Function(String) onOpen;
  final void Function(String)? onStartTravel;

  @override
  Widget build(BuildContext context) {
    final v = visit;
    final t = Theme.of(context).textTheme;
    final (tone, word) = v.status == 'in_progress' ? ('info', 'In progress') : (v.onTheWay ? ('info', 'On the way') : ('neutral', 'Upcoming'));
    final canTravel = v.status == 'assigned' && !v.onTheWay && onStartTravel != null;
    final cta = canTravel ? 'On my way' : (v.status == 'in_progress' ? 'Continue visit' : 'Open visit');
    final badges = <String>[if (kindLabel(v.kind) != null) kindLabel(v.kind)!, for (final f in v.flags) if (flagLabel(f) != null && flagLabel(f) != kindLabel(v.kind)) flagLabel(f)!];
    return Card(
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(LimsTokens.radiusXl)), side: BorderSide(color: LimsTokens.colorAccentSubtle, width: LimsTokens.space0x5)),
      child: Padding(
        padding: const EdgeInsets.all(LimsTokens.space4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: PhleboEyebrow('Next stop · ${v.windowStart}')),
            LimsStatusChip(kind: 'generic', status: word, tone: tone, label: word),
          ]),
          const SizedBox(height: LimsTokens.space2),
          Semantics(
            button: true,
            label: 'Open details for ${v.patientName}',
            child: InkWell(
              onTap: () => onOpen(v.visitId),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: LimsTokens.touchTargetFlutter + LimsTokens.space4),
                child: Row(children: [
                  PhleboAvatar(name: v.patientName, size: LimsTokens.space12 + LimsTokens.space1),
                  const SizedBox(width: LimsTokens.space3),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(v.patientName, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                      Text([if (v.ageSex != null) v.ageSex!, if (v.locality != null) v.locality!].join(' · '), style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
                      if (v.distanceKm != null)
                        Text('${v.distanceKm} km${v.etaMin != null ? ' · about ${v.etaMin} min away' : ''}', style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
                    ]),
                  ),
                  const Icon(Icons.chevron_right, color: LimsTokens.colorNeutral600),
                ]),
              ),
            ),
          ),
          const SizedBox(height: LimsTokens.space2),
          Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space2, children: [
            for (final l in v.tubeLabels) PhleboTubeChip(label: l),
            if (v.fasting) const LimsStatusChip(kind: 'generic', status: 'fasting', tone: 'warning', label: 'Fasting sample'),
            for (final b in badges) LimsStatusChip(kind: 'generic', status: b, tone: kindTone(v.kind, b), label: b),
          ]),
          const SizedBox(height: LimsTokens.space4),
          SizedBox(width: double.infinity, child: LimsButton(label: cta, icon: canTravel ? Icons.navigation_outlined : null, onPressed: () => canTravel ? onStartTravel!(v.visitId) : onOpen(v.visitId))),
        ]),
      ),
    );
  }
}

class _AllDone extends StatelessWidget {
  const _AllDone({required this.done, required this.missed});

  final int done;
  final int missed;

  @override
  Widget build(BuildContext context) => LimsCard(
        child: Center(
          child: Column(children: [
            const PhleboIconTile(Icons.check_circle_outline, tone: 'success'),
            const SizedBox(height: LimsTokens.space2),
            Text('All stops done for today', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
            Text('$done collected${missed > 0 ? ' · $missed missed' : ''}. Hand the tubes to the centre.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
          ]),
        ),
      );
}

class _HandoverPrompt extends StatelessWidget {
  const _HandoverPrompt({required this.tubes, required this.onOpen});

  final int tubes;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) => LimsCard(
        child: Row(children: [
          const PhleboIconTile(Icons.inventory_2_outlined, tone: 'warning'),
          const SizedBox(width: LimsTokens.space3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('$tubes ${tubes == 1 ? 'tube' : 'tubes'} to hand over', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
              Text('Give them to the centre staff.', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
            ]),
          ),
          LimsButton(label: 'Hand over', secondary: true, onPressed: onOpen),
        ]),
      );
}

class _UpRow extends StatelessWidget {
  const _UpRow({required this.visit, required this.onOpen});

  final RouteVisit visit;
  final void Function(String) onOpen;

  @override
  Widget build(BuildContext context) {
    final v = visit;
    final t = Theme.of(context).textTheme;
    final extra = kindLabel(v.kind);
    return PhleboRow(
      semanticLabel: 'Visit ${v.sequence}, ${v.patientName}, ${v.windowStart} to ${v.windowEnd}',
      onTap: () => onOpen(v.visitId),
      leading: SizedBox(
        width: LimsTokens.space12 + LimsTokens.space2,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(v.windowStart, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          Text('–${v.windowEnd}', style: t.labelSmall?.copyWith(color: LimsTokens.colorNeutral600)),
        ]),
      ),
      title: v.patientName,
      subtitle: [if (v.locality != null) v.locality!, if (v.distanceKm != null) '${v.distanceKm} km', '${v.expectedTubes} ${v.expectedTubes == 1 ? 'tube' : 'tubes'}'].join(' · '),
      trailing: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
        if (v.fasting) const LimsStatusChip(kind: 'generic', status: 'fasting', tone: 'warning', label: 'Fasting'),
        if (extra != null) LimsStatusChip(kind: 'generic', status: extra, tone: kindTone(v.kind, extra), label: extra),
      ]),
    );
  }
}

class _DoneRow extends StatelessWidget {
  const _DoneRow({required this.visit, required this.onOpen});

  final RouteVisit visit;
  final void Function(String) onOpen;

  @override
  Widget build(BuildContext context) {
    final v = visit;
    final failed = v.status == 'failed';
    final partial = !failed && v.collectedTubes < v.expectedTubes;
    final (tone, word, icon) = failed ? ('danger', 'Missed', Icons.cancel_outlined) : (partial ? ('warning', 'Partly collected', Icons.warning_amber_rounded) : ('success', 'Collected', Icons.check_circle_outline));
    return PhleboRow(
      onTap: () => onOpen(v.visitId),
      leading: Icon(icon, color: limsTone(tone).fg),
      title: v.patientName,
      subtitle: '${v.windowStart}–${v.windowEnd} · ${v.collectedTubes}/${v.expectedTubes} tubes',
      trailing: LimsStatusChip(kind: 'generic', status: word, tone: tone, label: word),
    );
  }
}
