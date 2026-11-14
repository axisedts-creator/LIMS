// HC-T26 M4 Identity check (US-07-2; 04-UI-UX §3.4; REQ-SEC-111). LD-140 (2026-11-13): lims_ui widgets + tokens only.
// The spoken answers are never typed in: the phlebotomist only records "matches" / "doesn't match", so no PHI reaches the payload.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../visit/data/mutation_sink.dart';
import '../../visit/domain/visit_models.dart';
import '../../visit/ui/save_once.dart';

class IdentityScreen extends StatefulWidget {
  const IdentityScreen({
    super.key,
    required this.visit,
    required this.sink,
    required this.onContinue,
    required this.onFail,
    this.onBack,
  });

  final VisitView visit;
  final MutationSink sink;
  final VoidCallback onContinue;

  /// Called with the M9 reason code to preselect ('identity_mismatch').
  final ValueChanged<String> onFail;
  final VoidCallback? onBack;

  @override
  State<IdentityScreen> createState() => _IdentityScreenState();
}

class _IdentityScreenState extends State<IdentityScreen> with SaveOnce<IdentityScreen> {
  bool? _nameMatches;
  bool? _secondMatches;
  bool _mismatchRecorded = false; // the mismatch is evidence: recorded once, then only "Fail visit" or "Back"

  bool get _isDob => widget.visit.secondIdentifier == 'birth_date';

  Future<void> _continue() async {
    final name = _nameMatches;
    final second = _secondMatches;
    if (name == null || second == null) return;
    final mismatch = !name || !second;
    if (!_mismatchRecorded) {
      final ok = await runSave(() => widget.sink.enqueue(
            type: 'visit.identity_checked',
            visitId: widget.visit.visitId,
            visitLabel: widget.visit.label,
            payload: {
              'name_check': name ? 'matches' : 'mismatch',
              'second_identifier': widget.visit.secondIdentifier,
              'second_check': second ? 'matches' : 'mismatch',
            },
          ));
      if (!ok || !mounted) return;
      setState(() => _mismatchRecorded = mismatch);
    }
    if (!mismatch) {
      widget.onContinue();
      return;
    }
    final choice = await LimsConfirmDialog.show(
      context,
      title: 'Identity check',
      message: "Identity doesn't match. You can't collect samples for this visit.",
      confirmLabel: 'Fail visit',
      cancelLabel: 'Back',
    );
    if (!mounted) return;
    if (choice == null) {
      widget.onBack?.call();
    } else {
      widget.onFail('identity_mismatch');
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.visit;
    final what = _isDob ? 'date of birth' : 'phone number';
    final short = _isDob ? 'DOB' : 'Phone';
    final ready = _nameMatches != null && _secondMatches != null;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Identity check',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          Text("Ask the patient to tell you their full name and $what. Don't read them out."),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Recorded for this visit',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Name: ${v.patientName}'),
              Text(_isDob ? 'Date of birth: ${v.birthDate}' : 'Phone: ${v.phone}'),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          ChoiceTile(title: 'Name matches', selected: _nameMatches == true, onTap: _lock(() => _nameMatches = true)),
          ChoiceTile(title: "Name doesn't match", selected: _nameMatches == false, onTap: _lock(() => _nameMatches = false)),
          const SizedBox(height: LimsTokens.space2),
          ChoiceTile(title: '$short matches', selected: _secondMatches == true, onTap: _lock(() => _secondMatches = true)),
          ChoiceTile(title: "$short doesn't match", selected: _secondMatches == false, onTap: _lock(() => _secondMatches = false)),
          const SizedBox(height: LimsTokens.space4),
          saveErrorNotice(),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: 'Continue', onPressed: ready && !saving ? _continue : null),
        ]),
      ),
    );
  }

  /// Choices are frozen once the mismatch is recorded (the answer on file is the answer).
  VoidCallback? _lock(VoidCallback pick) => _mismatchRecorded || saving ? null : () => setState(pick);
}
