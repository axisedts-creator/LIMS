// PHLEBO-UI-FULL-1 D01b. LD-140: lims_ui + tokens only. Barcodes show their last 4 characters only. The centre's
// confirmation cannot be read by the sender yet (no contract), so the page never claims it was received.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../app/theme.dart';
import '../../outbox/domain/time_labels.dart';
import '../domain/handover_models.dart';

class HandoverReceiptScreen extends StatelessWidget {
  const HandoverReceiptScreen({super.key, required this.centreName, required this.at, required this.tubes, required this.onDone});

  final String centreName;
  final DateTime at;
  final List<HandoverTube> tubes;
  final VoidCallback onDone;

  String _last4(String b) => '…${b.length > 4 ? b.substring(b.length - 4) : b}';

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: LimsScaffold(
          title: 'Handover receipt',
          bottomNavigationBar: BottomActions(children: [LimsButton(label: 'Done', onPressed: onDone)]),
          body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
            const NoticeCard(
              tone: 'warning',
              icon: Icons.hourglass_empty,
              title: 'Waiting for the centre',
              text: 'Centre staff scan each tube to confirm. Keep the tubes cool and together until they do. '
                  'Their confirmation does not show on this phone.',
            ),
            const SizedBox(height: LimsTokens.space3),
            LimsCard(title: 'Handed over to', child: Text('$centreName\n${formatDmy(at)} at ${formatHm(at)}')),
            const SizedBox(height: LimsTokens.space3),
            LimsCard(
              title: '${tubes.length} ${tubes.length == 1 ? 'tube' : 'tubes'}',
              child: Column(children: [
                for (final t in tubes)
                  LimsListTile(leading: const Icon(Icons.science_outlined), title: '${t.typeDisplay} · ${_last4(t.barcode)}'),
              ]),
            ),
          ]),
        ),
      );
}
