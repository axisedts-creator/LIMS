// Six-step progress of a visit (board M5 `st.n / st.label`): Arrive, Identity, Consent, Collect, Payment, Done.
// Shown above the content of each step screen; purely informational, the guard (VisitGuard) decides what is reachable.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../features/visit/domain/visit_guard.dart';

const _steps = <(VisitStep, String)>[
  (VisitStep.arrive, 'Arrive'),
  (VisitStep.identity, 'Identity'),
  (VisitStep.consent, 'Consent'),
  (VisitStep.collect, 'Collect'),
  (VisitStep.payment, 'Payment'),
  (VisitStep.complete, 'Finish'),
];

class VisitStepper extends StatelessWidget {
  const VisitStepper({super.key, required this.current});

  final VisitStep current;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    // The fail step is a branch, not a position: it shows the steps as they were (none highlighted).
    final idx = _steps.indexWhere((s) => s.$1 == current);
    final label = idx < 0 ? 'Visit not done' : 'Step ${idx + 1} of ${_steps.length} · ${_steps[idx].$2}';
    return Semantics(
      container: true,
      label: label,
      excludeSemantics: true,
      child: Column(children: [
        Row(children: [
          for (var i = 0; i < _steps.length; i++) ...[
            if (i > 0) Expanded(child: Container(height: LimsTokens.space0x5, color: i <= idx ? LimsTokens.colorAccentDefault : LimsTokens.colorToneNeutralBorder)),
            Container(
              width: LimsTokens.space6,
              height: LimsTokens.space6,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: i < idx ? LimsTokens.colorAccentDefault : (i == idx ? LimsTokens.colorAccentHighlight : LimsTokens.colorNeutral0),
                border: Border.all(color: i <= idx ? LimsTokens.colorAccentDefault : LimsTokens.colorNeutral300),
              ),
              child: i < idx
                  ? const Icon(Icons.check, size: LimsTokens.fontSizeBaseSize, color: LimsTokens.colorAccentFg)
                  : Text('${i + 1}', style: t.labelSmall?.copyWith(color: i == idx ? LimsTokens.colorNeutral900 : LimsTokens.colorNeutral600, fontWeight: FontWeight.w700)),
            ),
          ],
        ]),
        const SizedBox(height: LimsTokens.space1),
        Text(label, style: t.labelMedium?.copyWith(color: LimsTokens.colorNeutral600)),
      ]),
    );
  }
}
