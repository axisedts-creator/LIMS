// A13 "smart tab" hook (03-APP-FLOW §11 A14: tab hidden when none). Renders nothing and calls nothing when no summary is available; A14 fetches on open.
import 'package:flutter/material.dart';

import 'smart_summary_screen.dart';

class SmartSummaryEntry extends StatelessWidget {
  const SmartSummaryEntry({super.key, required this.reportId, required this.versionNo, required this.smartSummaryAvailable, this.superseded = false});

  final String reportId;
  final int versionNo;
  final bool smartSummaryAvailable;
  final bool superseded;

  @override
  Widget build(BuildContext context) {
    if (!smartSummaryAvailable) return const SizedBox.shrink();
    return ListTile(
      leading: const Icon(Icons.insights_outlined),
      title: const Text('Smart summary'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => SmartSummaryScreen(reportId: reportId, versionNo: versionNo, superseded: superseded),
      )),
    );
  }
}
