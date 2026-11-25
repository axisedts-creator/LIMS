// Report a problem (patient pack S50 / S50a submitted / S50b send failed). The text is free but the screen warns against
// patient details, and never copies the visit's patient data into the report.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';

enum ReportResult { sent, savedOnPhone, failed }

const reportCategories = <String>['Visit or address', 'Tubes or barcodes', 'Payment', 'App or sync', 'Something else'];

class ReportProblemScreen extends StatefulWidget {
  const ReportProblemScreen({super.key, required this.onSubmit, this.offline = false});

  /// category, description. `savedOnPhone` = queued, will go when online.
  final Future<ReportResult> Function(String category, String description) onSubmit;
  final bool offline;

  @override
  State<ReportProblemScreen> createState() => _ReportProblemScreenState();
}

class _ReportProblemScreenState extends State<ReportProblemScreen> {
  final _text = TextEditingController();
  String? _category;
  bool _busy = false;
  ReportResult? _result;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _ready => _category != null && _text.text.trim().length >= 5 && !_busy;

  Future<void> _send() async {
    if (!_ready) return;
    setState(() => _busy = true);
    ReportResult r;
    try {
      r = await widget.onSubmit(_category!, _text.text.trim());
    } catch (_) {
      r = ReportResult.failed;
    }
    if (mounted) {
      setState(() {
        _busy = false;
        _result = r;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final done = _result == ReportResult.sent || _result == ReportResult.savedOnPhone;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Report a problem',
        offlineBanner: widget.offline ? const LimsOfflineBanner(message: 'Offline. Your report is saved on this phone and sent later.') : null,
        body: done ? _doneBody() : _formBody(),
      ),
    );
  }

  Widget _doneBody() {
    final sent = _result == ReportResult.sent;
    return Padding(
      padding: const EdgeInsets.all(LimsTokens.space4),
      child: Column(children: [
        const Spacer(),
        PhleboNotice(
          tone: sent ? 'success' : 'warning',
          title: sent ? 'Report sent' : 'Saved on this phone',
          text: sent ? 'The centre has your report. Thank you.' : 'It will be sent when the phone is back online.',
        ),
        const Spacer(),
        SizedBox(width: double.infinity, child: LimsButton(label: 'Done', onPressed: () => Navigator.of(context).maybePop())),
      ]),
    );
  }

  Widget _formBody() {
    final t = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
      if (_result == ReportResult.failed) ...[
        const PhleboNotice(tone: 'danger', title: "Couldn't send", text: 'Your text is still here. Check the connection and try again.'),
        const SizedBox(height: LimsTokens.space3),
      ],
      Text('What is it about?', style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
      const SizedBox(height: LimsTokens.space2),
      Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space2, children: [
        for (final c in reportCategories)
          ChoiceChip(
            label: Text(c),
            selected: _category == c,
            showCheckmark: false,
            selectedColor: LimsTokens.colorAccentHighlight,
            labelStyle: TextStyle(color: LimsTokens.colorNeutral900, fontWeight: _category == c ? FontWeight.w700 : FontWeight.w500),
            materialTapTargetSize: MaterialTapTargetSize.padded,
            onSelected: (_) => setState(() => _category = c),
          ),
      ]),
      const SizedBox(height: LimsTokens.space4),
      TextField(
        key: const ValueKey('report.text'),
        controller: _text,
        maxLength: 500,
        maxLines: 5,
        enableSuggestions: false,
        autocorrect: false,
        onChanged: (_) => setState(() {}),
        decoration: const InputDecoration(labelText: 'Describe what happened', alignLabelWithHint: true, helperText: "Don't write patient names, test names or results.", helperMaxLines: 2),
      ),
      const SizedBox(height: LimsTokens.space4),
      LimsButton(label: _busy ? 'Sending…' : 'Send report', onPressed: _ready ? _send : null),
    ]);
  }
}
