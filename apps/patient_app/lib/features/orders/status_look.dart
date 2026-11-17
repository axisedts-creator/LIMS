// M4 status look for A10, A11, A12, A15 (10-DESIGN-SYSTEM 2.6, LD-140): a status is words + an icon + a tone, never colour alone.
// One icon per tone (the A14 icons where the tone is the same). LimsStatusChip has no icon slot, so the icon sits next to it in the same Row.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

const _toneIcons = <String, IconData>{
  'neutral': Icons.radio_button_unchecked,
  'info': Icons.schedule,
  'warning': Icons.info_outline,
  'success': Icons.check_circle_outline,
  'danger': Icons.warning_amber_outlined,
  'critical': Icons.error_outline,
};

/// An empty / error / result state on a white card (M4: no content loose on the page). Scrolls, so text scale 1.3 never overflows.
class StateCard extends StatelessWidget {
  const StateCard(this.child, {super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [LimsCard(child: SizedBox(width: double.infinity, child: child))]);
}

/// [chip] with the icon of its tone in front.
class ToneChip extends StatelessWidget {
  const ToneChip(this.chip, {super.key});

  final LimsStatusChip chip;

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(_toneIcons[chip.tone] ?? _toneIcons['neutral'], size: LimsTokens.space4, color: limsTone(chip.tone).fg),
      const SizedBox(width: LimsTokens.space1),
      Flexible(child: chip),
    ]);
  }
}
