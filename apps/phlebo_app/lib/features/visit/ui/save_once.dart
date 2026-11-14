// HC-T26 shared UI helpers for the visit-flow screens (LD-140: lims_ui tokens only).
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

const saveFailedText = "Couldn't save. Try again.";

/// "Persist first, then move on": a second tap while a save is pending is ignored, and a failed save keeps the user on
/// the screen with an error (nothing is lost silently, nothing is shown as done).
mixin SaveOnce<T extends StatefulWidget> on State<T> {
  bool _saving = false;
  String? saveError;

  bool get saving => _saving;

  /// True when [action] completed. False when another save is pending, or when [action] threw (saveError is then set).
  Future<bool> runSave(Future<Object?> Function() action) async {
    if (_saving) return false;
    setState(() {
      _saving = true;
      saveError = null;
    });
    try {
      await action();
    } catch (_) {
      if (mounted) {
        setState(() {
          _saving = false;
          saveError = saveFailedText;
        });
      }
      return false;
    }
    if (mounted) setState(() => _saving = false);
    return true;
  }

  Widget saveErrorNotice() => saveError == null ? const SizedBox.shrink() : InlineNotice(tone: 'danger', text: saveError!);
}

/// A status line: tone, icon AND words (never colour alone, 10-DESIGN-SYSTEM §6).
class InlineNotice extends StatelessWidget {
  const InlineNotice({super.key, required this.tone, required this.text});

  final String tone;
  final String text;

  static IconData _icon(String tone) => switch (tone) {
        'success' => Icons.check_circle_outline,
        'warning' => Icons.warning_amber_outlined,
        'info' => Icons.info_outline,
        _ => Icons.error_outline,
      };

  @override
  Widget build(BuildContext context) {
    final c = limsTone(tone);
    return Semantics(
      liveRegion: true,
      container: true,
      child: Container(
        width: double.infinity,
        color: c.bg,
        padding: const EdgeInsets.all(LimsTokens.space3),
        child: Row(children: [
          Icon(_icon(tone), color: c.fg),
          const SizedBox(width: LimsTokens.space2),
          Expanded(child: Text(text, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: c.fg))),
        ]),
      ),
    );
  }
}

/// A labelled fact row (label above value) used by the read-only sections.
class FactRow extends StatelessWidget {
  const FactRow({super.key, required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: t.labelMedium),
        Text(value, style: t.bodyLarge),
      ]),
    );
  }
}

/// Radio-style single choice built from LimsListTile (04-UI-UX §3.4/§3.7).
class ChoiceTile extends StatelessWidget {
  const ChoiceTile({super.key, required this.title, required this.selected, required this.onTap});

  final String title;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => LimsListTile(
        title: title,
        leading: Icon(selected ? Icons.radio_button_checked : Icons.radio_button_unchecked),
        onTap: onTap,
      );
}
