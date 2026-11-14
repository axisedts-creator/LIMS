// HC-T26 M5 Consent (US-07-3; 04-UI-UX §3.5). LD-140 (2026-11-13): lims_ui widgets + tokens only, one primary button.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../visit/data/mutation_sink.dart';
import '../../visit/domain/visit_models.dart';
import '../../visit/ui/save_once.dart';

class ConsentScreen extends StatefulWidget {
  const ConsentScreen({
    super.key,
    required this.visit,
    required this.config,
    required this.sink,
    required this.onAgreed,
    required this.onRefused,
  });

  final VisitView visit;
  final VisitConfig config;
  final MutationSink sink;
  final VoidCallback onAgreed;
  final VoidCallback onRefused;

  @override
  State<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends State<ConsentScreen> with SaveOnce<ConsentScreen> {
  Future<void> _record(bool given) async {
    final ok = await runSave(() => widget.sink.enqueue(
          type: 'visit.consent_recorded',
          visitId: widget.visit.visitId,
          visitLabel: widget.visit.label,
          payload: {'consent_text_version': widget.config.consentTextVersion, 'given': given},
        ));
    if (!ok) return;
    given ? widget.onAgreed() : widget.onRefused();
  }

  @override
  Widget build(BuildContext context) {
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Consent',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          Text(widget.config.consentText),
          const SizedBox(height: LimsTokens.space3),
          Text(widget.config.consentTextVersion, style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: LimsTokens.space4),
          saveErrorNotice(),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: 'Patient agrees', onPressed: saving ? null : () => _record(true)),
          const SizedBox(height: LimsTokens.space2),
          LimsButton(label: 'Patient refuses', secondary: true, onPressed: saving ? null : () => _record(false)),
        ]),
      ),
    );
  }
}
