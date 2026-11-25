// Receipt of a handover: what was given, to whom, and where the centre is with it. Opened after "Hand over" and from the
// handover prompt when a handover is still waiting. Display only.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../../outbox/domain/time_labels.dart';
import '../domain/handover_status.dart';

class HandoverReceiptScreen extends StatelessWidget {
  const HandoverReceiptScreen({super.key, required this.receipt, required this.onDone, this.onContactDispatch});

  final HandoverReceipt receipt;
  final VoidCallback onDone;
  final VoidCallback? onContactDispatch;

  @override
  Widget build(BuildContext context) {
    final r = receipt;
    final t = Theme.of(context).textTheme;
    final (tone, icon, title, text) = switch (r.status) {
      HandoverStatus.pending => ('warning', Icons.hourglass_top, 'Waiting for the centre', 'Centre staff scan each tube to confirm. Keep the tubes cool and together until they do.'),
      HandoverStatus.confirmed => ('success', Icons.verified_outlined, 'Handover confirmed', 'The centre received every tube. You are done with these samples.'),
      HandoverStatus.discrepancy => (
          'danger',
          Icons.report_problem_outlined,
          '${r.missingCount} ${r.missingCount == 1 ? 'tube was' : 'tubes were'} not found',
          'The centre could not find ${r.missingCount == 1 ? 'one tube' : '${r.missingCount} tubes'}. Dispatch has been told. Check your bag and call dispatch.',
        ),
    };
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Handover receipt',
        bottomNavigationBar: PhleboActionBar(children: [
          LimsButton(label: 'Done', onPressed: onDone),
          if (r.status == HandoverStatus.discrepancy && onContactDispatch != null) LimsButton(label: 'Call dispatch', icon: Icons.call_outlined, secondary: true, onPressed: onContactDispatch),
        ]),
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          PhleboNotice(tone: tone, icon: icon, title: title, text: text),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Handed over to',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(r.centreName, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
              Text('${formatDmy(r.handedOverAt)} at ${formatHm(r.handedOverAt)}', style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: '${r.tubes.length} ${r.tubes.length == 1 ? 'tube' : 'tubes'}',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final s in r.tubes)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
                  child: Row(children: [
                    Icon(Icons.science_outlined, size: LimsTokens.space5, color: LimsTokens.colorAccentDefault),
                    const SizedBox(width: LimsTokens.space2),
                    Expanded(child: Text(s)),
                  ]),
                ),
            ]),
          ),
        ]),
      ),
    );
  }
}
