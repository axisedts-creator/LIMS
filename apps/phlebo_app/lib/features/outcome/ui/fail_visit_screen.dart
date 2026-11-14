// HC-T26 M9 Fail visit (US-07-2/3; 04-UI-UX §3.9; TRD §6.3 visit.failed). LD-140 (2026-11-13): lims_ui + tokens only.
// Reasons come from config (visit_fail_reasons); M4/M5 open this with identity_mismatch / patient_refused preselected.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../visit/data/mutation_sink.dart';
import '../../visit/domain/visit_models.dart';
import '../../visit/ui/save_once.dart';

class FailVisitScreen extends StatefulWidget {
  const FailVisitScreen({
    super.key,
    required this.visit,
    required this.config,
    required this.sink,
    required this.readGps,
    required this.onFailed,
    this.preselectedReasonCode,
  });

  final VisitView visit;
  final VisitConfig config;
  final MutationSink sink;
  final Future<Map<String, Object?>> Function() readGps;
  final String? preselectedReasonCode;
  final VoidCallback onFailed;

  @override
  State<FailVisitScreen> createState() => _FailVisitScreenState();
}

class _FailVisitScreenState extends State<FailVisitScreen> with SaveOnce<FailVisitScreen> {
  final _text = TextEditingController();
  late ReasonOption? _picked = widget.config.visitFailReasons.where((r) => r.code == widget.preselectedReasonCode).firstOrNull;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _valid => _picked != null && (!_picked!.requiresText || _text.text.trim().isNotEmpty);

  Future<void> _fail() async {
    final reason = _picked;
    if (reason == null || !_valid) return;
    final text = _text.text.trim();
    final ok = await runSave(() async {
      final gps = await widget.readGps();
      return widget.sink.enqueue(
        type: 'visit.failed',
        visitId: widget.visit.visitId,
        visitLabel: widget.visit.label,
        payload: {
          'reason_code': reason.code,
          if (text.isNotEmpty) 'reason_text': text.length > 200 ? text.substring(0, 200) : text,
          'gps': gps,
        },
      );
    });
    if (ok) widget.onFailed();
  }

  @override
  Widget build(BuildContext context) {
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Why can the visit not be done?',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          for (final r in widget.config.visitFailReasons)
            ChoiceTile(title: r.display, selected: _picked == r, onTap: saving ? null : () => setState(() => _picked = r)),
          const SizedBox(height: LimsTokens.space3),
          LimsTextField(
            key: const ValueKey('fail.reason_text'),
            label: _picked?.requiresText == true ? 'Details (required)' : 'Details (optional)',
            maxLength: 200,
            controller: _text,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: LimsTokens.space4),
          saveErrorNotice(),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: 'Fail visit', onPressed: _valid && !saving ? _fail : null),
        ]),
      ),
    );
  }
}
