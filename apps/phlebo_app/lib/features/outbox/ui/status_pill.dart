// HC-T27 shared bits (LD-140): a status always shows tone, icon AND words; lims_ui + tokens only.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../domain/sync_summary.dart';
import '../domain/time_labels.dart';

/// Icon + `LimsStatusChip` (tone and word come from the chip, the icon repeats the tone's meaning).
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.tone, required this.icon, required this.label});

  final String tone;
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: LimsTokens.space4, color: limsTone(tone).fg),
        const SizedBox(width: LimsTokens.space1),
        Flexible(child: LimsStatusChip(kind: 'generic', status: label, tone: tone, label: label)),
      ]);
}

/// "{n} waiting · Last upload hh:mm" (04-UI-UX §3.2 / §3.11).
class SyncChip extends StatelessWidget {
  const SyncChip({super.key, required this.sync});

  final SyncSummary sync;

  @override
  Widget build(BuildContext context) {
    final last = sync.lastUpload;
    final waiting = sync.waiting > 0;
    return Align(
      alignment: Alignment.centerLeft,
      child: StatusPill(
        tone: waiting ? 'warning' : 'success',
        icon: waiting ? Icons.schedule : Icons.cloud_done_outlined,
        label: '${sync.waiting} waiting · Last upload ${last == null ? '—' : formatHm(last)}',
      ),
    );
  }
}
