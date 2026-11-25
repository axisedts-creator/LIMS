// Help & support hub (the "?" of the Today header and the Profile row open it). Three places: FAQs, contact dispatch, report a problem.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';

class HelpScreen extends StatelessWidget {
  const HelpScreen({super.key, required this.onOpenFaqs, required this.onOpenContact, required this.onOpenReport});

  final VoidCallback onOpenFaqs;
  final VoidCallback onOpenContact;
  final VoidCallback onOpenReport;

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: LimsScaffold(
          title: 'Help & support',
          body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
            const PhleboNotice(tone: 'info', title: 'Stuck at a door?', text: 'Call dispatch first. They can reach the patient and reschedule.'),
            const SizedBox(height: LimsTokens.space3),
            PhleboListCard(children: [
              PhleboRow(leading: const PhleboIconTile(Icons.quiz_outlined), title: 'FAQs', subtitle: 'Answers that work offline', onTap: onOpenFaqs),
              PhleboRow(leading: const PhleboIconTile(Icons.support_agent), title: 'Contact dispatch', subtitle: 'Call or message the centre', onTap: onOpenContact),
              PhleboRow(leading: const PhleboIconTile(Icons.flag_outlined), title: 'Report a problem', subtitle: 'Tell the centre what went wrong', onTap: onOpenReport),
            ]),
          ]),
        ),
      );
}
