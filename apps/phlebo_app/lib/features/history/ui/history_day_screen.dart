// One past working day: totals, then every visit with its outcome. The visit label here is a name because the phone
// already holds it; nothing on this screen is written to a mutation.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/date_labels.dart';
import '../../../ui/phlebo_kit.dart';
import '../domain/history_models.dart';

class HistoryDayScreen extends StatelessWidget {
  const HistoryDayScreen({super.key, required this.day, this.allSynced = true});

  final HistoryDay day;

  /// false: some of this day's changes still wait in the outbox.
  final bool allSynced;

  (String, String, IconData) _chip(String status) => switch (status) {
        'collected' => ('success', 'Collected', Icons.check_circle_outline),
        'partial' => ('warning', 'Partly collected', Icons.warning_amber_rounded),
        'missed' => ('danger', 'Missed', Icons.cancel_outlined),
        _ => ('neutral', status, Icons.help_outline),
      };

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: longDay(day.date),
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          Row(children: [
            Expanded(child: PhleboStat(value: '${day.collected}', label: 'Collected', tone: 'success')),
            const SizedBox(width: LimsTokens.space2),
            Expanded(child: PhleboStat(value: '${day.missed}', label: 'Missed', tone: day.missed > 0 ? 'danger' : null)),
          ]),
          const SizedBox(height: LimsTokens.space3),
          PhleboNotice(
            tone: allSynced ? 'success' : 'warning',
            icon: allSynced ? Icons.cloud_done_outlined : Icons.schedule,
            text: allSynced ? 'All synced. The centre has every visit of this day.' : 'Some changes of this day are still waiting to upload.',
          ),
          const SizedBox(height: LimsTokens.space3),
          const PhleboSectionTitle('Visits'),
          if (day.rows.isEmpty)
            const LimsEmptyState(title: 'No visits on this day.')
          else
            PhleboListCard(children: [
              for (final r in day.rows)
                Builder(builder: (context) {
                  final (tone, word, icon) = _chip(r.status);
                  return Padding(
                    padding: const EdgeInsets.all(LimsTokens.space4),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      PhleboAvatar(name: r.name),
                      const SizedBox(width: LimsTokens.space3),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(r.name, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                          Text('${r.time} · ${r.locality}', style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
                          Text(r.summary, style: t.bodySmall),
                          if (r.reason != null) Text(r.reason!, style: t.bodySmall?.copyWith(color: limsTone('danger').fg)),
                        ]),
                      ),
                      const SizedBox(width: LimsTokens.space2),
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(icon, size: LimsTokens.space4, color: limsTone(tone).fg),
                        const SizedBox(width: LimsTokens.space1),
                        LimsStatusChip(kind: 'generic', status: word, tone: tone, label: word),
                      ]),
                    ]),
                  );
                }),
            ]),
        ]),
      ),
    );
  }
}
