// HC-T27 M11 Outbox (04-UI-UX §3.11). LD-140 (2026-11-13): lims_ui + tokens only. No patient names: a row shows the visit
// label (sequence + window), the time and the state. Rows come from OutboxRepository.listRows() via the app shell.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../visit/ui/save_once.dart' show InlineNotice;
import '../domain/outbox_row.dart';
import '../domain/sync_summary.dart';
import '../domain/time_labels.dart';
import 'status_pill.dart';

const _typeLabels = <String, String>{
  'visit.arrived': 'Arrived',
  'visit.identity_checked': 'ID check',
  'visit.consent_recorded': 'Consent',
  'specimen.collected': 'Tube collected',
  'specimen.not_collected': 'Tube not collected',
  'payment.captured': 'Payment',
  'visit.completed': 'Visit finished',
  'visit.failed': 'Visit failed',
  'handover.recorded': 'Handover',
};
const _reviewNote = 'The centre will review this. Your record is saved.';
const _uploadFailed = "Couldn't upload. Your records stay on this phone and will try again.";

(String, String, IconData) _state(OutboxRow r) => switch (r.state) {
      'pending' => ('neutral', 'Waiting', Icons.schedule),
      'sending' => ('info', 'Uploading', Icons.cloud_upload_outlined),
      'applied' || 'duplicate' => ('success', 'Uploaded', Icons.check_circle_outline),
      'held' => ('warning', 'On hold at centre', Icons.pause_circle_outline),
      'rejected' => ('danger', r.outcomeCode == null ? 'Not accepted' : 'Not accepted: ${r.outcomeCode}', Icons.error_outline),
      _ => ('neutral', r.state, Icons.help_outline_rounded),
    };

class OutboxScreen extends StatefulWidget {
  const OutboxScreen({super.key, required this.rows, required this.sync, required this.onUploadNow});

  final List<OutboxRow> rows;
  final SyncSummary sync;
  final Future<void> Function() onUploadNow;

  @override
  State<OutboxScreen> createState() => _OutboxScreenState();
}

class _OutboxScreenState extends State<OutboxScreen> {
  bool _uploading = false;
  String? _error;

  Future<void> _upload() async {
    if (_uploading) return;
    setState(() {
      _uploading = true;
      _error = null;
    });
    try {
      await widget.onUploadNow();
    } catch (_) {
      if (mounted) _error = _uploadFailed;
    }
    if (mounted) setState(() => _uploading = false);
  }

  Widget _row(BuildContext context, OutboxRow r) {
    final (tone, word, icon) = _state(r);
    final t = Theme.of(context).textTheme;
    final review = r.state == 'held' || r.state == 'rejected';
    final when = formatHm(r.capturedAt);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      LimsListTile(
        title: _typeLabels[r.type] ?? r.type,
        subtitle: r.visitLabel == null ? when : '${r.visitLabel} · $when',
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(LimsTokens.space4, 0, LimsTokens.space4, LimsTokens.space2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          StatusPill(tone: tone, icon: icon, label: word),
          if (review) Text(_reviewNote, style: t.bodySmall),
        ]),
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: LimsScaffold(
          title: 'Outbox',
          syncStatus: SyncChip(sync: widget.sync),
          bottomNavigationBar: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(LimsTokens.space4),
              child: LimsButton(label: 'Upload now', onPressed: _uploading ? null : _upload),
            ),
          ),
          body: ListView(children: [
            if (_error != null) InlineNotice(tone: 'danger', text: _error!),
            if (widget.rows.isEmpty)
              const LimsEmptyState(title: 'Everything is uploaded.')
            else
              for (final r in widget.rows) _row(context, r),
          ]),
        ),
      );
}
