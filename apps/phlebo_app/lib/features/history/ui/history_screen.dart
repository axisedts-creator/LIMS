// History tab (board M5 "History"): totals for the days kept on the phone, then one row per working day.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/date_labels.dart';
import '../../../ui/phlebo_kit.dart';
import '../../outbox/ui/status_pill.dart' show SyncChip;
import '../../outbox/domain/sync_summary.dart';
import '../domain/history_models.dart';

class HistoryScreen extends StatelessWidget {
  const HistoryScreen({super.key, required this.days, required this.onOpenDay, this.offline = false, this.sync});

  final List<HistoryDay> days;
  final ValueChanged<HistoryDay> onOpenDay;
  final bool offline;
  final SyncSummary? sync;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final sorted = [...days]..sort((a, b) => b.date.compareTo(a.date));
    final collected = sorted.fold<int>(0, (a, d) => a + d.collected);
    final missed = sorted.fold<int>(0, (a, d) => a + d.missed);
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'History',
        offlineBanner: offline ? const LimsOfflineBanner() : null,
        syncStatus: sync == null ? null : SyncChip(sync: sync!),
        body: sorted.isEmpty
            ? const LimsEmptyState(title: 'No past visits on this phone yet.', message: 'Finished working days appear here.', icon: Icons.history)
            : ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
                PhleboSectionTitle('Last ${sorted.length} working ${sorted.length == 1 ? 'day' : 'days'}'),
                Row(children: [
                  Expanded(child: PhleboStat(value: '$collected', label: 'Collected', tone: 'success')),
                  const SizedBox(width: LimsTokens.space2),
                  Expanded(child: PhleboStat(value: '$missed', label: 'Missed', tone: missed > 0 ? 'danger' : null)),
                  const SizedBox(width: LimsTokens.space2),
                  Expanded(child: PhleboStat(value: '${successPercent(sorted)}%', label: 'Success rate')),
                ]),
                const SizedBox(height: LimsTokens.space3),
                const PhleboSectionTitle('Past working days'),
                PhleboListCard(children: [
                  for (final d in sorted)
                    PhleboRow(
                      semanticLabel: '${longDay(d.date)}, ${d.collected} collected, ${d.missed} missed',
                      leading: _DateTile(d.date),
                      title: longDay(d.date),
                      subtitle: '${d.collected} collected · ${d.missed} missed',
                      onTap: () => onOpenDay(d),
                    ),
                ]),
                const SizedBox(height: LimsTokens.space3),
                Text('Only finished days kept on this phone are listed.', style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600), textAlign: TextAlign.center),
              ]),
      ),
    );
  }
}

class _DateTile extends StatelessWidget {
  const _DateTile(this.date);

  final DateTime date;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Container(
      width: LimsTokens.space12,
      padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
      decoration: const BoxDecoration(color: LimsTokens.colorAccentSubtle, borderRadius: BorderRadius.all(Radius.circular(LimsTokens.radiusMd))),
      child: Column(children: [
        Text(weekdayShort(date), style: t.labelSmall?.copyWith(color: LimsTokens.colorAccentDefault, fontWeight: FontWeight.w600)),
        Text('${date.day}', style: t.titleMedium?.copyWith(color: LimsTokens.colorNeutral900, fontWeight: FontWeight.w700)),
      ]),
    );
  }
}
